/**
 * The reconnect fixes, against a stand-in for the members of
 * `SmallWebRTCTransport` they reach. The stand-in's track and ICE handling is
 * the stock transport's (1.10.7), trimmed to the lines that matter here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DISCONNECTED_GRACE_MS,
  reconnectOnNetworkChange,
  type NetworkWatch,
} from "../src/reconnect";

class FakeTrack extends EventTarget {
  readyState: "live" | "ended" = "live";
  end() {
    this.readyState = "ended";
    this.dispatchEvent(new Event("ended"));
  }
  unmute() {
    this.dispatchEvent(new Event("unmute"));
  }
}

class FakePc {
  connectionState: RTCPeerConnectionState = "connected";
  iceConnectionState: RTCIceConnectionState = "connected";
}

class StandIn {
  _incomingTracks = new Map<string, { track: FakeTrack }>();
  pc: FakePc | null = new FakePc();
  started: FakeTrack[] = [];
  rebuilds: boolean[] = [];

  /** The stock `ontrack` body for one remote audio track. */
  receive(track: FakeTrack) {
    this._incomingTracks.set("microphone", { track });
    track.addEventListener("unmute", () => {
      if (!this._incomingTracks.get("microphone")) return;
      this.started.push(track);
    });
    track.addEventListener("ended", () => {
      this._incomingTracks.delete("microphone");
    });
  }

  handleICEConnectionStateChange() {
    if (!this.pc) return;
    if (this.pc.iceConnectionState === "failed") void this.attemptReconnection(true);
    else if (this.pc.iceConnectionState === "disconnected")
      setTimeout(() => {
        if (this.pc?.iceConnectionState === "disconnected") void this.attemptReconnection(true);
      }, 5000);
  }

  async attemptReconnection(recreate = false): Promise<void> {
    this.rebuilds.push(recreate);
  }

  ice(state: RTCIceConnectionState) {
    this.pc!.iceConnectionState = state;
    this.handleICEConnectionStateChange();
  }
}

function fakeNetwork(): NetworkWatch & { move(): void; isOffline: boolean; listeners: number } {
  const subscribers = new Set<() => void>();
  return {
    isOffline: false,
    get listeners() {
      return subscribers.size;
    },
    offline() {
      return this.isOffline;
    },
    subscribe(onMoved) {
      subscribers.add(onMoved);
      return () => subscribers.delete(onMoved);
    },
    move() {
      for (const s of [...subscribers]) s();
    },
  };
}

describe("a rebuilt connection's audio", () => {
  /** The stock order: the new track is filed, then the old connection closes. */
  function rebuild(t: StandIn) {
    const old = t._incomingTracks.get("microphone")!.track;
    const next = new FakeTrack();
    t.receive(next);
    old.end();
    next.unmute();
    return next;
  }

  it("is lost on the stock transport", () => {
    const t = new StandIn();
    t.receive(new FakeTrack());
    const next = rebuild(t);
    expect(t.started).not.toContain(next);
  });

  it("starts with the fix", () => {
    const t = new StandIn();
    reconnectOnNetworkChange(t, null);
    t.receive(new FakeTrack());
    const next = rebuild(t);
    expect(t.started).toEqual([next]);
    expect(t._incomingTracks.get("microphone")?.track).toBe(next);
  });

  it("still lets an ended track drop its own lane", () => {
    const t = new StandIn();
    reconnectOnNetworkChange(t, null);
    const only = new FakeTrack();
    t.receive(only);
    only.end();
    expect(t._incomingTracks.has("microphone")).toBe(false);
  });
});

describe("noticing a dead path", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("rebuilds after the short grace, not five seconds", () => {
    const t = new StandIn();
    reconnectOnNetworkChange(t, null);
    t.ice("disconnected");
    vi.advanceTimersByTime(DISCONNECTED_GRACE_MS - 1);
    expect(t.rebuilds).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(t.rebuilds).toEqual([true]);
    vi.advanceTimersByTime(10_000);
    expect(t.rebuilds).toEqual([true]);
  });

  it("leaves a connection that recovered by itself", () => {
    const t = new StandIn();
    reconnectOnNetworkChange(t, null);
    t.ice("disconnected");
    t.ice("connected");
    vi.advanceTimersByTime(10_000);
    expect(t.rebuilds).toEqual([]);
  });

  it("leaves a connection that was already replaced", () => {
    const t = new StandIn();
    reconnectOnNetworkChange(t, null);
    t.ice("disconnected");
    t.pc = new FakePc();
    t.pc.iceConnectionState = "disconnected";
    vi.advanceTimersByTime(DISCONNECTED_GRACE_MS);
    expect(t.rebuilds).toEqual([]);
  });

  it("keeps the stock handling of failed", () => {
    const t = new StandIn();
    reconnectOnNetworkChange(t, null);
    t.ice("failed");
    expect(t.rebuilds).toEqual([true]);
  });

  it("waits out an offline browser", () => {
    const t = new StandIn();
    const network = fakeNetwork();
    network.isOffline = true;
    reconnectOnNetworkChange(t, network);
    t.ice("disconnected");
    vi.advanceTimersByTime(DISCONNECTED_GRACE_MS);
    expect(t.rebuilds).toEqual([]);
  });
});

describe("a network move", () => {
  it("rebuilds a live call at once", () => {
    const t = new StandIn();
    const network = fakeNetwork();
    reconnectOnNetworkChange(t, network);
    network.move();
    expect(t.rebuilds).toEqual([true]);
  });

  it("leaves a call that is not up yet, or is over", () => {
    const t = new StandIn();
    const network = fakeNetwork();
    reconnectOnNetworkChange(t, network);
    t.pc!.connectionState = "connecting";
    network.move();
    t.pc!.connectionState = "closed";
    network.move();
    t.pc = null;
    network.move();
    expect(t.rebuilds).toEqual([]);
  });

  it("does nothing while offline", () => {
    const t = new StandIn();
    const network = fakeNetwork();
    network.isOffline = true;
    reconnectOnNetworkChange(t, network);
    network.move();
    expect(t.rebuilds).toEqual([]);
  });

  it("installs once per transport", () => {
    const t = new StandIn();
    const network = fakeNetwork();
    reconnectOnNetworkChange(t, network);
    reconnectOnNetworkChange(t, network);
    expect(network.listeners).toBe(1);
    network.move();
    expect(t.rebuilds).toEqual([true]);
  });
});

describe("a transport without the members", () => {
  it("is left as it was", () => {
    const bare = {};
    expect(() => reconnectOnNetworkChange(bare, fakeNetwork())).not.toThrow();
    expect(bare).toEqual({});
  });
});
