/**
 * Getting the agent's voice back after the network changes under a call.
 * Internal; `attachTrackChangedHandler()` installs it, so the factory and an
 * app that built its own transport both get it.
 *
 * When the path a call runs on dies — a phone leaving Wi-Fi for cellular is
 * the everyday case — `SmallWebRTCTransport` builds a new peer connection,
 * negotiates it, and closes the old one. Two things in the stock transport
 * (1.10.6 through 1.10.8) make that worse than it needs to be, and this module
 * fixes both on the transport instance, without forking it.
 *
 * ## The new connection's audio never starts
 *
 * The transport files each remote track in `_incomingTracks` under its lane
 * ("microphone" for audio), and a track's `unmute` reports it to the app as
 * `trackStarted` only if its lane still has an entry. A track's `ended`
 * deletes its lane's entry. The new connection's track is filed first; then
 * closing the old connection ends the old track, whose `ended` deletes the
 * lane — the new track's entry, not its own. When the new track unmutes it
 * finds nothing, `trackStarted` never fires, and an app that plays the agent
 * from `trackStarted` (every pipecat example does) plays nothing for the rest
 * of the call. The call is otherwise fine: the transcript keeps arriving.
 *
 * The fix keeps a lane's entry when the track filed there is still live. The
 * track whose `ended` is running is not live by definition, so a live entry
 * can only be a newer track, and the delete is skipped. An ended track's own
 * entry is deleted exactly as before.
 *
 * ## It waits five seconds to notice
 *
 * On ICE `disconnected` the stock transport waits 5 s before rebuilding, in
 * case the connection comes back by itself, and the browser has already spent
 * a few seconds failing its consent checks before it says `disconnected` at
 * all. On a phone that changed networks the old path is never coming back, so
 * the caller hears nothing for the whole wait. Here:
 *
 * - `disconnected` rebuilds after `DISCONNECTED_GRACE_MS` instead. A rebuild
 *   costs the caller well under a second of audio (the server holds the call
 *   while the new connection comes up), so a grace longer than a rebuild buys
 *   nothing; a little longer than one rebuild still lets a momentary blip
 *   recover without one.
 * - The device moving networks rebuilds at once, without waiting for ICE to
 *   notice: a change of `navigator.connection.type` (wifi ↔ cellular, where
 *   the browser reports it, which is Android Chrome) or the page coming back
 *   `online`. Nothing is rebuilt while the browser says it is offline: every
 *   attempt would fail, and the transport gives up for good after a few.
 * - `failed` is the stock transport's own: it rebuilds at once.
 *
 * It reaches members of `SmallWebRTCTransport` that its `.d.ts` does not
 * declare: `_incomingTracks`, `pc`, `handleICEConnectionStateChange` and
 * `attemptReconnection`. A pipecat release that renames one switches off that
 * half of the fix and says so; the call itself is unaffected.
 */

import { logger } from "@pipecat-ai/client-js";

/**
 * How long ICE `disconnected` may last before the connection is rebuilt.
 * Derived: a rebuild measured on dev took 0.3–0.7 s from offer to connected,
 * so this is a little over twice the slowest one.
 */
export const DISCONNECTED_GRACE_MS = 1_500;

/** The members of `SmallWebRTCTransport` this module reaches. */
interface Reconnectable {
  _incomingTracks?: Map<string, { track?: MediaStreamTrack }>;
  pc?: RTCPeerConnection | null;
  handleICEConnectionStateChange?: () => void;
  attemptReconnection?: (recreatePeerConnection?: boolean) => Promise<void>;
}

/** Tells the caller when the device has moved to another network. */
export interface NetworkWatch {
  /** Whether the browser says it has no network at all. */
  offline(): boolean;
  /** Call `onMoved` whenever the device moves networks; returns the unsubscribe. */
  subscribe(onMoved: () => void): () => void;
}

const installed = new WeakSet<object>();

export function reconnectOnNetworkChange(
  transport: object,
  network: NetworkWatch | null = browserNetworkWatch(),
): void {
  if (installed.has(transport)) return;
  installed.add(transport);
  const t = transport as Reconnectable;
  keepNewerIncomingTracks(t);
  reconnectSooner(t, network);
}

function keepNewerIncomingTracks(t: Reconnectable): void {
  const tracks = t._incomingTracks;
  if (!(tracks instanceof Map)) {
    logger.debug("[voqalize] no _incomingTracks on this transport; reconnect track fix is off");
    return;
  }
  const remove = tracks.delete.bind(tracks);
  tracks.delete = (lane: string): boolean => {
    if (tracks.get(lane)?.track?.readyState === "live") {
      logger.debug(`[voqalize] kept the newer ${lane} track an old one's end would have dropped`);
      return false;
    }
    return remove(lane);
  };
}

function reconnectSooner(t: Reconnectable, network: NetworkWatch | null): void {
  const stock = t.handleICEConnectionStateChange;
  if (typeof stock !== "function" || typeof t.attemptReconnection !== "function") {
    logger.debug("[voqalize] no ICE handler on this transport; faster reconnect is off");
    return;
  }

  const offline = () => network?.offline() ?? false;
  const rebuild = (target: Reconnectable, why: string) => {
    logger.debug(`[voqalize] ${why}; rebuilding the peer connection`);
    void target.attemptReconnection?.(true);
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  t.handleICEConnectionStateChange = function (this: Reconnectable) {
    const pc = this.pc;
    if (!pc || pc.iceConnectionState !== "disconnected") {
      stock.call(this);
      return;
    }
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (this.pc !== pc || pc.iceConnectionState !== "disconnected" || offline()) return;
      rebuild(this, `ICE still disconnected after ${DISCONNECTED_GRACE_MS} ms`);
    }, DISCONNECTED_GRACE_MS);
  };

  if (!network) return;
  // The subscription must not keep a discarded transport alive: an app that
  // rebuilds its client (PipecatAppBase does, on a prop change) leaves the old
  // transport behind, and the page's network events outlive it.
  const ref = new WeakRef(t);
  const unsubscribe = network.subscribe(() => {
    const live = ref.deref();
    if (!live) {
      unsubscribe();
      return;
    }
    const pc = live.pc;
    // Only a call that has been up has a path to move. A first connect in
    // flight fails or succeeds on its own, and a rebuild already under way is
    // left alone.
    const state = pc?.connectionState;
    if (state !== "connected" && state !== "disconnected" && state !== "failed") return;
    if (offline()) return;
    rebuild(live, "the device moved networks");
  });
}

interface NetworkInformationLike extends EventTarget {
  type?: string;
}

/** The browser's own signals, or `null` outside a page. */
export function browserNetworkWatch(): NetworkWatch | null {
  if (typeof window === "undefined" || typeof navigator === "undefined") return null;
  const connection = (navigator as { connection?: NetworkInformationLike }).connection;
  return {
    offline: () => navigator.onLine === false,
    subscribe(onMoved) {
      // `change` also fires for every re-estimate of bandwidth and round trip,
      // so only a change of `type` counts, and only between two real networks.
      let type = connection?.type;
      const onConnectionChange = () => {
        const next = connection?.type;
        const moved = type !== undefined && next !== undefined && next !== type;
        type = next;
        if (moved && next !== "none") onMoved();
      };
      connection?.addEventListener("change", onConnectionChange);
      window.addEventListener("online", onMoved);
      return () => {
        connection?.removeEventListener("change", onConnectionChange);
        window.removeEventListener("online", onMoved);
      };
    },
  };
}
