/**
 * `CallHealth.connection` against a stand-in for the members of
 * `SmallWebRTCTransport` it reaches. The stand-in's state accessor, message
 * routing, ICE handling and data channel are the stock transport's (1.10.6),
 * trimmed to the lines that matter here.
 */
import { TransportWrapper } from "@pipecat-ai/client-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConnectionHealth, Signal } from "../src/callHealth";
import {
  DownlinkGrader,
  inboundAudio,
  trackConnectionHealth,
  type InboundAudioSample,
} from "../src/connectionHealth";
import { RUNTIME } from "./fixtures/runtimeMessages";

class FakeChannel extends EventTarget {
  sent: string[] = [];
  send(data: string) {
    this.sent.push(data);
  }
  open() {
    this.dispatchEvent(new Event("open"));
  }
}

class FakePc {
  iceConnectionState: RTCIceConnectionState = "new";
  connectionState: RTCPeerConnectionState = "new";
  stats: Record<string, unknown>[] = [];
  async getStats() {
    return { forEach: (fn: (s: Record<string, unknown>) => void) => this.stats.forEach(fn) };
  }
}

class StandIn {
  private _state = "disconnected";
  states: string[] = [];
  appMessages: unknown[] = [];
  rebuilds: boolean[] = [];
  disconnects = 0;
  pc: FakePc | null = null;
  channels: FakeChannel[] = [];
  _lastNegotiationError: { status?: number } | null = null;

  get state() {
    return this._state;
  }
  set state(state: string) {
    if (this._state === state) return;
    this._state = state;
    this.states.push(state);
  }

  handleMessage(message: string) {
    const parsed = JSON.parse(message) as { label?: string; type: string; data: unknown };
    if (parsed.label === "rtvi-ai") this.appMessages.push(parsed.data);
  }

  handleICEConnectionStateChange() {
    if (this.pc?.iceConnectionState === "failed") void this.attemptReconnection(true);
  }

  async attemptReconnection(recreate = false) {
    this.rebuilds.push(recreate);
  }

  createDataChannel(): FakeChannel {
    const channel = new FakeChannel();
    this.channels.push(channel);
    return channel;
  }

  async disconnect() {
    this.disconnects += 1;
    this.state = "disconnecting";
    this.state = "disconnected";
  }

  /** What pipecat's stop(error) does after an offer failed. */
  refuse(status: number) {
    this._lastNegotiationError = { status };
    this.state = "error";
    this._lastNegotiationError = null;
    this.state = "disconnected";
  }

  /** What `_connect` and the client do on a good first connect. */
  connect() {
    this.state = "connecting";
    this.pc = new FakePc();
    this.createDataChannel();
  }
  ice(state: RTCIceConnectionState) {
    if (!this.pc) return;
    this.pc.iceConnectionState = state;
    this.handleICEConnectionStateChange();
  }
  ready() {
    this.ice("connected");
    this.channels.at(-1)?.open();
    this.state = "connected";
    this.state = "ready";
  }
  server(data: Record<string, unknown>) {
    this.handleMessage(JSON.stringify({ label: "rtvi-ai", type: "server-message", data }));
  }
  runtime(message: string) {
    this.handleMessage(message);
  }
}

class Sink {
  connection: ConnectionHealth = { state: "disconnected", uplink: "unknown", downlink: "unknown" };
  log: string[] = [];
  server: Signal["server"][] = [];
  cam: Signal["server"][] = [];
  asking = false;
  _captureAsking() {
    return this.asking;
  }
  _setConnectionHealth(patch: Partial<ConnectionHealth>) {
    const next = { ...this.connection, ...patch };
    if (next.state !== "disconnected" || !("reason" in patch)) delete next.reason;
    const line = [next.state, next.reason].filter(Boolean).join(":");
    if (this.log.at(-1) !== line) this.log.push(line);
    this.connection = next;
  }
  _setServerSignal(server: Signal["server"], device: "mic" | "cam" = "mic") {
    (device === "cam" ? this.cam : this.server).push(server);
  }
}

let t: StandIn;
let sink: Sink;

beforeEach(() => {
  vi.useFakeTimers();
  t = new StandIn();
  sink = new Sink();
  trackConnectionHealth(t, sink, { unreachableMs: 1000, downlinkSampleMs: 100 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("connection state", () => {
  it("connecting, then connected at ready, then ended", async () => {
    t.connect();
    expect(sink.connection.state).toBe("connecting");
    t.ready();
    expect(sink.connection.state).toBe("connected");
    await t.disconnect();
    expect(sink.log).toEqual(["connecting", "connected", "disconnected:ended"]);
  });

  it("nothing is reported before the first connect", () => {
    t.state = "initializing";
    t.state = "initialized";
    expect(sink.log).toEqual([]);
  });

  it("no media path within the bound is unreachable, and the transport is stopped", async () => {
    t.connect();
    await vi.advanceTimersByTimeAsync(1000);
    expect(sink.log).toEqual(["connecting", "disconnected:unreachable"]);
    expect(t.disconnects).toBe(1);
    expect(t.state).toBe("disconnected");
  });

  it("an open permission prompt holds off unreachable, which counts again once it is answered", async () => {
    sink.asking = true;
    t.connect();
    await vi.advanceTimersByTimeAsync(2500);
    expect(sink.connection.state).toBe("connecting");
    sink.asking = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(sink.log).toEqual(["connecting", "disconnected:unreachable"]);
  });

  it("a path that formed holds off unreachable while the agent gets ready", async () => {
    t.connect();
    t.ice("connected");
    await vi.advanceTimersByTimeAsync(5000);
    expect(sink.connection.state).toBe("connecting");
    expect(t.disconnects).toBe(0);
  });

  it("ICE failing before the call was ever up is unreachable at once, with no retry", () => {
    t.connect();
    t.ice("failed");
    expect(sink.log).toEqual(["connecting", "disconnected:unreachable"]);
    expect(t.rebuilds).toEqual([]);
  });

  it("an offer the server answers with a 4xx is refused, not unreachable", async () => {
    t.connect();
    t.refuse(401);
    expect(sink.log).toEqual(["connecting", "disconnected:refused"]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(sink.log.at(-1)).toBe("disconnected:refused");
    expect(t.disconnects).toBe(0);
  });

  it("a rejoin the server refuses mid-call is refused too", () => {
    t.connect();
    t.ready();
    t.ice("disconnected");
    t.refuse(410);
    expect(sink.log.at(-1)).toBe("disconnected:refused");
  });

  it("a refused call is forgotten on the next connect", () => {
    t.connect();
    t.refuse(403);
    t.connect();
    t.ready();
    expect(sink.log.at(-1)).toBe("connected");
  });

  it("losing the path mid-call is reconnecting, and a new path is connected again", async () => {
    t.connect();
    t.ready();
    t.ice("disconnected");
    expect(sink.connection.state).toBe("reconnecting");
    // reconnect.ts rebuilds; the new connection comes up.
    t.pc = new FakePc();
    t.ice("connected");
    expect(sink.log).toEqual(["connecting", "connected", "reconnecting", "connected"]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(sink.connection.state).toBe("connected");
  });

  it("ICE failing mid-call is pipecat's rebuild, reported as reconnecting", () => {
    t.connect();
    t.ready();
    t.ice("failed");
    expect(t.rebuilds).toEqual([true]);
    expect(sink.connection.state).toBe("reconnecting");
  });

  it("a rebuild that never finds a path is unreachable after the bound", async () => {
    t.connect();
    t.ready();
    void t.attemptReconnection(true);
    expect(sink.connection.state).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(1000);
    expect(sink.log.at(-1)).toBe("disconnected:unreachable");
  });

  it("a server renegotiation is not an outage", () => {
    t.connect();
    t.ready();
    void t.attemptReconnection(false);
    expect(sink.connection.state).toBe("connected");
  });

  it("pipecat giving up after its retries is unreachable", () => {
    t.connect();
    t.ready();
    t.ice("disconnected");
    t.state = "error";
    expect(sink.log.at(-1)).toBe("disconnected:unreachable");
  });

  it("an error with a path up and no outage is ended", () => {
    t.connect();
    t.ready();
    t.state = "error";
    expect(sink.log.at(-1)).toBe("disconnected:ended");
  });

  it("a new connect clears an earlier unreachable", () => {
    t.connect();
    t.ice("failed");
    t.connect();
    expect(sink.connection.state).toBe("connecting");
    expect(sink.connection.reason).toBeUndefined();
  });
});

describe("the voice runtime's messages", () => {
  it("sends the voice runtime nothing", () => {
    t.connect();
    t.ready();
    expect(t.channels[0]!.sent).toEqual([]);
  });

  it("caller-audio becomes the server signal and never reaches the app", () => {
    t.connect();
    t.ready();
    t.runtime(RUNTIME.callerAudio.ok);
    t.runtime(RUNTIME.callerAudio.silent);
    t.runtime(RUNTIME.callerAudio.none);
    expect(sink.server).toEqual(["sound", "silent", "none"]);
    expect(t.appMessages).toEqual([]);
  });

  it("caller-video becomes the camera's server signal and never reaches the app", () => {
    t.connect();
    t.ready();
    t.runtime(RUNTIME.callerVideo.ok);
    t.runtime(RUNTIME.callerVideo.black);
    t.runtime(RUNTIME.callerVideo.none);
    expect(sink.cam).toEqual(["sound", "silent", "none"]);
    expect(sink.server).toEqual([]);
    expect(t.appMessages).toEqual([]);
  });

  it("network-quality is the uplink, never reaches the app, and is unknown in an outage", () => {
    t.connect();
    t.ready();
    t.runtime(RUNTIME.networkQuality.good);
    expect(sink.connection.uplink).toBe("good");
    t.runtime(RUNTIME.networkQuality.poor);
    expect(sink.connection.uplink).toBe("poor");
    expect(t.appMessages).toEqual([]);
    t.ice("disconnected");
    expect(sink.connection.uplink).toBe("unknown");
  });

  it("tracks a transport once, however it arrives", () => {
    // pipecat's client hands out `client.transport` as a Proxy over the
    // transport the page built. A second watcher installed through it would
    // consume the voice runtime's messages before the first, which would then publish its
    // downlink with uplink unknown.
    const second = new Sink();
    trackConnectionHealth(new TransportWrapper(t as never).proxy as unknown as object, second);
    t.connect();
    t.ready();
    t.runtime(RUNTIME.networkQuality.good);
    expect(sink.connection.uplink).toBe("good");
    expect(second.log).toEqual([]);
  });

  it("the old rtvi-ai network-quality is the app's and not the uplink", () => {
    t.connect();
    t.ready();
    t.server({ type: "network-quality", quality: "poor" });
    expect(sink.connection.uplink).toBe("unknown");
    expect(t.appMessages).toEqual([{ type: "network-quality", quality: "poor" }]);
  });

  it("drops what it does not understand under the label, and passes nothing on", () => {
    t.connect();
    t.ready();
    t.runtime(`{"label":"voqalize","type":"something-new","data":{"x":1}}`);
    t.runtime(`{"label":"voqalize","type":"caller-audio","data":{"audio":"crackly"}}`);
    t.runtime(`{"label":"voqalize","type":"network-quality","data":{"quality":"superb"}}`);
    t.runtime(`{"label":"voqalize","type":"caller-audio"}`);
    t.runtime(`{"label":"voqalize","type":"caller-video","data":{"video":"grainy"}}`);
    expect(sink.server).toEqual([]);
    expect(sink.cam).toEqual([]);
    expect(sink.connection.uplink).toBe("unknown");
    expect(t.appMessages).toEqual([]);
  });

  it("ignores the voice runtime's word before the call is ready", () => {
    t.connect();
    t.runtime(RUNTIME.callerAudio.silent);
    t.runtime(RUNTIME.callerVideo.black);
    t.runtime(RUNTIME.networkQuality.bad);
    expect(sink.server).toEqual([]);
    expect(sink.cam).toEqual([]);
    expect(sink.connection.uplink).toBe("unknown");
  });

  it("every other message passes through untouched", () => {
    t.connect();
    t.ready();
    t.server({ type: "something-else" });
    t.handleMessage(JSON.stringify({ label: "rtvi-ai", type: "bot-ready", data: {} }));
    expect(t.appMessages).toEqual([{ type: "something-else" }, {}]);
  });
});

describe("downlink", () => {
  const sample = (over: Partial<InboundAudioSample>): InboundAudioSample => ({
    packetsReceived: 0,
    packetsLost: 0,
    concealedSamples: 0,
    totalSamplesReceived: 0,
    jitter: 0.005,
    ...over,
  });

  it("is graded off the peer connection's stats while connected", async () => {
    t.connect();
    t.ready();
    const pc = t.pc!;
    let received = 0;
    let lost = 0;
    let total = 0;
    const tick = async (losing: number) => {
      received += 100;
      lost += losing;
      total += 96_000;
      pc.stats = [
        {
          type: "inbound-rtp",
          kind: "audio",
          ...sample({ packetsReceived: received, packetsLost: lost, totalSamplesReceived: total }),
        },
      ];
      await vi.advanceTimersByTimeAsync(100);
    };
    await tick(0);
    await tick(0);
    await tick(0);
    expect(sink.connection.downlink).toBe("good");
    await tick(50);
    // A reading is graded once the stream is seen to go on.
    await tick(0);
    expect(sink.connection.downlink).toBe("bad");
  });

  // Chrome's figures from a local call over loopback: two sentences, the
  // pause after each concealed as silence, and the fade at each sentence's
  // end concealed with sound.
  const chrome = (packetsReceived: number, concealed: number, silent: number, total: number) =>
    inboundAudio(
      new Map([
        [
          "in",
          {
            type: "inbound-rtp",
            kind: "audio",
            packetsReceived,
            packetsLost: 0,
            jitter: 0,
            concealedSamples: concealed,
            silentConcealedSamples: silent,
            totalSamplesReceived: total,
          },
        ],
      ]) as unknown as RTCStatsReport,
    )!;

  it("a sentence's end and the pause after it are not the network's", () => {
    const g = new DownlinkGrader();
    g.push(chrome(100, 0, 0, 48_000));
    g.push(chrome(150, 0, 0, 96_000));
    g.push(chrome(200, 0, 0, 144_000));
    expect(g.grade).toBe("good");
    // The sentence ends: its fade, then the pause.
    g.push(chrome(213, 1_598, 0, 192_000));
    g.push(chrome(213, 49_598, 48_000, 240_000));
    g.push(chrome(213, 97_598, 96_000, 288_000));
    // The next sentence, which ends the same way.
    g.push(chrome(263, 97_598, 96_000, 336_000));
    g.push(chrome(270, 99_196, 96_000, 384_000));
    g.push(chrome(270, 147_196, 144_000, 432_000));
    g.push(chrome(320, 147_196, 144_000, 480_000));
    g.push(chrome(370, 147_196, 144_000, 528_000));
    expect(g.grade).toBe("good");
  });

  it("concealment with sound while the stream goes on is the network's", () => {
    const g = new DownlinkGrader();
    g.push(chrome(100, 0, 0, 48_000));
    g.push(chrome(150, 0, 0, 96_000));
    g.push(chrome(200, 0, 0, 144_000));
    expect(g.grade).toBe("good");
    // 4,800 of a reading's 48,000 samples made up with sound, mid-stream.
    g.push(chrome(250, 4_800, 0, 192_000));
    g.push(chrome(300, 4_800, 0, 240_000));
    expect(g.grade).toBe("poor");
  });

  it("recovery is one step at a time", () => {
    const g = new DownlinkGrader();
    let n = 0;
    let lost = 0;
    const push = (losing: number) => {
      n += 100;
      lost += losing;
      g.push(sample({ packetsReceived: n, packetsLost: lost }));
    };
    push(0);
    push(0);
    push(50);
    push(0);
    expect(g.grade).toBe("bad");
    for (let i = 0; i < DownlinkGrader.WINDOW + DownlinkGrader.RECOVER - 1; i++) push(0);
    expect(g.grade).toBe("poor");
  });
});

describe("on the real transport", () => {
  it("installs through client-js's proxy on SmallWebRTCTransport, and reads its state", async () => {
    const { SmallWebRTCTransport } = await import("@pipecat-ai/small-webrtc-transport");
    const { TransportWrapper } = await import("@pipecat-ai/client-js");
    // Any manager: the default one needs a real browser to construct.
    const real = new SmallWebRTCTransport({ mediaManager: {} as never });
    const proxied = new TransportWrapper(real as never).proxy as unknown as object;
    const s = new Sink();
    trackConnectionHealth(proxied, s);
    const internals = real as unknown as {
      state: string;
      handleMessage(m: string): void;
      _callbacks: object;
      _onMessage: (m: unknown) => void;
    };
    // What initialize() sets.
    internals._callbacks = {};
    const app: unknown[] = [];
    internals._onMessage = (m) => app.push(m);
    internals.state = "connecting";
    expect(s.connection.state).toBe("connecting");
    expect(internals.state).toBe("connecting");
    internals.handleMessage(RUNTIME.callerAudio.ok);
    expect(s.server).toEqual([]); // not ready yet: ignored, and still not the app's
    internals.state = "ready";
    internals.handleMessage(RUNTIME.callerAudio.ok);
    expect(s.server).toEqual(["sound"]);
    expect(app).toEqual([]);
    internals.handleMessage(RUNTIME.networkQuality.poor);
    expect(s.connection.uplink).toBe("poor");
    expect(app).toEqual([]);
    // A message that goes on to pipecat's own handler. Read through the
    // proxy, the stock handler is a forwarder back to the wrapper: this
    // recursed until the methods were read by descriptor.
    internals.handleMessage(
      JSON.stringify({ label: "rtvi-ai", type: "server-message", data: { type: "app-thing" } }),
    );
    expect(app).toHaveLength(1);
    internals.state = "disconnected";
    expect(s.connection).toMatchObject({ state: "disconnected", reason: "ended" });
  });
});
