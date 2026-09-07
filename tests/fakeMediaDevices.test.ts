/**
 * Tier 1 smoke — proves the vitest setup runs, and that the fake platform
 * itself matches the real-browser semantics tier 2 measured. This is NOT
 * the audio-core contract suite (queue serialization, recovery, fallback)
 * — that's the next agent's work, built on top of this fake.
 */
import { describe, expect, it } from "vitest";
import { FakeMediaDevices, FakeMediaStreamTrack } from "../lab/fakeMediaDevices";

describe("vitest smoke", () => {
  it("runs", () => {
    expect(1 + 1).toBe(2);
  });
});

describe("FakeMediaStreamTrack", () => {
  it("stop() sets readyState to ended and does NOT fire ended", async () => {
    // Matches every engine measured in tier 2 (harness.spec.ts): a
    // locally-initiated stop is a silent transition. If this test and that
    // one ever disagree, the fake is wrong, not the browser.
    const track = new FakeMediaStreamTrack("audio", "Fake Mic");
    let fired = false;
    track.addEventListener("ended", () => {
      fired = true;
    });

    track.stop();

    expect(track.readyState).toBe("ended");
    // Give any (incorrectly) queued event a tick to land before asserting its absence.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fired).toBe(false);
  });

  it("simulateDeviceEnded() fires ended — the device-initiated case stop() must not resemble", () => {
    const track = new FakeMediaStreamTrack("video", "Fake Cam");
    let fired = false;
    track.addEventListener("ended", () => {
      fired = true;
    });

    track.simulateDeviceEnded();

    expect(track.readyState).toBe("ended");
    expect(fired).toBe(true);
  });

  it("simulateMute() / simulateUnmute() toggle muted and fire their events exactly once each", () => {
    const track = new FakeMediaStreamTrack("audio", "Fake Mic");
    const events: string[] = [];
    track.addEventListener("mute", () => events.push("mute"));
    track.addEventListener("unmute", () => events.push("unmute"));

    track.simulateMute();
    track.simulateMute(); // idempotent — already muted, no second event
    expect(track.muted).toBe(true);

    track.simulateUnmute();
    expect(track.muted).toBe(false);

    expect(events).toEqual(["mute", "unmute"]);
  });
});

describe("FakeMediaDevices", () => {
  it("enumerateDevices reflects addDevice/removeDevice and fires devicechange", async () => {
    const devices = new FakeMediaDevices();
    let changeCount = 0;
    devices.addEventListener("devicechange", () => changeCount++);

    devices.addDevice({ deviceId: "mic-1", kind: "audioinput", label: "Fake Mic", groupId: "g1" });
    expect(await devices.enumerateDevices()).toHaveLength(1);
    expect(changeCount).toBe(1);

    devices.removeDevice("mic-1");
    expect(await devices.enumerateDevices()).toHaveLength(0);
    expect(changeCount).toBe(2);
  });

  it("getUserMedia({audio:true}) resolves a live audio track from a registered device", async () => {
    const devices = new FakeMediaDevices();
    devices.addDevice({ deviceId: "mic-1", kind: "audioinput", label: "Fake Mic", groupId: "g1" });

    const stream = await devices.getUserMedia({ audio: true });

    expect(stream.getAudioTracks()).toHaveLength(1);
    expect(stream.getAudioTracks()[0]?.readyState).toBe("live");
  });

  it("getUserMedia rejects with NotFoundError when no matching device is registered", async () => {
    const devices = new FakeMediaDevices();
    await expect(devices.getUserMedia({ audio: true })).rejects.toMatchObject({
      name: "NotFoundError",
    });
  });

  it("rejectNextWith lets a test provoke a permission-denied style failure on demand", async () => {
    const devices = new FakeMediaDevices();
    devices.addDevice({ deviceId: "mic-1", kind: "audioinput", label: "Fake Mic", groupId: "g1" });
    devices.rejectNextWith(new DOMException("denied", "NotAllowedError"));

    await expect(devices.getUserMedia({ audio: true })).rejects.toMatchObject({
      name: "NotAllowedError",
    });
    // The rejection is one-shot — the retry succeeds.
    await expect(devices.getUserMedia({ audio: true })).resolves.toBeDefined();
  });
});
