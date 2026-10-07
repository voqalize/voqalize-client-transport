/**
 * Keeping a call across page loads, against a stand-in for the members of
 * `SmallWebRTCTransport` it wraps. A page load is a new stand-in over the same
 * store. `e2e/factory.spec.ts` runs the same flow through a real transport.
 */
import { describe, expect, it } from "vitest";

import { keepCallAcrossPageLoads, type CallStore } from "../src/keepCall";

function memoryStore(): CallStore & { value: string | null } {
  return {
    value: null,
    read() {
      return this.value;
    },
    write(value) {
      this.value = value;
    },
    clear() {
      this.value = null;
    },
  };
}

/** What the wrapped members saw, in order. */
class StandIn {
  connects: unknown[] = [];
  stops: unknown[] = [];
  sent: unknown[] = [];
  _webrtcRequest: unknown = null;
  async _connect(params?: unknown): Promise<void> {
    this.connects.push(params);
  }
  async stop(error?: unknown): Promise<void> {
    this.stops.push(error);
  }
  sendMessage(message: unknown): void {
    this.sent.push(message);
  }
}

const request = () => ({
  webrtcRequestParams: {
    endpoint: "https://voice.example.com/webrtc",
    headers: new Headers({ authorization: "Bearer session-token" }),
    requestData: { page: "store" },
  },
  iceConfig: { iceServers: [{ urls: "stun:stun.example.com" }] },
});

function page(store: CallStore) {
  const transport = new StandIn();
  const hasLiveCall = keepCallAcrossPageLoads(transport, store);
  return { transport, hasLiveCall };
}

describe("keepCallAcrossPageLoads", () => {
  it("rejoins on the next page with the request the last one connected with", async () => {
    const store = memoryStore();
    const first = page(store);
    expect(first.hasLiveCall()).toBe(false);
    await first.transport._connect(request());
    expect(first.hasLiveCall()).toBe(true);

    const next = page(store);
    expect(next.hasLiveCall()).toBe(true);
    await next.transport._connect(undefined);
    const used = next.transport.connects[0] as ReturnType<typeof request>;
    expect(used.webrtcRequestParams.endpoint).toBe("https://voice.example.com/webrtc");
    expect(used.webrtcRequestParams.headers).toBeInstanceOf(Headers);
    expect(used.webrtcRequestParams.headers.get("authorization")).toBe("Bearer session-token");
    expect(used.webrtcRequestParams.requestData).toEqual({ page: "store" });
    expect(used.iceConfig).toEqual(request().iceConfig);
  });

  it("lets a request the app passes win, and remembers it instead", async () => {
    const store = memoryStore();
    await page(store).transport._connect(request());
    const next = page(store);
    const other = { webrtcRequestParams: { endpoint: "https://voice.example.com/other" } };
    await next.transport._connect(other);
    expect(next.transport.connects[0]).toBe(other);
    await page(store).transport._connect(undefined);
    expect(JSON.parse(store.value ?? "{}").webrtcRequestParams.endpoint).toBe(
      "https://voice.example.com/other",
    );
  });

  it("remembers a request given to the constructor", async () => {
    const store = memoryStore();
    const first = page(store);
    first.transport._webrtcRequest = { endpoint: new URL("https://voice.example.com/webrtc") };
    await first.transport._connect(undefined);
    expect(first.hasLiveCall()).toBe(true);
  });

  it("forgets the call on disconnectBot, and passes the message on", async () => {
    const store = memoryStore();
    const { transport, hasLiveCall } = page(store);
    await transport._connect(request());
    transport.sendMessage({ type: "client-ready" });
    expect(hasLiveCall()).toBe(true);
    transport.sendMessage({ type: "disconnect-bot", data: {} });
    expect(hasLiveCall()).toBe(false);
    expect(transport.sent).toHaveLength(2);
  });

  it("forgets the call when the server refuses an offer, not on other failures", async () => {
    const store = memoryStore();
    const { transport, hasLiveCall } = page(store);
    await transport._connect(request());
    await transport.stop();
    await transport.stop(Object.assign(new Error("Offer request failed"), { status: undefined }));
    await transport.stop(Object.assign(new Error("down"), { status: 503 }));
    expect(hasLiveCall()).toBe(true);
    await transport.stop(Object.assign(new Error("gone"), { status: 410 }));
    expect(hasLiveCall()).toBe(false);
    expect(transport.stops).toHaveLength(4);
  });

  it("never starts a call: connect() with nothing saved passes nothing on", async () => {
    const store = memoryStore();
    const { transport } = page(store);
    await transport._connect(undefined);
    expect(transport.connects).toEqual([undefined]);
    expect(store.value).toBeNull();
  });

  it("does not write down a Request endpoint, and drops what was saved", async () => {
    const store = memoryStore();
    await page(store).transport._connect(request());
    const { transport, hasLiveCall } = page(store);
    await transport._connect({
      webrtcRequestParams: { endpoint: new Request("https://voice.example.com/webrtc") },
    });
    expect(hasLiveCall()).toBe(false);
  });

  it("reads garbage in the store as no call", () => {
    const store = memoryStore();
    for (const raw of ["{", "null", "[]", '{"webrtcRequestParams":{"endpoint":3}}']) {
      store.value = raw;
      expect(page(store).hasLiveCall()).toBe(false);
    }
  });

  it("switches itself off when pipecat has no _connect to wrap", () => {
    const store = memoryStore();
    store.value = JSON.stringify({ webrtcRequestParams: { endpoint: "https://x.example.com" } });
    expect(keepCallAcrossPageLoads({}, store)()).toBe(false);
  });
});
