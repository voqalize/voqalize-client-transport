/**
 * The playout guard: re-attach the agent's track when an element stops
 * playing it. Internal; the manager builds one per bound element.
 *
 * ## The failure it answers
 *
 * Measured on Android Chrome (Chrome 154, Android 10), on a page that takes
 * over a call another page was carrying — a full page load mid-call: the
 * element is given the remote track, `play()` resolves, the element's clock
 * runs, and nothing comes out. The receiver's `totalSamplesReceived`, which in
 * Chromium advances only as the output pulls audio, stays where it was while
 * packets keep arriving. About a second in the element raises `error` (code 3)
 * and pauses itself, and it stays paused for the rest of the call.
 * Re-attaching the same track — a new `MediaStream` on `srcObject`, then
 * `play()` — brings the output back at once. It happened with pipecat's
 * default media manager and with ours, so it is the element, not the capture
 * side.
 *
 * So the guard does exactly that, on two signals:
 *
 * - **the element's `error`**, which every occurrence measured ends in. This
 *   is the backstop, and the only signal outside Chromium: Firefox and WebKit
 *   advance `totalSamplesReceived` whether or not anything is listening, so
 *   their samples never stand still.
 * - **a stall**: the element is not paused, packets for its track keep
 *   arriving, and the samples played have not moved across two reads and
 *   `stillMs`. On the phone this fires well before the error, which is the
 *   difference between a clipped first word and a missing sentence.
 *
 * The stall is judged tightly in a short window once the source's packets
 * start, where the measured failure lives and every hundred milliseconds is
 * heard, and loosely after it, where a false re-attach would cost a glitch on
 * a call that was fine.
 *
 * It never fights the app. An element the app paused is left alone (a paused
 * element pulls nothing, so its samples standing still mean nothing). A source
 * is told apart from the guard's own re-attach by identity, read on every
 * tick, so it does not depend on when an engine fires `loadstart`. A source
 * the app attaches gets a fresh budget; recoveries back off and are capped, so
 * a track that genuinely cannot play is not re-attached forever. An engine
 * whose stats lack either counter gets the error path only.
 */

import type { OutputElementLike, StreamLike, TrackLike } from "./mediaPlatform";

/** What the guard reads off the peer connection: `RTCPeerConnection.getStats()`. */
export type PlayoutStatsSource = () => Promise<PlayoutStatsReport | null | undefined>;

/** The subset of `RTCStatsReport` the guard reads. */
export interface PlayoutStatsReport {
  forEach(callback: (stat: Record<string, unknown>) => void): void;
}

export type PlayoutRecoveryReason = "error" | "stalled";

export interface PlayoutGuardOptions {
  /** The peer connection's stats, or nothing while there is no connection. */
  stats: () => PlayoutStatsSource | null;
  /** Build the stream the element is re-attached to. */
  makeStream: (tracks: TrackLike[]) => StreamLike;
  /** `play()` the element, with the manager's own classification of a refusal. */
  play: (element: OutputElementLike) => void;
  onRecovered?: (reason: PlayoutRecoveryReason) => void;
  /** The window after a source's packets start, judged tightly. Default 2000 ms. */
  fastWindowMs?: number;
  /** Stats reads before and inside that window. Default 100 ms. */
  fastPollMs?: number;
  /** Samples standing still this long inside the window is a stall. Default 120 ms. */
  fastStillMs?: number;
  /** Packets that must arrive across a stall inside the window. Default 5. */
  fastMinPackets?: number;
  /** Stats reads after the window. Default 250 ms. */
  pollMs?: number;
  /** Samples standing still this long after the window is a stall. Default 300 ms. */
  stillMs?: number;
  /** Packets that must arrive across a stall after the window. Default 10. */
  minPackets?: number;
  /** Re-attaches allowed per source the app attaches. Default 5. */
  maxRecoveries?: number;
  /** The wait before the second re-attach, doubling for each after it. Default 500 ms. */
  backoffMs?: number;
  now?: () => number;
}

export class PlayoutGuard {
  private readonly fastWindowMs: number;
  private readonly fastPollMs: number;
  private readonly fastStillMs: number;
  private readonly fastMinPackets: number;
  private readonly pollMs: number;
  private readonly stillMs: number;
  private readonly minPackets: number;
  private readonly maxRecoveries: number;
  private readonly backoffMs: number;
  private readonly now: () => number;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private reading = false;
  private stopped = false;

  /** The `srcObject` the guard last saw, and the one it put there itself. */
  private source: unknown = null;
  private own: unknown = null;
  private recoveries = 0;
  private lastRecoveryAt = 0;
  /** An `error` that arrived inside the backoff, answered once it has passed. */
  private pendingError = false;
  /** False once an engine's stats are found to lack a counter, for this source. */
  private stallSupported = true;
  /** When the tight window ends; null until the source's packets start. */
  private fastUntil: number | null = null;
  private attachedAt = 0;
  private lastSamples = -1;
  private lastMovedAt = 0;
  private stillReads = 0;
  private packetsWhenStill = 0;

  /**
   * One task later: Chrome pauses the element after its `error`, and a
   * re-attach made inside the event would be undone by that pause.
   */
  private readonly onError = () => {
    setTimeout(() => {
      if (this.stopped) return;
      this.syncSource();
      // The app answered it already (a new source clears `error`), or the
      // engine aborted at someone's request: neither is ours to undo.
      if (errorCode(this.element.error) === null || errorCode(this.element.error) === 1) return;
      this.pendingError = true;
      this.answerPendingError();
    }, 0);
  };

  constructor(
    private readonly element: OutputElementLike,
    private readonly options: PlayoutGuardOptions,
  ) {
    this.fastWindowMs = options.fastWindowMs ?? 2000;
    this.fastPollMs = options.fastPollMs ?? 100;
    this.fastStillMs = options.fastStillMs ?? 120;
    this.fastMinPackets = options.fastMinPackets ?? 5;
    this.pollMs = options.pollMs ?? 250;
    this.stillMs = options.stillMs ?? 300;
    this.minPackets = options.minPackets ?? 10;
    this.maxRecoveries = options.maxRecoveries ?? 5;
    this.backoffMs = options.backoffMs ?? 500;
    this.now = options.now ?? (() => Date.now());
    element.addEventListener?.("error", this.onError);
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    this.element.removeEventListener?.("error", this.onError);
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    if (this.stopped) return;
    const fast = this.fastUntil === null || this.now() < this.fastUntil;
    this.timer = setTimeout(
      () => {
        void this.check().finally(() => this.schedule());
      },
      fast ? this.fastPollMs : this.pollMs,
    );
  }

  /** One tick. Public so a test can drive it without a timer. */
  async check(): Promise<void> {
    if (this.reading || this.stopped) return;
    this.syncSource();
    this.answerPendingError();

    const track = this.liveAudioTrack();
    const source = this.options.stats();
    if (!track || !source || !this.stallSupported || this.element.paused) {
      this.resetStall();
      return;
    }
    const attached = this.source;
    this.reading = true;
    let report: PlayoutStatsReport | null | undefined;
    try {
      report = await source();
    } catch {
      report = null; // A closed peer connection; the next tick sees no source.
    } finally {
      this.reading = false;
    }
    // The world may have moved during the read: a new source, a pause the app
    // made, a stop. Judge only what is still true.
    this.syncSource();
    if (this.stopped || this.source !== attached || this.element.paused) {
      this.resetStall();
      return;
    }
    const inbound = report ? findInbound(report, track.id) : null;
    if (!inbound) return;

    const samples = inbound.totalSamplesReceived;
    const packets = inbound.packetsReceived;
    if (typeof samples !== "number" || typeof packets !== "number") {
      this.stallSupported = false;
      return;
    }
    const at = this.now();
    if (this.fastUntil === null && packets > 0) this.fastUntil = at + this.fastWindowMs;
    if (samples !== this.lastSamples) {
      this.lastSamples = samples;
      this.lastMovedAt = at;
      this.stillReads = 0;
      this.packetsWhenStill = packets;
      return;
    }
    this.stillReads += 1;
    const fast = this.fastUntil !== null && at < this.fastUntil;
    const stillMs = fast ? this.fastStillMs : this.stillMs;
    const minPackets = fast ? this.fastMinPackets : this.minPackets;
    if (this.stillReads < 2) return;
    if (at - this.lastMovedAt < stillMs || at - this.attachedAt < stillMs) return;
    if (packets - this.packetsWhenStill < minPackets) return;
    if (!this.mayRecover(at)) return;
    this.recover("stalled");
  }

  /**
   * Notice a source the guard did not put there. Read by identity on every
   * tick and before every recovery, because engines differ on when (and
   * whether) a source change fires `loadstart`.
   */
  private syncSource(): void {
    const current = this.element.srcObject ?? null;
    if (current === this.source) return;
    this.source = current;
    if (current !== null && current === this.own) return;
    // The app attached something new, or cleared it: a fresh budget, a fresh
    // window, and the stall path back on.
    this.own = null;
    this.recoveries = 0;
    this.lastRecoveryAt = 0;
    this.pendingError = false;
    this.stallSupported = true;
    this.fastUntil = null;
    this.attachedAt = this.now();
    this.resetStall();
  }

  private answerPendingError(): void {
    if (!this.pendingError) return;
    if (errorCode(this.element.error) === null) {
      this.pendingError = false;
      return;
    }
    if (!this.mayRecover(this.now())) return;
    this.pendingError = false;
    this.recover("error");
  }

  private mayRecover(at: number): boolean {
    if (this.recoveries >= this.maxRecoveries) return false;
    if (this.recoveries === 0) return true;
    return at - this.lastRecoveryAt >= this.backoffMs * 2 ** (this.recoveries - 1);
  }

  private recover(reason: PlayoutRecoveryReason): void {
    const source = this.element.srcObject as StreamLike | null | undefined;
    if (!source || typeof source.getTracks !== "function") return;
    // Every live track, so a bound `<video>` keeps its picture.
    const tracks = source.getTracks().filter((t) => t.readyState === "live");
    if (!tracks.some((t) => t.kind === "audio")) return;
    const stream = this.options.makeStream(tracks);
    this.recoveries += 1;
    this.lastRecoveryAt = this.now();
    this.own = stream;
    this.source = stream;
    this.fastUntil = null;
    this.attachedAt = this.now();
    this.resetStall();
    (this.element as { srcObject?: unknown }).srcObject = stream;
    this.options.play(this.element);
    this.options.onRecovered?.(reason);
  }

  private resetStall(): void {
    this.lastSamples = -1;
    this.lastMovedAt = this.now();
    this.stillReads = 0;
    this.packetsWhenStill = 0;
  }

  private liveAudioTrack(): TrackLike | undefined {
    const source = this.element.srcObject as StreamLike | null | undefined;
    if (!source || typeof source.getAudioTracks !== "function") return undefined;
    return source.getAudioTracks().find((t) => t.readyState === "live");
  }
}

/**
 * The inbound audio stream feeding `trackId`. `trackIdentifier` names the
 * receiver's track; when an engine leaves it out, the one inbound audio
 * stream is unambiguous and anything else is not ours to guess at.
 */
function findInbound(report: PlayoutStatsReport, trackId: string): Record<string, unknown> | null {
  let match: Record<string, unknown> | null = null;
  const audio: Record<string, unknown>[] = [];
  report.forEach((stat) => {
    if (stat.type !== "inbound-rtp" || stat.kind !== "audio") return;
    audio.push(stat);
    if (stat.trackIdentifier === trackId) match = stat;
  });
  return match ?? (audio.length === 1 ? (audio[0] ?? null) : null);
}

/** `MediaError.code`, or null when there is no error. */
function errorCode(error: unknown): number | null {
  if (!error) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" ? code : 0;
}
