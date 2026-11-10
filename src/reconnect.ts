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
 *   `online`.
 * - `failed` is the stock transport's own: it rebuilds at once.
 *
 * ## Nothing is rebuilt while the browser is offline
 *
 * Every attempt would fail, and the stock transport gives up for good after a
 * few: the call ends on a network that was coming back. So every rebuild —
 * the timer above, a network move, ICE `failed`, and the stock transport's own
 * retry two seconds after a failed offer — is held while the browser says it
 * is offline, without spending one of those attempts, and made once when the
 * page comes back `online`. `holdWhileOffline: false` switches the hold off and
 * leaves every path as the stock transport has it, apart from the shorter
 * grace.
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

export interface ReconnectOptions {
  /**
   * Hold every rebuild while the browser says it is offline, and make one
   * when it comes back online. Default true.
   */
  holdWhileOffline?: boolean;
}

const installed = new WeakSet<object>();

export function reconnectOnNetworkChange(
  transport: object,
  network: NetworkWatch | null = browserNetworkWatch(),
  { holdWhileOffline = true }: ReconnectOptions = {},
): void {
  if (installed.has(transport)) return;
  installed.add(transport);
  const t = transport as Reconnectable;
  keepNewerIncomingTracks(t);
  const held = holdWhileOffline && network ? holdRebuildsWhileOffline(t, network) : null;
  reconnectSooner(t, network, held);
}

/** Whether a rebuild was held, and clears it: the online handler's question. */
type HeldRebuild = () => boolean;

/**
 * Wrap `attemptReconnection` so a call while offline is held, not spent. The
 * stock transport calls it through `this`, so this one wrapper covers ICE
 * `failed`, its retry after a failed offer, and ours.
 */
function holdRebuildsWhileOffline(t: Reconnectable, network: NetworkWatch): HeldRebuild | null {
  const stock = ownMethod<(recreate?: boolean) => Promise<void>>(t, "attemptReconnection");
  // The rebuild a hold owes is made from the online handler, which the faster
  // reconnect installs only beside the ICE handler: without one, hold nothing.
  const ice = ownMethod<() => void>(t, "handleICEConnectionStateChange");
  if (typeof stock !== "function" || typeof ice !== "function") {
    logger.debug("[voqalize] no reconnect members on this transport; offline hold is off");
    return null;
  }
  let held = false;
  t.attemptReconnection = function (this: Reconnectable, recreate?: boolean) {
    if (network.offline()) {
      if (!held) logger.debug("[voqalize] offline; holding the rebuild until the page is online");
      held = true;
      return Promise.resolve();
    }
    held = false;
    return stock.call(this, recreate);
  };
  return () => {
    const was = held;
    held = false;
    return was;
  };
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

/**
 * A method as the object itself holds it. `client.transport` is pipecat's
 * `TransportWrapper` proxy, whose `get` hands back a forwarder that looks the
 * method up again on every call; once this module has replaced the method, that
 * forwarder reaches the replacement, which would call itself. Property
 * descriptors are not routed through the proxy's `get`.
 */
function ownMethod<F>(object: object, name: string): F | undefined {
  for (let o: object | null = object; o; o = Object.getPrototypeOf(o)) {
    const found = Object.getOwnPropertyDescriptor(o, name);
    if (found) return typeof found.value === "function" ? (found.value as F) : undefined;
  }
  return undefined;
}

function reconnectSooner(
  t: Reconnectable,
  network: NetworkWatch | null,
  held: HeldRebuild | null,
): void {
  const stock = ownMethod<() => void>(t, "handleICEConnectionStateChange");
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
    if (offline()) return;
    // A rebuild held while offline is made now, whatever ICE says: the
    // connection a failed retry left behind may never have got past "new".
    if (held?.() && live.pc) {
      rebuild(live, "back online with a rebuild held");
      return;
    }
    const pc = live.pc;
    // Only a call that has been up has a path to move. A first connect in
    // flight fails or succeeds on its own, and a rebuild already under way is
    // left alone. ICE's state, not the connection's: WebKit can leave
    // `connectionState` at "connecting" for a whole call that is carrying
    // audio, when DTLS finishes before the answer is applied.
    const state = pc?.iceConnectionState;
    if (
      state !== "connected" &&
      state !== "completed" &&
      state !== "disconnected" &&
      state !== "failed"
    )
      return;
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
