/**
 * The playout guard: re-attach the agent's track when an element stops
 * playing it.
 *
 * ## The failure it answers
 *
 * Measured on Android Chrome (Chrome 154, Android 10), on a page that takes
 * over a call another page was carrying — a full page load mid-call: the
 * element is given the remote track, `play()` resolves, the element's clock
 * runs, and nothing comes out. The receiver's `totalSamplesReceived`, which
 * advances only as the output pulls audio, stays where it was while packets
 * keep arriving. About a second in the element raises `error` (code 3) and
 * pauses itself, and it stays paused for the rest of the call. Re-attaching
 * the same track — a new `MediaStream` on `srcObject`, then `play()` — brings
 * the output back at once. It happened with pipecat's default media manager
 * and with ours, so it is the element, not the capture side.
 *
 * So the guard does exactly that, on two signals:
 *
 * - **the element's `error`**, which every occurrence measured ends in;
 * - **a stall**: the element is not paused, packets for its track keep
 *   arriving, and the samples played have not moved for `stillMs`. This one
 *   fires about 0.7 s before the error, which is the difference between a
 *   clipped first word and a missing sentence.
 *
 * It never fights the app: an element the app paused is left alone (a paused
 * element pulls nothing, so its samples standing still mean nothing), and an
 * element with no live audio track has nothing to re-attach. Recoveries are
 * capped per source, so a track that genuinely cannot play is not re-attached
 * forever.
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
  /** How often the stall check reads stats. Default 100 ms. */
  pollMs?: number;
  /** Samples standing still this long, with packets arriving, is a stall. Default 300 ms. */
  stillMs?: number;
  /** Packets that must arrive across the stall, so silence is never a stall. Default 10. */
  minPackets?: number;
  /** Re-attaches allowed per source the app attaches. Default 5. */
  maxRecoveries?: number;
  now?: () => number;
}

export class PlayoutGuard {
  private readonly pollMs: number;
  private readonly stillMs: number;
  private readonly minPackets: number;
  private readonly maxRecoveries: number;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private reading = false;

  private recoveries = 0;
  /** Set while we replace `srcObject`, so our own `loadstart` is not a new source. */
  private reattaching = false;
  private attachedAt: number;
  private lastSamples = -1;
  private lastMovedAt = 0;
  private packetsWhenStill = 0;

  private stopped = false;
  /**
   * One task later: Chrome pauses the element after its `error`, and a
   * re-attach made inside the event would be undone by that pause.
   */
  private readonly onError = () => {
    setTimeout(() => {
      if (!this.stopped) this.recover("error");
    }, 0);
  };
  private readonly onLoadStart = () => {
    this.attachedAt = this.now();
    this.resetStall();
    if (this.reattaching) {
      this.reattaching = false;
      return;
    }
    // The app attached something new: a fresh source gets a fresh budget.
    this.recoveries = 0;
  };

  constructor(
    private readonly element: OutputElementLike,
    private readonly options: PlayoutGuardOptions,
  ) {
    this.pollMs = options.pollMs ?? 100;
    this.stillMs = options.stillMs ?? 300;
    this.minPackets = options.minPackets ?? 10;
    this.maxRecoveries = options.maxRecoveries ?? 5;
    this.now = options.now ?? (() => Date.now());
    this.attachedAt = this.now();
    element.addEventListener?.("error", this.onError);
    element.addEventListener?.("loadstart", this.onLoadStart);
    this.timer = setInterval(() => void this.check(), this.pollMs);
  }

  stop(): void {
    this.stopped = true;
    this.element.removeEventListener?.("error", this.onError);
    this.element.removeEventListener?.("loadstart", this.onLoadStart);
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One stall check. Public so a test can drive it without a timer. */
  async check(): Promise<void> {
    if (this.reading) return;
    const track = this.liveAudioTrack();
    const source = this.options.stats();
    if (!track || !source || (this.element.paused && !this.element.error)) {
      this.resetStall();
      return;
    }
    this.reading = true;
    let report: PlayoutStatsReport | null | undefined;
    try {
      report = await source();
    } catch {
      report = null; // A closed peer connection; the next tick sees no source.
    } finally {
      this.reading = false;
    }
    const inbound = report ? findInbound(report, track.id) : null;
    if (!inbound) return;

    const samples = num(inbound.totalSamplesReceived);
    const packets = num(inbound.packetsReceived);
    const at = this.now();
    if (samples !== this.lastSamples) {
      this.lastSamples = samples;
      this.lastMovedAt = at;
      this.packetsWhenStill = packets;
      return;
    }
    if (at - this.lastMovedAt < this.stillMs) return;
    if (at - this.attachedAt < this.stillMs) return;
    if (packets - this.packetsWhenStill < this.minPackets) return;
    this.recover("stalled");
  }

  private recover(reason: PlayoutRecoveryReason): void {
    if (this.recoveries >= this.maxRecoveries) return;
    const tracks = this.audioTracks().filter((t) => t.readyState === "live");
    if (!tracks.length) return;
    this.recoveries += 1;
    this.reattaching = true;
    this.attachedAt = this.now();
    this.resetStall();
    (this.element as { srcObject?: unknown }).srcObject = this.options.makeStream(tracks);
    this.options.play(this.element);
    this.options.onRecovered?.(reason);
  }

  private resetStall(): void {
    this.lastSamples = -1;
    this.lastMovedAt = this.now();
    this.packetsWhenStill = 0;
  }

  private audioTracks(): TrackLike[] {
    const source = this.element.srcObject;
    if (!source || typeof (source as StreamLike).getAudioTracks !== "function") return [];
    return (source as StreamLike).getAudioTracks();
  }

  private liveAudioTrack(): TrackLike | undefined {
    return this.audioTracks().find((t) => t.readyState === "live");
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

function num(value: unknown): number {
  return typeof value === "number" ? value : 0;
}
