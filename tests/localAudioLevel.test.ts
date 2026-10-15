/**
 * `onLocalAudioLevel` (decision 7): the level Daily's manager emits, measured
 * on a clone of the capture track, over the fake `MediaDevices` and a fake
 * `AudioContext` whose analyser reports a loudness the test sets per device.
 *
 * A fake clock here, unlike the contract cases: the claim is a cadence, and
 * tier 2 checks the real one in `e2e/factory.spec.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FakeMediaDevices,
  FakeMediaStream,
  type FakeMediaStreamTrack,
} from "../lab/fakeMediaDevices";
import {
  browserAudioContextFactory,
  LOCAL_AUDIO_LEVEL_INTERVAL_MS,
  type AnalyserLike,
  type AudioContextLike,
  type AudioNodeLike,
} from "../src/localAudioLevel";
import { VoqalizeMediaManager } from "../src/mediaManager";
import type { StreamLike, TrackLike } from "../src/mediaPlatform";

const TICK = LOCAL_AUDIO_LEVEL_INTERVAL_MS;

/** What the microphones are hearing, by device id. A disabled or ended track hears nothing. */
class World {
  loudness = new Map<string, number>();
  /** Whether `resume()` succeeds — false is the autoplay policy holding the context. */
  resumable = true;
  initialState = "running";
  contexts: FakeAudioContext[] = [];

  heard(track: TrackLike): number {
    if (track.readyState !== "live" || !track.enabled) return 0;
    return this.loudness.get(track.getSettings().deviceId ?? "") ?? 0;
  }

  get current(): FakeAudioContext | undefined {
    return this.contexts.at(-1);
  }
}

class FakeSourceNode implements AudioNodeLike {
  readonly connections: unknown[] = [];
  constructor(readonly track: TrackLike) {}
  connect(destination: AudioNodeLike): unknown {
    this.connections.push(destination);
    if (destination instanceof FakeAnalyser) destination.input = this;
    return destination;
  }
  disconnect(): void {
    for (const node of this.connections) {
      if (node instanceof FakeAnalyser && node.input === this) node.input = null;
    }
    this.connections.length = 0;
  }
}

class FakeAnalyser implements AnalyserLike {
  fftSize = 2048;
  smoothingTimeConstant = 0.8;
  input: FakeSourceNode | null = null;
  readonly connections: unknown[] = [];
  constructor(private readonly world: World) {}
  connect(destination: AudioNodeLike): unknown {
    this.connections.push(destination);
    return destination;
  }
  disconnect(): void {
    this.connections.length = 0;
  }
  getFloatTimeDomainData(array: Float32Array): void {
    const level = this.input ? this.world.heard(this.input.track) : 0;
    array.fill(level / 2);
    // One sample at the peak, negative, so a meter that forgot `abs` or took
    // a mean would read something else.
    array[array.length - 1] = -level;
  }
  getByteTimeDomainData(array: Uint8Array): void {
    array.fill(128);
  }
}

class FakeAudioContext implements AudioContextLike {
  state: string;
  readonly sampleRate = 48_000;
  readonly sources: FakeSourceNode[] = [];
  readonly analysers: FakeAnalyser[] = [];
  resumeCalls = 0;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly world: World) {
    this.state = world.initialState;
  }
  createMediaStreamSource(stream: StreamLike): AudioNodeLike {
    const track = stream.getAudioTracks()[0];
    if (!track) throw new DOMException("no audio track", "InvalidStateError");
    const node = new FakeSourceNode(track);
    this.sources.push(node);
    return node;
  }
  createAnalyser(): AnalyserLike {
    const analyser = new FakeAnalyser(this.world);
    this.analysers.push(analyser);
    return analyser;
  }
  async resume(): Promise<void> {
    this.resumeCalls++;
    if (this.world.resumable && this.state !== "closed") this.setState("running");
  }
  async close(): Promise<void> {
    this.setState("closed");
  }
  setState(state: string): void {
    if (state === this.state) return;
    this.state = state;
    for (const listener of this.listeners) listener();
  }
  addEventListener(_type: "statechange", listener: () => void): void {
    this.listeners.add(listener);
  }
  removeEventListener(_type: "statechange", listener: () => void): void {
    this.listeners.delete(listener);
  }
  get listenerCount(): number {
    return this.listeners.size;
  }
}

const MIC_A = { deviceId: "mic-a", kind: "audioinput", label: "Mic A", groupId: "a" } as const;
const MIC_B = { deviceId: "mic-b", kind: "audioinput", label: "Mic B", groupId: "b" } as const;

interface Setup {
  world: World;
  devices: FakeMediaDevices;
  gestures: EventTarget;
  manager: VoqalizeMediaManager;
  levels: number[];
}

let setup: Setup | null = null;

function build(
  options: {
    releaseMicOnDisable?: boolean;
    createAudioContext?: null | (() => AudioContextLike);
  } = {},
): Setup {
  const world = new World();
  world.loudness.set("mic-a", 0.5);
  world.loudness.set("mic-b", 0.25);
  const devices = new FakeMediaDevices();
  devices.addDevice({ ...MIC_A });
  devices.addDevice({ ...MIC_B });
  const gestures = new EventTarget();
  const levels: number[] = [];
  const manager = new VoqalizeMediaManager({
    mediaDevices: devices,
    gestures,
    makeStream: (tracks) => new FakeMediaStream(tracks as FakeMediaStreamTrack[]),
    publishWatchdogMs: 0,
    createAudioContext:
      options.createAudioContext === undefined
        ? () => {
            const context = new FakeAudioContext(world);
            world.contexts.push(context);
            return context;
          }
        : options.createAudioContext,
    ...(options.releaseMicOnDisable === undefined
      ? {}
      : { releaseMicOnDisable: options.releaseMicOnDisable }),
  });
  manager.setClientOptions({
    enableMic: true,
    callbacks: { onLocalAudioLevel: (level) => levels.push(level) },
  });
  setup = { world, devices, gestures, manager, levels };
  return setup;
}

/** The track the meter is analysing: the newest source node's track, if its context is open. */
function measured(world: World): TrackLike | null {
  const context = world.current;
  if (!context || context.state === "closed") return null;
  return context.sources.at(-1)?.track ?? null;
}

/** Run the clock for `ticks` meter intervals and return what was emitted meanwhile. */
async function during(s: Setup, ticks: number): Promise<number[]> {
  const before = s.levels.length;
  await vi.advanceTimersByTimeAsync(ticks * TICK);
  return s.levels.slice(before);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  await setup?.manager.destroy();
  setup = null;
  vi.useRealTimers();
});

describe("onLocalAudioLevel", () => {
  it("starts with the microphone, before any call, once per interval", async () => {
    const s = build();
    await s.manager.initialize();
    const levels = await during(s, 5);
    expect(levels).toEqual([0.5, 0.5, 0.5, 0.5, 0.5]);
  });

  it("measures its own clone of the capture track, connected to no destination", async () => {
    const s = build();
    await s.manager.initialize();
    await s.manager.connect();
    const capture = s.manager.captureTracks().audio;
    const published = s.manager.tracks().local.audio as unknown as TrackLike;
    const branch = measured(s.world);
    expect(branch).not.toBeNull();
    expect(branch).not.toBe(capture);
    expect(branch).not.toBe(published);
    expect(branch?.getSettings().deviceId).toBe("mic-a");

    const context = s.world.current;
    expect(context?.sources.at(-1)?.connections).toEqual([context?.analysers[0]]);
    // The analyser is the end of the graph: nothing renders to a speaker.
    expect(context?.analysers[0]?.connections).toEqual([]);
    // Wide enough to cover a whole interval at this context's rate (48 kHz × 100 ms).
    expect(context?.analysers[0]?.fftSize).toBe(8192);
  });

  it("holds a peak and decays it by a quarter per interval, like WebRTC's audio_level", async () => {
    const s = build();
    await s.manager.initialize();
    // Binary fractions, so the analyser's float32 samples hold them exactly.
    s.world.loudness.set("mic-a", 0.75);
    expect(await during(s, 1)).toEqual([0.75]);
    s.world.loudness.set("mic-a", 0);
    expect(await during(s, 3)).toEqual([0.1875, 0.046875, 0.01171875]);
    s.world.loudness.set("mic-a", 0.375);
    expect(await during(s, 1)).toEqual([0.375]);
  });

  it("emits nothing while the mic is disabled and resumes when it is enabled", async () => {
    const s = build();
    await s.manager.initialize();
    await during(s, 2);
    const branch = measured(s.world);
    const firstContext = s.world.current;

    await s.manager.enableMic(false);
    expect(await during(s, 5)).toEqual([]);
    // Nothing is left listening to a muted user: the branch and the context are gone.
    expect(branch?.readyState).toBe("ended");
    expect(firstContext?.state).toBe("closed");
    // The capture track itself is held, as decision `releaseMicOnDisable: false` promises.
    expect(s.manager.captureTracks().audio?.readyState).toBe("live");

    await s.manager.enableMic(true);
    expect(await during(s, 2)).toEqual([0.5, 0.5]);
  });

  it("stops when a disable releases the device, and starts again on the new track", async () => {
    const s = build({ releaseMicOnDisable: true });
    await s.manager.initialize();
    await s.manager.enableMic(false);
    expect(s.manager.captureTracks().audio).toBeNull();
    expect(await during(s, 3)).toEqual([]);
    await s.manager.enableMic(true);
    expect(await during(s, 1)).toEqual([0.5]);
  });

  it("follows a device switch onto the new capture track", async () => {
    const s = build();
    await s.manager.initialize();
    expect(await during(s, 1)).toEqual([0.5]);
    const oldBranch = measured(s.world);

    await s.manager.updateMic("mic-b");
    expect(await during(s, 3)).toEqual([0.25, 0.25, 0.25]);
    expect(oldBranch?.readyState).toBe("ended");
    expect(measured(s.world)?.getSettings().deviceId).toBe("mic-b");
  });

  it("follows a device that vanished onto the one recovery acquires", async () => {
    const s = build();
    await s.manager.initialize();
    await s.manager.updateMic("mic-b");
    await during(s, 1);

    s.devices.hideDevice("mic-b");
    (s.manager.captureTracks().audio as FakeMediaStreamTrack).simulateDeviceEnded();
    await vi.advanceTimersByTimeAsync(0);
    expect(measured(s.world)?.getSettings().deviceId).toBe("mic-a");
    expect((await during(s, 2)).at(-1)).toBe(0.5);
  });

  it("is untouched by a reconnect: the same branch, the same context, no gap", async () => {
    const s = build();
    await s.manager.initialize();
    await s.manager.connect();
    const branch = measured(s.world);
    const context = s.world.current;

    // A rebuilt peer connection: connect() again mints new published clones.
    const before = s.manager.tracks().local.audio;
    await s.manager.connect();
    expect(s.manager.tracks().local.audio).not.toBe(before);
    expect(measured(s.world)).toBe(branch);
    expect(s.world.current).toBe(context);
    expect(await during(s, 3)).toEqual([0.5, 0.5, 0.5]);
  });

  it("tears everything down on disconnect: branch, context, timer and listeners", async () => {
    const s = build();
    await s.manager.initialize();
    await s.manager.connect();
    await during(s, 1);
    const branch = measured(s.world);
    const context = s.world.current;

    await s.manager.disconnect();
    expect(branch?.readyState).toBe("ended");
    expect(context?.state).toBe("closed");
    expect(context?.listenerCount).toBe(0);
    expect(await during(s, 5)).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("emits nothing while autoplay holds the context, and resumes on the next gesture", async () => {
    const s = build();
    s.world.initialState = "suspended";
    s.world.resumable = false;
    await s.manager.initialize();
    expect(await during(s, 3)).toEqual([]);
    expect(s.world.current?.resumeCalls).toBeGreaterThan(0);

    s.world.resumable = true;
    s.gestures.dispatchEvent(new Event("pointerdown"));
    await vi.advanceTimersByTimeAsync(0);
    expect(s.world.current?.state).toBe("running");
    expect(await during(s, 2)).toEqual([0.5, 0.5]);
  });

  it("degrades to silence where there is no AudioContext", async () => {
    const s = build({ createAudioContext: null });
    await s.manager.initialize();
    expect(s.manager.captureTracks().audio?.readyState).toBe("live");
    expect(await during(s, 3)).toEqual([]);
  });

  it("degrades to silence when the AudioContext cannot be built, and the mic still works", async () => {
    const factory = vi.fn((): AudioContextLike => {
      throw new DOMException("no audio hardware", "NotSupportedError");
    });
    const s = build({ createAudioContext: factory });
    await s.manager.initialize();
    await s.manager.connect();
    expect(s.manager.tracks().local.audio?.readyState).toBe("live");
    expect(await during(s, 3)).toEqual([]);
    // A broken engine is not retried on every mute and unmute.
    await s.manager.enableMic(false);
    await s.manager.enableMic(true);
    expect(factory).toHaveBeenCalledTimes(1);
  });
});

describe("browserAudioContextFactory", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is null where the engine has no AudioContext", () => {
    vi.stubGlobal("AudioContext", undefined);
    vi.stubGlobal("webkitAudioContext", undefined);
    expect(browserAudioContextFactory()).toBeNull();
  });

  it("asks for a context with no output device, and settles for any context", () => {
    const seen: unknown[] = [];
    class StubContext {
      constructor(options?: { sinkId?: unknown }) {
        seen.push(options);
        if (options?.sinkId) throw new DOMException("bad sink", "NotFoundError");
      }
    }
    vi.stubGlobal("AudioContext", StubContext);
    const context = browserAudioContextFactory()?.();
    expect(context).toBeInstanceOf(StubContext);
    expect(seen).toEqual([{ latencyHint: "playback", sinkId: { type: "none" } }, undefined]);
  });

  it("falls back to WebKit's prefixed constructor", () => {
    class Prefixed {}
    vi.stubGlobal("AudioContext", undefined);
    vi.stubGlobal("webkitAudioContext", Prefixed);
    expect(browserAudioContextFactory()?.()).toBeInstanceOf(Prefixed);
  });
});
