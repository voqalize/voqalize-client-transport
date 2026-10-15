/**
 * The local microphone level, reported through pipecat's `onLocalAudioLevel`
 * on the same scale and cadence as the Daily manager it replaces.
 *
 * **What Daily reports.** `DailyMediaManager` forwards daily-js's
 * `local-audio-level` event, which the remotely-loaded call machine computes in
 * an `AudioWorklet` modelled on WebRTC's `audio_level.cc` — the number behind
 * `RTCAudioSourceStats.audioLevel`. Every 100 ms it takes the loudest sample of
 * the window as linear full-scale amplitude (0 to 1, no dB, no RMS), holds the
 * larger of that and a quarter of the previous value, and reports it: an
 * instant attack and a decay to a quarter per window. It reports nothing while
 * the microphone is disabled, and starts with the microphone, before any call.
 * The measured detail is in `docs/FINDINGS.md`.
 *
 * **How it is measured here.** Decision 7 of `mediaManager.ts`: the published
 * track and the capture track never pass through Web Audio. The meter takes its
 * own `clone()` of the capture track — a branch off it, like the clone the peer
 * connection is given — and feeds only that to a `MediaStreamAudioSourceNode`
 * and an `AnalyserNode`. The analyser is connected to nothing, so the context
 * renders silence and nothing reaches a speaker; where the engine allows it, the
 * context is opened with no output device at all. A poll reads the analyser
 * every 100 ms and applies the peak-hold above.
 *
 * Everything here degrades to silence, never to an exception: no
 * `AudioContext` (node, the tier-1 fakes), a context that cannot be built, or
 * one the autoplay policy keeps suspended. While suspended it reports nothing,
 * and resumes inside the next user gesture the manager hears.
 */

import type { StreamLike, TrackLike } from "./mediaPlatform";

/** Daily's cadence: `startLocalAudioLevelObserver(100)` in `DailyMediaManager.initialize()`. */
export const LOCAL_AUDIO_LEVEL_INTERVAL_MS = 100;

/**
 * WebRTC's decay: the held peak is divided by this after every report
 * (`abs_max_ >>= 2` in `audio_level.cc`, `maxSampleEnergy / 4` in Daily's worklet).
 */
const PEAK_DECAY = 4;

/** The subset of `AudioNode` the meter touches. */
export interface AudioNodeLike {
  connect(destination: AudioNodeLike): unknown;
  disconnect(): void;
}

/** The subset of `AnalyserNode` the meter touches. */
export interface AnalyserLike extends AudioNodeLike {
  fftSize: number;
  smoothingTimeConstant: number;
  getFloatTimeDomainData?(array: Float32Array): void;
  getByteTimeDomainData(array: Uint8Array): void;
}

/**
 * The subset of `AudioContext` the meter touches. `state` is a string rather
 * than `AudioContextState` because WebKit has a further value, `"interrupted"`,
 * that the DOM typings do not list.
 */
export interface AudioContextLike {
  readonly state: string;
  readonly sampleRate: number;
  createMediaStreamSource(stream: StreamLike): AudioNodeLike;
  createAnalyser(): AnalyserLike;
  resume(): Promise<void>;
  close(): Promise<void>;
  addEventListener(type: "statechange", listener: () => void): void;
  removeEventListener(type: "statechange", listener: () => void): void;
}

/** Builds the context the meter runs in. Returning or throwing nothing usable turns the meter off. */
export type AudioContextFactory = () => AudioContextLike;

/**
 * The browser's own `AudioContext`, or `null` where there is none.
 *
 * Asked for with `sinkId: { type: "none" }`: Chromium then renders the graph
 * without opening an output device at all, which is the exact objection the
 * original decision 7 raised against a level meter. An engine that does not
 * know the member ignores it (WebIDL drops unknown dictionary members); one
 * that knows `sinkId` but rejects this value throws, and the context is asked
 * for again with no options.
 */
export function browserAudioContextFactory(): AudioContextFactory | null {
  type Ctor = new (options?: object) => AudioContextLike;
  const scope = globalThis as { AudioContext?: Ctor; webkitAudioContext?: Ctor };
  const Context = scope.AudioContext ?? scope.webkitAudioContext;
  if (typeof Context !== "function") return null;
  return () => {
    try {
      return new Context({ latencyHint: "playback", sinkId: { type: "none" } });
    } catch {
      return new Context();
    }
  };
}

export interface LocalAudioLevelMeterOptions {
  /** `null` turns the meter off: there is nothing to measure with. */
  createContext: AudioContextFactory | null;
  /** Wraps the meter's clone for `createMediaStreamSource`. Absent turns the meter off. */
  makeStream: ((tracks: TrackLike[]) => StreamLike) | undefined;
  onLevel: (level: number) => void;
  /** Told when the meter starts or stops waiting for a gesture to resume its context. */
  onNeedsGesture?: (needed: boolean) => void;
  intervalMs?: number | undefined;
}

/**
 * Measures one capture track at a time. The manager calls `measure()` with the
 * track that should be measured — the live, enabled microphone — or `null`, and
 * the meter converges on that: a new track gets a new branch, `null` tears the
 * whole thing down, the `AudioContext` included.
 */
export class LocalAudioLevelMeter {
  private readonly createContext: AudioContextFactory | null;
  private readonly makeStream: ((tracks: TrackLike[]) => StreamLike) | undefined;
  private readonly onLevel: (level: number) => void;
  private readonly onNeedsGesture: ((needed: boolean) => void) | undefined;
  private readonly intervalMs: number;

  /** The capture track being measured — not the branch, which is ours. */
  private source: TrackLike | null = null;
  private branch: TrackLike | null = null;
  private context: AudioContextLike | null = null;
  private sourceNode: AudioNodeLike | null = null;
  private analyser: AnalyserLike | null = null;
  private floatBuffer: Float32Array | null = null;
  private byteBuffer: Uint8Array | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private held = 0;
  private needsGesture = false;
  /** Set when building a context failed, so a broken engine is not retried every tick. */
  private unavailable = false;
  private readonly onStateChange = () => this.syncNeedsGesture();

  constructor(options: LocalAudioLevelMeterOptions) {
    this.createContext = options.createContext;
    this.makeStream = options.makeStream;
    this.onLevel = options.onLevel;
    this.onNeedsGesture = options.onNeedsGesture;
    this.intervalMs = options.intervalMs ?? LOCAL_AUDIO_LEVEL_INTERVAL_MS;
  }

  /** True while the context exists but the autoplay policy is holding it. */
  get waitingForGesture(): boolean {
    return this.needsGesture;
  }

  /** Measure `track`, or stop measuring altogether with `null`. */
  measure(track: TrackLike | null): void {
    if (track === this.source) return;
    if (!track || !this.createContext || !this.makeStream || this.unavailable) {
      this.stop();
      return;
    }
    const context = this.ensureContext();
    if (!context) return;

    this.detachBranch();
    let branch: TrackLike | null = null;
    try {
      branch = track.clone();
      branch.enabled = true;
      const node = context.createMediaStreamSource(this.makeStream([branch]));
      node.connect(this.ensureAnalyser(context));
      this.source = track;
      this.branch = branch;
      this.sourceNode = node;
    } catch {
      // A context that will not take this track measures nothing. The call is
      // unaffected; the level is a nicety and must never cost the microphone.
      if (branch) safeStop(branch);
      this.stop();
      return;
    }
    this.held = 0;
    if (!this.timer) this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.resume();
  }

  /**
   * Ask a held context to run. The manager calls this synchronously inside a
   * user gesture — the only place the autoplay policy lets it succeed — and the
   * meter calls it once on start, which is enough wherever a gesture already
   * happened or capture alone is allowed to start audio.
   */
  resume(): void {
    const context = this.context;
    if (!context || context.state === "running" || context.state === "closed") return;
    try {
      context.resume().then(
        () => this.syncNeedsGesture(),
        () => this.syncNeedsGesture(),
      );
    } catch {
      // Older engines threw synchronously from a context that cannot resume.
    }
    this.syncNeedsGesture();
  }

  /** Tear everything down: the branch, the graph, the timer and the context. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.detachBranch();
    try {
      this.analyser?.disconnect();
    } catch {
      // Already disconnected.
    }
    this.analyser = null;
    this.floatBuffer = null;
    this.byteBuffer = null;
    const context = this.context;
    this.context = null;
    if (context) {
      context.removeEventListener("statechange", this.onStateChange);
      try {
        void context.close().catch(() => undefined);
      } catch {
        // A context the engine already closed.
      }
    }
    this.held = 0;
    this.syncNeedsGesture();
  }

  private ensureContext(): AudioContextLike | null {
    if (this.context && this.context.state !== "closed") return this.context;
    if (this.context) this.stop();
    try {
      const context = this.createContext?.() ?? null;
      if (!context) throw new Error("no AudioContext");
      context.addEventListener("statechange", this.onStateChange);
      this.context = context;
      return context;
    } catch {
      this.unavailable = true;
      this.stop();
      return null;
    }
  }

  /**
   * The analyser's window covers the whole poll interval, so no peak between
   * two reads is missed: the smallest power of two at least `sampleRate ×
   * interval` samples long — 8192 at 48 kHz and 100 ms, which overlaps the
   * previous read by about 70 ms. The overlap re-counts a peak at most once
   * more, which the quarter-decay hold would have carried anyway.
   */
  private ensureAnalyser(context: AudioContextLike): AnalyserLike {
    if (this.analyser) return this.analyser;
    const analyser = context.createAnalyser();
    const wanted = Math.ceil((context.sampleRate * this.intervalMs) / 1000);
    let size = 32; // the smallest fftSize the spec allows
    while (size < wanted && size < 32768) size *= 2;
    analyser.fftSize = size;
    analyser.smoothingTimeConstant = 0; // frequency-domain only, but say so
    this.analyser = analyser;
    if (typeof analyser.getFloatTimeDomainData === "function") {
      this.floatBuffer = new Float32Array(size);
    } else {
      this.byteBuffer = new Uint8Array(size);
    }
    return analyser;
  }

  private tick(): void {
    const analyser = this.analyser;
    if (!analyser || this.context?.state !== "running") return;
    let peak = 0;
    if (this.floatBuffer && analyser.getFloatTimeDomainData) {
      analyser.getFloatTimeDomainData(this.floatBuffer);
      for (const sample of this.floatBuffer) {
        const magnitude = Math.abs(sample);
        if (magnitude > peak) peak = magnitude;
      }
    } else if (this.byteBuffer) {
      analyser.getByteTimeDomainData(this.byteBuffer);
      for (const sample of this.byteBuffer) {
        const magnitude = Math.abs(sample - 128) / 128;
        if (magnitude > peak) peak = magnitude;
      }
    }
    const level = Math.min(1, Math.max(peak, this.held));
    this.held = level / PEAK_DECAY;
    this.onLevel(level);
  }

  private detachBranch(): void {
    try {
      this.sourceNode?.disconnect();
    } catch {
      // Already disconnected.
    }
    this.sourceNode = null;
    if (this.branch) safeStop(this.branch);
    this.branch = null;
    this.source = null;
  }

  private syncNeedsGesture(): void {
    const state = this.context?.state;
    const needed = !!state && state !== "running" && state !== "closed";
    if (needed === this.needsGesture) return;
    this.needsGesture = needed;
    this.onNeedsGesture?.(needed);
  }
}

function safeStop(track: TrackLike): void {
  try {
    track.stop();
  } catch {
    // Already stopped.
  }
}
