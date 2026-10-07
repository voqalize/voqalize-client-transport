/**
 * The playout guard against the failure it was written for, replayed from the
 * Android Chrome measurements in `src/playoutGuard.ts`: the element's clock
 * runs, packets arrive, the samples played stand still, and about a second in
 * the element raises `error` and pauses itself. And against what it must never
 * do: fight the app, re-attach a healthy element, or spin.
 */
import { describe, expect, it } from "vitest";

import {
  PlayoutGuard,
  type PlayoutGuardOptions,
  type PlayoutRecoveryReason,
} from "../src/playoutGuard";
import type { StreamLike, TrackLike } from "../src/mediaPlatform";

/** The guard answers `error` one task later. */
const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0));

class FakeTrack {
  readonly label = "";
  enabled = true;
  contentHint = "";
  muted = false;
  readyState: MediaStreamTrackState = "live";
  constructor(
    readonly id: string,
    readonly kind: "audio" | "video" = "audio",
  ) {}
  stop(): void {
    this.readyState = "ended";
  }
  clone(): TrackLike {
    return new FakeTrack(`${this.id}-clone`, this.kind);
  }
  getSettings(): MediaTrackSettings {
    return {};
  }
  addEventListener(): void {}
  removeEventListener(): void {}
}

class FakeStream implements StreamLike {
  constructor(private readonly tracks: TrackLike[]) {}
  getTracks(): TrackLike[] {
    return this.tracks;
  }
  getAudioTracks(): TrackLike[] {
    return this.tracks.filter((t) => t.kind === "audio");
  }
  getVideoTracks(): TrackLike[] {
    return this.tracks.filter((t) => t.kind === "video");
  }
}

/**
 * The load algorithm as the engines measured it: a new source clears `error`
 * and leaves the element paused until `play()`, and `loadstart` is queued as a
 * task, never fired from inside the assignment (none at all for `null`).
 */
class FakeElement {
  paused = false;
  error: { code: number } | null = null;
  plays = 0;
  private source: unknown = null;
  private readonly listeners = new Map<string, Set<() => void>>();
  get srcObject(): unknown {
    return this.source;
  }
  set srcObject(value: unknown) {
    this.source = value;
    this.error = null;
    this.paused = true;
    if (value !== null) setTimeout(() => this.fire("loadstart"), 0);
  }
  async play(): Promise<void> {
    this.plays += 1;
    this.paused = false;
  }
  addEventListener(type: string, listener: () => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)?.add(listener);
  }
  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  fire(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
  /** What Chrome did at t≈1.0 s: `error` (code 3), then `pause`. */
  fail(code = 3): void {
    this.error = { code };
    this.fire("error");
    this.paused = true;
    this.fire("pause");
  }
}

class FakeReceiver {
  packets = 0;
  samples = 0;
  /** Engines that leave a counter out of `inbound-rtp`. */
  omit: "totalSamplesReceived" | "packetsReceived" | null = null;
  constructor(readonly trackId: string) {}
  report() {
    const stat: Record<string, unknown> = {
      type: "inbound-rtp",
      kind: "audio",
      trackIdentifier: this.trackId,
      packetsReceived: this.packets,
      totalSamplesReceived: this.samples,
    };
    if (this.omit) delete stat[this.omit];
    return { forEach: (cb: (s: Record<string, unknown>) => void) => cb(stat) };
  }
}

function setup(options: Partial<PlayoutGuardOptions> = {}) {
  let clock = 0;
  const track = new FakeTrack("agent");
  const element = new FakeElement();
  const receiver = new FakeReceiver(track.id);
  const recovered: Array<{ reason: PlayoutRecoveryReason; at: number }> = [];
  let connected = true;
  /** Runs inside the stats read, between the request and its answer. */
  let duringRead: (() => void) | null = null;
  const guard = new PlayoutGuard(element, {
    stats: () =>
      connected
        ? async () => {
            duringRead?.();
            return receiver.report();
          }
        : null,
    makeStream: (tracks) => new FakeStream(tracks),
    play: (el) => void el.play?.(),
    onRecovered: (reason) => recovered.push({ reason, at: clock }),
    // Driven by hand below.
    fastPollMs: 60_000,
    pollMs: 60_000,
    now: () => clock,
    ...options,
  });
  element.srcObject = new FakeStream([track]);
  void element.play();
  /** Advance by `ms` in 20 ms packets, playing them or not, ticking every 100 ms. */
  const run = async (ms: number, playing: boolean, packets = true) => {
    for (let t = 0; t < ms; t += 20) {
      clock += 20;
      if (packets) receiver.packets += 1;
      if (playing) receiver.samples += 960;
      if (clock % 100 === 0) await guard.check();
    }
  };
  return {
    guard,
    element,
    receiver,
    track,
    recovered,
    reasons: () => recovered.map((r) => r.reason),
    run,
    advance: (ms: number) => (clock += ms),
    now: () => clock,
    disconnect: () => (connected = false),
    duringRead: (hook: (() => void) | null) => (duringRead = hook),
  };
}

describe("PlayoutGuard", () => {
  it("re-attaches early when packets arrive and nothing is played", async () => {
    const { guard, element, track, recovered, run } = setup();
    const before = element.srcObject;
    await run(600, false);
    expect(recovered.map((r) => r.reason)).toEqual(["stalled"]);
    // The tight window: two still reads 120 ms apart, not the 300 ms after it.
    expect(recovered[0]!.at).toBeLessThanOrEqual(300);
    expect(element.srcObject).not.toBe(before);
    expect((element.srcObject as StreamLike).getAudioTracks()).toEqual([track]);
    expect(element.plays).toBe(2);
    guard.stop();
  });

  it("judges a stall loosely once the window has passed", async () => {
    const { guard, recovered, run, now } = setup();
    await run(3_000, true);
    const stoppedAt = now();
    await run(1_000, false);
    expect(recovered[0]?.reason).toBe("stalled");
    expect(recovered[0]!.at - stoppedAt).toBeGreaterThanOrEqual(300);
    guard.stop();
  });

  it("leaves a playing element alone", async () => {
    const { guard, reasons, run } = setup();
    await run(10_000, true);
    expect(reasons()).toEqual([]);
    guard.stop();
  });

  it("does not call silence a stall", async () => {
    const { guard, reasons, run } = setup();
    // No packets at all: the agent is quiet and the server sends nothing.
    await run(5_000, false, false);
    expect(reasons()).toEqual([]);
    guard.stop();
  });

  it("never un-pauses an element the app paused", async () => {
    const { guard, element, reasons, run } = setup();
    element.paused = true;
    await run(2_000, false);
    expect(reasons()).toEqual([]);
    expect(element.plays).toBe(1);
    guard.stop();
  });

  it("drops a read the app overtook with a pause", async () => {
    const { guard, element, reasons, run, duringRead } = setup();
    await run(200, false);
    duringRead(() => (element.paused = true));
    await run(1_000, false);
    expect(reasons()).toEqual([]);
    expect(element.plays).toBe(1);
    guard.stop();
  });

  it("re-attaches on the element's error, without stats", async () => {
    const { guard, element, reasons, disconnect } = setup();
    disconnect();
    element.fail();
    await nextTask();
    expect(reasons()).toEqual(["error"]);
    expect(element.paused).toBe(false);
    expect(element.plays).toBe(2);
    guard.stop();
  });

  it("leaves an error alone that the app answered, or that was an abort", async () => {
    const { guard, element, track, reasons } = setup();
    element.fail(1);
    await nextTask();
    element.fail();
    element.srcObject = new FakeStream([track]); // The app's own reload, same task.
    await nextTask();
    expect(reasons()).toEqual([]);
    guard.stop();
  });

  it("backs off between recoveries", async () => {
    const { guard, element, reasons, advance } = setup();
    element.fail();
    await nextTask();
    expect(reasons()).toEqual(["error"]);
    // Straight away again: held, not answered.
    element.fail();
    await nextTask();
    await guard.check();
    expect(reasons()).toEqual(["error"]);
    advance(500);
    await guard.check();
    expect(reasons()).toEqual(["error", "error"]);
    // And the wait doubles.
    element.fail();
    await nextTask();
    advance(500);
    await guard.check();
    expect(reasons()).toHaveLength(2);
    advance(500);
    await guard.check();
    expect(reasons()).toHaveLength(3);
    guard.stop();
  });

  it("stops after its budget; its own re-attach is not a new source, the app's is", async () => {
    const { guard, element, track, reasons } = setup({ backoffMs: 0 });
    for (let i = 0; i < 8; i += 1) {
      element.fail();
      await nextTask();
      await nextTask(); // Let the queued `loadstart` of each re-attach land.
    }
    expect(reasons()).toHaveLength(5);
    element.srcObject = new FakeStream([track]);
    element.fail();
    await nextTask();
    expect(reasons()).toHaveLength(6);
    guard.stop();
  });

  it("keeps a video track on the element it re-attaches", async () => {
    const { guard, element, track, disconnect } = setup();
    const video = new FakeTrack("camera", "video");
    element.srcObject = new FakeStream([track, video]);
    void element.play();
    disconnect();
    element.fail();
    await nextTask();
    expect((element.srcObject as StreamLike).getTracks()).toEqual([track, video]);
    guard.stop();
  });

  it("falls back to the error path when the stats lack a counter", async () => {
    for (const missing of ["totalSamplesReceived", "packetsReceived"] as const) {
      const { guard, element, receiver, reasons, run } = setup();
      receiver.omit = missing;
      await run(2_000, false);
      expect(reasons()).toEqual([]);
      element.fail();
      await nextTask();
      expect(reasons()).toEqual(["error"]);
      guard.stop();
    }
  });

  it("has nothing to re-attach once the track has ended", async () => {
    const { guard, element, reasons, track } = setup();
    track.stop();
    element.fail();
    await nextTask();
    expect(reasons()).toEqual([]);
    guard.stop();
  });

  it("does nothing once stopped, even for an error already raised", async () => {
    const { guard, element, reasons } = setup();
    element.fail();
    guard.stop();
    await nextTask();
    expect(reasons()).toEqual([]);
  });
});
