/**
 * `CallHealth.connection`: the call's own state, read off pipecat's transport
 * rather than kept beside it, plus what the voice runtime tells this page and how the
 * agent's audio is arriving. Internal; `attachTrackChangedHandler()` installs
 * it, after `reconnect.ts`, so the factory and a hand-built transport both get
 * it.
 *
 * ## State
 *
 * Derived from the transport's `state` and its peer connection's ICE state:
 *
 * - `connecting` from pipecat's `connecting` until `ready`.
 * - `connected` at `ready`.
 * - `reconnecting` while a call that was up has lost its media path, or is
 *   rebuilding its peer connection (`reconnect.ts`, pipecat's own retry).
 *   Pipecat has no state for this; ICE on the current connection says it.
 * - `disconnected · unreachable` when no media path forms within
 *   `UNREACHABLE_MS` of connecting or of losing the path, and at once when ICE
 *   fails before the call was ever up. The bound does not run out while the
 *   browser is asking for the mic or camera: pipecat opens the devices before
 *   it sends its offer, and a user reading a permission prompt is not a
 *   network that cannot reach us. Either way the transport is told to
 *   disconnect, so `connect()` rejects instead of spinning: before this, a
 *   network that blocks UDP left a page on "connecting" for good.
 * - `disconnected · ended` for every other end.
 *
 * ## What the voice runtime says
 *
 * The voice runtime sends every page these messages under the data-channel label `voqalize`
 * rather than `rtvi-ai`, in the RTVI envelope's shape (the voice runtime's
 * `docs/transport.md`, "Call health"):
 *
 * - `caller-audio` `{audio: "ok" | "silent" | "none"}`: whether the voice runtime hears the
 *   caller, which becomes `mic.signal.server`.
 * - `caller-video` `{video: "ok" | "black" | "none"}`: whether the voice runtime receives a
 *   picture from the caller's camera, judged while the camera is on, which
 *   becomes `cam.signal.server` (`black` as `silent`).
 * - `network-quality` `{quality: "good" | "fair" | "poor" | "bad"}`: how the
 *   caller's network treats their audio, which becomes `connection.uplink`.
 *
 * pipecat's transport hands the client only `rtvi-ai` messages, so these are
 * read here, ahead of it, and never reach the app. Any other `voqalize`
 * message, or a value this version does not know, is dropped: the voice runtime may grow
 * the protocol, and an older page ignores what it does not understand. The page
 * sends the voice runtime nothing under this label.
 *
 * ## Downlink
 *
 * Graded here from the agent's incoming audio (`DownlinkGrader`), on the voice runtime's
 * scale.
 *
 * Reaches `state`, `handleMessage`, `handleICEConnectionStateChange`,
 * `attemptReconnection` and `pc` on the transport
 * instance, none of which its `.d.ts` declares; a pipecat release that renames
 * one switches off that part and says so at debug.
 */

import { logger } from "@pipecat-ai/client-js";
import { firstInstall } from "./once";

import type { ConnectionHealth, Grade, Signal } from "./callHealth";

/**
 * How long a call may go without a media path, connecting or reconnecting,
 * before it is reported unreachable and stopped. Owner ruling 2026-11-16: a
 * starting bound, to be adjusted from measurements of the slowest working
 * networks.
 */
export const UNREACHABLE_MS = 30_000;

/** How often the downlink is graded. */
export const DOWNLINK_SAMPLE_MS = 2_000;

/** What this module needs from the manager. */
export interface ConnectionHealthSink {
  _setConnectionHealth(patch: Partial<ConnectionHealth>): void;
  _setServerSignal(server: Signal["server"], device?: "mic" | "cam"): void;
  /** True while the browser is asking for a device; the unreachable bound waits for it. */
  _captureAsking?(): boolean;
}

interface Internals {
  state?: string;
  pc?: RTCPeerConnection | null;
  handleMessage?: (message: unknown) => void;
  handleICEConnectionStateChange?: () => void;
  attemptReconnection?: (recreatePeerConnection?: boolean) => Promise<void>;
  disconnect?: () => Promise<void>;
  /** What the last offer failed with; pipecat clears it after setting `error`. */
  _lastNegotiationError?: { status?: unknown } | null;
}

export interface ConnectionHealthOptions {
  unreachableMs?: number;
  downlinkSampleMs?: number;
}

export function trackConnectionHealth(
  transport: object,
  sink: ConnectionHealthSink,
  options: ConnectionHealthOptions = {},
): void {
  if (!firstInstall(transport, "connection-health")) return;
  new ConnectionWatch(transport as Internals, sink, options);
}

function refused(error: { status?: unknown } | null | undefined): boolean {
  const status = error?.status;
  return typeof status === "number" && status >= 400 && status < 500;
}

/** The data-channel label of the voice runtime's messages to this library. */
export const LIBRARY_LABEL = "voqalize";

class ConnectionWatch {
  private readonly unreachableMs: number;
  private readonly sampleMs: number;
  /** Whether the current attempt has had a media path. */
  private pathUp = false;
  private reconnecting = false;
  /** The call is over for a reason pipecat cannot see; cleared on the next connect. */
  private over: "unreachable" | "refused" | null = null;
  private attempted = false;
  private unreachableTimer: ReturnType<typeof setTimeout> | undefined;
  private statsTimer: ReturnType<typeof setInterval> | undefined;
  private uplink: Grade = "unknown";
  private readonly downlink = new DownlinkGrader();

  constructor(
    private readonly t: Internals,
    private readonly sink: ConnectionHealthSink,
    options: ConnectionHealthOptions,
  ) {
    this.unreachableMs = options.unreachableMs ?? UNREACHABLE_MS;
    this.sampleMs = options.downlinkSampleMs ?? DOWNLINK_SAMPLE_MS;
    this.watchState();
    this.watchMessages();
    this.watchIce();
    this.watchRebuilds();
  }

  // -- pipecat's state ----------------------------------------------------------

  private watchState(): void {
    const accessor = ownAccessor(this.t, "state");
    if (!accessor?.get || !accessor.set) {
      logger.debug("[voqalize] no state accessor on this transport; connection health is off");
      return;
    }
    const { get, set } = accessor;
    const onState = (state: string) => this.onState(state);
    Object.defineProperty(this.t, "state", {
      configurable: true,
      enumerable: accessor.enumerable ?? false,
      get(this: object) {
        return get.call(this) as unknown;
      },
      set(this: object, state: string) {
        const before = get.call(this) as unknown;
        set.call(this, state);
        if (before !== state) onState(state);
      },
    });
  }

  private onState(state: string): void {
    switch (state) {
      case "connecting":
        this.over = null;
        this.attempted = true;
        this.pathUp = false;
        this.reconnecting = false;
        this.uplink = "unknown";
        this.downlink.reset();
        this.armUnreachable();
        this.publish();
        return;
      case "ready":
        this.pathUp = true;
        this.reconnecting = false;
        this.disarmUnreachable();
        this.startStats();
        this.publish();
        return;
      case "error":
      case "disconnected":
        if (!this.attempted) return;
        if (state === "error" && !this.over) {
          // A 4xx to the offer (an expired session, a quota, a bad key) is the
          // server answering no: the network is fine, and retrying will not help.
          if (refused(this.t._lastNegotiationError)) this.over = "refused";
          else if (!this.pathUp || this.reconnecting) this.over = "unreachable";
        }
        this.end();
        return;
      default:
        return;
    }
  }

  // -- ICE and rebuilds -----------------------------------------------------------

  private watchIce(): void {
    const stock = ownMethod<NonNullable<Internals["handleICEConnectionStateChange"]>>(
      this.t,
      "handleICEConnectionStateChange",
    );
    if (typeof stock !== "function") {
      logger.debug("[voqalize] no ICE handler on this transport; reconnecting is not reported");
      return;
    }
    const neverUp = () => !this.pathUp && this.attempted && !this.over;
    const giveUp = (why: string) => this.giveUp(why);
    const onIce = (ice: RTCIceConnectionState | undefined) => this.onIce(ice);
    this.t.handleICEConnectionStateChange = function (this: Internals) {
      const ice = this.pc?.iceConnectionState;
      if (ice === "failed" && neverUp()) {
        // No path ever formed: retrying the same network will not form one.
        giveUp("ICE failed before the call was up");
        return;
      }
      stock.call(this);
      onIce(ice);
    };
  }

  private onIce(ice: RTCIceConnectionState | undefined): void {
    if (this.over || !this.attempted) return;
    if (ice === "connected" || ice === "completed") {
      // A path formed: what remains of connecting is the agent getting ready,
      // which is not the network's to answer for.
      this.pathUp = true;
      this.disarmUnreachable();
      if (this.reconnecting) {
        this.reconnecting = false;
        this.publish();
      }
      return;
    }
    if ((ice === "disconnected" || ice === "failed") && this.t.state === "ready") this.lostPath();
  }

  private watchRebuilds(): void {
    const stock = ownMethod<NonNullable<Internals["attemptReconnection"]>>(
      this.t,
      "attemptReconnection",
    );
    if (typeof stock !== "function") return;
    const rebuilding = () => {
      if (!this.over) this.lostPath();
    };
    this.t.attemptReconnection = function (this: Internals, recreate?: boolean) {
      // A rebuild of a call that was up. `false` is a renegotiation the server
      // asked for, not an outage.
      if (recreate && this.state === "ready") rebuilding();
      return stock.call(this, recreate);
    };
  }

  private lostPath(): void {
    if (this.reconnecting) return;
    this.reconnecting = true;
    this.armUnreachable();
    this.publish();
  }

  private armUnreachable(): void {
    this.disarmUnreachable();
    this.unreachableTimer = setTimeout(() => {
      // A prompt still open: the bound starts again once it is answered.
      if (this.sink._captureAsking?.()) this.armUnreachable();
      else this.giveUp(`no media path within ${this.unreachableMs} ms`);
    }, this.unreachableMs);
  }

  private disarmUnreachable(): void {
    clearTimeout(this.unreachableTimer);
    this.unreachableTimer = undefined;
  }

  private giveUp(why: string): void {
    logger.debug(`[voqalize] ${why}; the call is unreachable`);
    this.over = "unreachable";
    this.end();
    this.disconnect();
  }

  private disconnect(): void {
    const disconnect = this.t.disconnect;
    if (typeof disconnect !== "function") return;
    disconnect.call(this.t).catch((error: unknown) => {
      logger.debug("[voqalize] disconnect after the call ended failed", error);
    });
  }

  private end(): void {
    this.disarmUnreachable();
    this.stopStats();
    this.reconnecting = false;
    this.uplink = "unknown";
    this.downlink.reset();
    this.sink._setServerSignal("unmeasured");
    this.sink._setServerSignal("unmeasured", "cam");
    this.publish();
  }

  // -- the voice runtime's messages --------------------------------------------------------------

  private watchMessages(): void {
    const stock = ownMethod<NonNullable<Internals["handleMessage"]>>(this.t, "handleMessage");
    if (typeof stock !== "function") {
      logger.debug(
        "[voqalize] no handleMessage on this transport; the voice runtime's call health is off",
      );
      return;
    }
    const consume = (message: unknown) => this.consume(message);
    this.t.handleMessage = function (this: Internals, message: unknown) {
      if (consume(message)) return;
      stock.call(this, message);
    };
  }

  /** True when the message was ours, which pipecat would drop anyway. */
  private consume(message: unknown): boolean {
    if (typeof message !== "string" || !message.includes(LIBRARY_LABEL)) return false;
    let parsed: { label?: unknown; type?: unknown; data?: Record<string, unknown> } | null;
    try {
      parsed = JSON.parse(message) as typeof parsed;
    } catch {
      return false;
    }
    if (parsed?.label !== LIBRARY_LABEL) return false;
    const data = parsed.data;
    switch (parsed.type) {
      case "network-quality": {
        if (this.over || this.t.state !== "ready") return true;
        const quality = data?.quality;
        if (quality === "good" || quality === "fair" || quality === "poor" || quality === "bad") {
          this.uplink = quality;
          this.publish();
        }
        return true;
      }
      case "caller-audio": {
        if (this.over || this.t.state !== "ready") return true;
        const audio = data?.audio;
        if (audio === "ok") this.sink._setServerSignal("sound");
        else if (audio === "silent" || audio === "none") this.sink._setServerSignal(audio);
        return true;
      }
      case "caller-video": {
        if (this.over || this.t.state !== "ready") return true;
        const video = data?.video;
        if (video === "ok") this.sink._setServerSignal("sound", "cam");
        else if (video === "black") this.sink._setServerSignal("silent", "cam");
        else if (video === "none") this.sink._setServerSignal("none", "cam");
        return true;
      }
      default:
        return true;
    }
  }

  // -- downlink -----------------------------------------------------------------------

  private startStats(): void {
    if (this.statsTimer !== undefined) return;
    this.statsTimer = setInterval(() => void this.sampleDownlink(), this.sampleMs);
  }

  private stopStats(): void {
    clearInterval(this.statsTimer);
    this.statsTimer = undefined;
  }

  private async sampleDownlink(): Promise<void> {
    const pc = this.t.pc;
    if (this.t.state !== "ready" && this.t.state !== "connecting") {
      // The call ended without the state change that stops sampling (a
      // transport torn down from outside): stop rather than poll for good.
      this.stopStats();
      return;
    }
    if (!pc || pc.connectionState === "closed" || typeof pc.getStats !== "function") return;
    let report: RTCStatsReport;
    try {
      report = await pc.getStats();
    } catch {
      return;
    }
    const sample = inboundAudio(report);
    if (sample && this.downlink.push(sample)) this.publish();
  }

  // -- publishing -----------------------------------------------------------------------

  private publish(): void {
    this.sink._setConnectionHealth(this.snapshot());
  }

  private snapshot(): ConnectionHealth {
    const state = this.t.state;
    if (this.over || state === "disconnected" || state === "disconnecting" || state === "error") {
      return {
        state: "disconnected",
        reason: this.over ?? "ended",
        uplink: "unknown",
        downlink: "unknown",
      };
    }
    if (state === "ready") {
      // During an outage the voice runtime's last word is all we have, and it is stale.
      if (this.reconnecting)
        return { state: "reconnecting", uplink: "unknown", downlink: "unknown" };
      return { state: "connected", uplink: this.uplink, downlink: this.downlink.grade };
    }
    return { state: "connecting", uplink: "unknown", downlink: "unknown" };
  }
}

// -- downlink grading -------------------------------------------------------------------

/** One reading of the agent's inbound audio, cumulative as WebRTC reports it. */
export interface InboundAudioSample {
  packetsReceived: number;
  packetsLost: number;
  /**
   * Samples the decoder concealed with sound, and all samples played. Silent
   * concealment is left out: it is what plays when the voice runtime stops sending at the
   * end of a sentence, so it says nothing about the network.
   */
  concealedSamples: number;
  totalSamplesReceived: number;
  /** Seconds. */
  jitter: number;
}

export function inboundAudio(report: RTCStatsReport): InboundAudioSample | null {
  let found: InboundAudioSample | null = null;
  report.forEach((stat: Record<string, unknown>) => {
    if (found || stat.type !== "inbound-rtp" || stat.kind !== "audio") return;
    found = {
      packetsReceived: Number(stat.packetsReceived ?? 0),
      packetsLost: Math.max(0, Number(stat.packetsLost ?? 0)),
      concealedSamples: Math.max(
        0,
        Number(stat.concealedSamples ?? 0) - Number(stat.silentConcealedSamples ?? 0),
      ),
      totalSamplesReceived: Number(stat.totalSamplesReceived ?? 0),
      jitter: Number(stat.jitter ?? 0),
    };
  });
  return found;
}

interface Reading {
  due: number;
  lost: number;
  concealed: number;
  total: number;
  jitter: number;
}

/**
 * Grades the agent's audio on the voice runtime's scale, over the last `WINDOW` readings.
 *
 * Only readings in which packets arrived count. The voice runtime sends nothing between
 * sentences, and the browser conceals every one of those pauses; counting them
 * would call every quiet stretch of a good call bad. A reading with no packets
 * keeps the grade as it was. Nor does the reading before one: when the voice runtime stops
 * at the end of a sentence the decoder fades out, and that fade is concealment
 * with sound in it, in whichever reading the sentence ended. So a reading is
 * graded only once the next one shows packets still coming. The pause itself
 * is concealed as silence and is left out (`inboundAudio`). Measured on a
 * local call: the pause made a perfect path read `bad`, and the fade, 67 ms
 * over two sentences, still made it `fair`.
 *
 * The measure is the worse of packets lost against packets due and samples
 * the decoder made up against samples played. Fair from 1%, poor from 3%, bad
 * from 10%, or the jitter that goes with each; the voice runtime's uplink grades are cut
 * near the same shares of a 10 s window. Worse is reported at once; better
 * one step at a time, after `RECOVER` better readings in a row, so a grade
 * does not flap.
 */
export class DownlinkGrader {
  static readonly WINDOW = 5;
  static readonly RECOVER = 5;
  private previous: InboundAudioSample | null = null;
  private window: Reading[] = [];
  /** The last reading with packets, graded once the stream is seen to go on. */
  private pending: Reading | null = null;
  private current: Grade = "unknown";
  private better = 0;

  get grade(): Grade {
    return this.current;
  }

  reset(): void {
    this.previous = null;
    this.window = [];
    this.pending = null;
    this.current = "unknown";
    this.better = 0;
  }

  /** Returns true when the grade changed. */
  push(sample: InboundAudioSample): boolean {
    const previous = this.previous;
    this.previous = sample;
    if (!previous || sample.packetsReceived < previous.packetsReceived) return false;
    const received = sample.packetsReceived - previous.packetsReceived;
    if (received === 0) {
      this.pending = null;
      return false;
    }
    const lost = Math.max(0, sample.packetsLost - previous.packetsLost);
    const ready = this.pending;
    this.pending = {
      due: received + lost,
      lost,
      concealed: Math.max(0, sample.concealedSamples - previous.concealedSamples),
      total: Math.max(0, sample.totalSamplesReceived - previous.totalSamplesReceived),
      jitter: sample.jitter,
    };
    if (!ready) return false;
    this.window.push(ready);
    if (this.window.length > DownlinkGrader.WINDOW) this.window.shift();
    return this.settle(gradeWindow(this.window));
  }

  private settle(measured: Grade): boolean {
    const before = this.current;
    if (this.current === "unknown" || rank(measured) > rank(this.current)) {
      this.current = measured;
      this.better = 0;
    } else if (rank(measured) < rank(this.current)) {
      this.better += 1;
      if (this.better >= DownlinkGrader.RECOVER) {
        this.current = GRADES[rank(this.current) - 1] ?? measured;
        this.better = 0;
      }
    } else {
      this.better = 0;
    }
    return this.current !== before;
  }
}

const GRADES: Grade[] = ["good", "fair", "poor", "bad"];

function rank(grade: Grade): number {
  return Math.max(0, GRADES.indexOf(grade));
}

function gradeWindow(window: readonly Reading[]): Grade {
  let due = 0;
  let lost = 0;
  let concealed = 0;
  let total = 0;
  let jitter = 0;
  for (const r of window) {
    due += r.due;
    lost += r.lost;
    concealed += r.concealed;
    total += r.total;
    jitter = Math.max(jitter, r.jitter);
  }
  const worst = Math.max(due > 0 ? lost / due : 0, total > 0 ? concealed / total : 0);
  if (worst >= 0.1 || jitter >= 0.1) return "bad";
  if (worst >= 0.03 || jitter >= 0.05) return "poor";
  if (worst >= 0.01 || jitter >= 0.03) return "fair";
  return "good";
}

// -- helpers -------------------------------------------------------------------------------

/** An accessor as the object itself holds it, past pipecat's proxy (see `reconnect.ts`). */
function ownAccessor(object: object, name: string): PropertyDescriptor | undefined {
  for (let o: object | null = object; o; o = Object.getPrototypeOf(o)) {
    const found = Object.getOwnPropertyDescriptor(o, name);
    if (found) return found.get || found.set ? found : undefined;
  }
  return undefined;
}

/**
 * A method as the object itself holds it. Read through pipecat's proxy, a
 * method comes back as a forwarder that looks it up again on every call, so
 * once it is replaced the forwarder reaches the replacement, which would call
 * itself (`reconnect.ts` has the same rule).
 */
function ownMethod<F>(object: object, name: string): F | undefined {
  for (let o: object | null = object; o; o = Object.getPrototypeOf(o)) {
    const found = Object.getOwnPropertyDescriptor(o, name);
    if (found) return typeof found.value === "function" ? (found.value as F) : undefined;
  }
  return undefined;
}
