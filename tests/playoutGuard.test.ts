/**
 * The playout guard against the failure it was written for, replayed from the
 * Android Chrome measurements in `src/playoutGuard.ts`: the element's clock
 * runs, packets arrive, the samples played stand still, and about a second in
 * the element raises `error` and pauses itself.
 */
import { describe, expect, it } from "vitest";

/** The guard re-attaches on `error` one task later. */
const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0));

import { PlayoutGuard, type PlayoutRecoveryReason } from "../src/playoutGuard";
import type { StreamLike, TrackLike } from "../src/mediaPlatform";

class FakeTrack {
  readonly kind = "audio";
  readonly label = "";
  enabled = true;
  contentHint = "";
  muted = false;
  readyState: MediaStreamTrackState = "live";
  constructor(readonly id: string) {}
  stop(): void {
    this.readyState = "ended";
  }
  clone(): TrackLike {
    return new FakeTrack(`${this.id}-clone`);
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
    return this.tracks;
  }
  getVideoTracks(): TrackLike[] {
    return [];
  }
}

/** An element whose `srcObject` setter fires `loadstart`, as a real one does. */
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
    // The load algorithm: a new source leaves the element paused until play().
    this.source = value;
    this.error = null;
    this.paused = true;
    this.fire("loadstart");
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
  fail(): void {
    this.error = { code: 3 };
    this.fire("error");
    this.paused = true;
    this.fire("pause");
  }
}

class FakeReceiver {
  packets = 0;
  samples = 0;
  constructor(readonly trackId: string) {}
  report() {
    const stat: Record<string, unknown> = {
      type: "inbound-rtp",
      kind: "audio",
      trackIdentifier: this.trackId,
      packetsReceived: this.packets,
      totalSamplesReceived: this.samples,
    };
    return { forEach: (cb: (s: Record<string, unknown>) => void) => cb(stat) };
  }
}

function setup() {
  let clock = 0;
  const track = new FakeTrack("agent");
  const element = new FakeElement();
  const receiver = new FakeReceiver(track.id);
  const recovered: PlayoutRecoveryReason[] = [];
  let connected = true;
  const guard = new PlayoutGuard(element, {
    stats: () => (connected ? async () => receiver.report() : null),
    makeStream: (tracks) => new FakeStream(tracks),
    play: (el) => void el.play?.(),
    onRecovered: (reason) => recovered.push(reason),
    pollMs: 60_000, // driven by hand below
    now: () => clock,
  });
  element.srcObject = new FakeStream([track]);
  void element.play();
  /** Advance by `ms` in 20 ms packets, playing them or not, checking every 100 ms. */
  const run = async (ms: number, playing: boolean) => {
    for (let t = 0; t < ms; t += 20) {
      clock += 20;
      receiver.packets += 1;
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
    run,
    disconnect: () => (connected = false),
  };
}

describe("PlayoutGuard", () => {
  it("re-attaches when packets arrive and nothing is played", async () => {
    const { guard, element, recovered, run } = setup();
    const before = element.srcObject;
    await run(600, false);
    expect(recovered).toEqual(["stalled"]);
    expect(element.srcObject).not.toBe(before);
    expect((element.srcObject as StreamLike).getAudioTracks()[0]?.id).toBe("agent");
    expect(element.plays).toBe(2);
    guard.stop();
  });

  it("leaves a playing element alone", async () => {
    const { guard, recovered, run } = setup();
    await run(5_000, true);
    expect(recovered).toEqual([]);
    guard.stop();
  });

  it("does not call silence a stall", async () => {
    const { guard, receiver, recovered } = setup();
    // No packets at all: the agent is quiet and the server sends nothing.
    for (let i = 0; i < 50; i += 1) await guard.check();
    expect(receiver.packets).toBe(0);
    expect(recovered).toEqual([]);
    guard.stop();
  });

  it("never un-pauses an element the app paused", async () => {
    const { guard, element, recovered, run } = setup();
    element.paused = true;
    await run(2_000, false);
    expect(recovered).toEqual([]);
    expect(element.plays).toBe(1);
    guard.stop();
  });

  it("re-attaches on the element's error, without stats", async () => {
    const { guard, element, recovered, disconnect } = setup();
    disconnect();
    element.fail();
    await nextTask();
    expect(recovered).toEqual(["error"]);
    expect(element.paused).toBe(false);
    expect(element.plays).toBe(2);
    guard.stop();
  });

  it("stops after its budget, and a new source from the app renews it", async () => {
    const { guard, element, recovered, track } = setup();
    for (let i = 0; i < 8; i += 1) {
      element.fail();
      await nextTask();
    }
    expect(recovered).toHaveLength(5);
    element.srcObject = new FakeStream([track]);
    element.fail();
    await nextTask();
    expect(recovered).toHaveLength(6);
    guard.stop();
  });

  it("has nothing to re-attach once the track has ended", async () => {
    const { guard, element, recovered, track } = setup();
    track.stop();
    element.fail();
    await nextTask();
    expect(recovered).toEqual([]);
    guard.stop();
  });

  it("does nothing once stopped, even for an error already raised", async () => {
    const { guard, element, recovered } = setup();
    element.fail();
    guard.stop();
    await nextTask();
    expect(recovered).toEqual([]);
  });
});
