import { describe, expect, it, vi } from "vitest";
import {
  CallHealthStore,
  INITIAL_CONNECTION,
  classifyCaptureError,
  fixesFor,
  isInAppBrowser,
  rawError,
  traitsOf,
  type CallHealth,
  type CaptureEnvironment,
} from "../src/callHealth";

const INITIAL: CallHealth = {
  mic: { state: "off" },
  cam: { state: "off" },
  speaker: { state: "idle", device: null },
  screen: { state: "off" },
  connection: INITIAL_CONNECTION,
};

const env = (over: Partial<CaptureEnvironment> = {}): CaptureEnvironment => ({
  permission: "unknown",
  framePolicyBlocked: false,
  inAppBrowser: false,
  ...over,
});

const denial = (message = "Permission denied") =>
  Object.assign(new Error(message), { name: "NotAllowedError" });

describe("CallHealthStore", () => {
  it("calls a new listener at once with the current snapshot", () => {
    const store = new CallHealthStore(INITIAL);
    const seen: CallHealth[] = [];
    store.subscribe((h) => seen.push(h));
    expect(seen).toEqual([INITIAL]);
  });

  it("drops a patch that changes nothing, and freezes what it hands out", () => {
    const store = new CallHealthStore(INITIAL);
    const listener = vi.fn();
    store.subscribe(listener);
    store.update({ mic: { state: "off" } });
    expect(listener).toHaveBeenCalledTimes(1);
    store.update({ mic: { state: "asking" } });
    expect(listener).toHaveBeenCalledTimes(2);
    const snapshot = store.snapshot;
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.mic)).toBe(true);
    expect(Object.isFrozen(snapshot.connection.uplink)).toBe(true);
  });

  it("the same value written in another key order is not a change", () => {
    const store = new CallHealthStore(INITIAL);
    const listener = vi.fn();
    store.subscribe(listener);
    store.update({ connection: { uplink: "unknown", downlink: "unknown", state: "disconnected" } });
    expect(listener).toHaveBeenCalledTimes(1);
    store.update({ connection: { ...INITIAL_CONNECTION, uplink: "good" } });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("a throwing listener does not stop the others, and unsubscribe works", () => {
    vi.useFakeTimers();
    try {
      const store = new CallHealthStore(INITIAL);
      const good = vi.fn();
      store.subscribe(() => {
        throw new Error("app bug");
      });
      const off = store.subscribe(good);
      store.update({ mic: { state: "asking" } });
      expect(good).toHaveBeenCalledTimes(2);
      off();
      store.update({ mic: { state: "off" } });
      expect(good).toHaveBeenCalledTimes(2);
      expect(() => vi.runAllTimers()).toThrow("app bug");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("traitsOf", () => {
  it.each([
    ["Stereo Mix (Realtek(R) Audio)", ["loopback"]],
    ["CABLE Output (VB-Audio Virtual Cable)", ["loopback"]],
    ["BlackHole 2ch", ["loopback"]],
    ["NVIDIA Broadcast", ["virtual"]],
    ["OBS Virtual Camera", ["virtual"]],
    ["Headset (WH-1000XM4 Hands-Free AG Audio)", ["bluetooth-handsfree"]],
    ["LG ULTRAFINE (NVIDIA High Definition Audio)", ["display-audio"]],
    ["MacBook Pro Microphone", []],
    ["Steam Streaming Microphone", ["virtual"]],
    ["NoMachine Microphone Adapter", ["virtual"]],
    ["AirPods Pro", []],
    ["", []],
  ])("%s", (label, traits) => {
    expect(traitsOf(label)).toEqual(traits);
  });

  it.each([
    ["AirPods Pro", ["bluetooth-handsfree"]],
    ["Headset (AirPods Pro)", ["bluetooth-handsfree"]],
    ["Microphone (WH-1000XM4) (Bluetooth)", ["bluetooth-handsfree"]],
    ["Headset (WH-1000XM4 Hands-Free AG Audio)", ["bluetooth-handsfree"]],
    ["MacBook Pro Microphone", []],
  ])("as a mic: %s", (label, traits) => {
    expect(traitsOf(label, true)).toEqual(traits);
  });
});

describe("classifyCaptureError", () => {
  it("a frame policy block wins over every other reading", () => {
    const c = classifyCaptureError(
      denial(),
      "mic",
      env({ framePolicyBlocked: true, permission: "denied" }),
    );
    expect(c.problem).toEqual({ code: "blocked", by: "page" });
    expect(c.fixes).toEqual(["fix-page-embedding"]);
  });

  it("a system denial, or a denial while granted, is the operating system", () => {
    expect(
      classifyCaptureError(denial("Permission denied by system"), "mic", env()).problem,
    ).toEqual({
      code: "blocked",
      by: "os",
    });
    expect(classifyCaptureError(denial(), "cam", env({ permission: "granted" })).problem).toEqual({
      code: "blocked",
      by: "os",
    });
  });

  it("separates in-app browser, policy, dismissal, user and unknown", () => {
    const by = (e: Error, over: Partial<CaptureEnvironment>) =>
      classifyCaptureError(e, "mic", env(over)).problem;
    expect(by(denial(), { inAppBrowser: true, permission: "denied" })).toEqual({
      code: "blocked",
      by: "in-app-browser",
    });
    expect(by(denial("Blocked by enterprise policy"), {})).toEqual({
      code: "blocked",
      by: "policy",
    });
    expect(by(denial("Permission dismissed"), { permission: "prompt" })).toEqual({
      code: "prompt-dismissed",
    });
    expect(by(denial(), { permission: "denied" })).toEqual({ code: "blocked", by: "user" });
    expect(by(denial(), {})).toEqual({ code: "blocked", by: "unknown" });
  });

  it("maps the other DOMException names, and keeps the raw error", () => {
    const err = (name: string) => Object.assign(new Error("x"), { name });
    expect(classifyCaptureError(err("NotReadableError"), "mic", env()).problem.code).toBe(
      "already-in-use",
    );
    expect(classifyCaptureError(err("OverconstrainedError"), "mic", env()).problem.code).toBe(
      "not-found",
    );
    expect(classifyCaptureError(err("TypeError"), "mic", env()).problem.code).toBe("not-supported");
    expect(classifyCaptureError(err("Weird"), "mic", env())).toMatchObject({
      problem: { code: "unknown" },
      fixes: ["ask-again", "choose-another-device"],
    });
    expect(fixesFor({ code: "unknown" }, "screen")).toEqual([]);
    expect(classifyCaptureError(err("Weird"), "mic", env()).error).toEqual({
      name: "Weird",
      message: "x",
    });
  });

  it("reads the source error inside a pipecat DeviceError", () => {
    expect(rawError({ details: { sourceError: denial("inner") } })).toEqual({
      name: "NotAllowedError",
      message: "inner",
    });
  });
});

describe("fixesFor", () => {
  it("a silent camera is its shutter, a silent mic its hardware switch", () => {
    expect(fixesFor({ code: "no-signal" }, "cam")[0]).toBe("open-camera-shutter");
    // a virtual camera has no shutter: it is black until its app runs
    expect(fixesFor({ code: "no-signal" }, "cam", ["virtual"])).toEqual([
      "start-camera-app",
      "choose-another-device",
    ]);
    expect(fixesFor({ code: "no-signal" }, "mic")[0]).toBe("unmute-hardware");
  });
});

describe("fixesFor a screen", () => {
  it("offers no device fixes for a screen", () => {
    expect(fixesFor({ code: "not-found" }, "screen")).toEqual([]);
    expect(fixesFor({ code: "not-supported" }, "screen")).toEqual([]);
    expect(fixesFor({ code: "already-in-use" }, "screen")).toEqual(["close-other-apps"]);
    expect(fixesFor({ code: "blocked", by: "os" }, "screen")).toEqual(["allow-in-os-settings"]);
  });
});

describe("isInAppBrowser", () => {
  it.each([
    ["Mozilla/5.0 (iPhone) Mobile/15E148 Instagram 300.0", true],
    ["Mozilla/5.0 (Linux; Android 14; wv) Chrome/120 [FB_IAB/FB4A;FBAV/440.0]", true],
    // A bare WebView is some host app's own: "open in a browser" may not exist there.
    ["Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 Chrome/120 Mobile", false],
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131 Safari/537.36",
      false,
    ],
    [undefined, false],
  ])("%s", (ua, expected) => {
    expect(isInAppBrowser(ua)).toBe(expected);
  });
});
