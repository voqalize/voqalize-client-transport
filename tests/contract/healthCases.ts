/**
 * CallHealth's contract: what `onCallHealthChanged` says, in order, for each
 * thing that goes wrong with a device. Most cases need the scripted world
 * (levels, pictures, permissions), which only tier 1 has; the ones a real
 * browser can stage run in the real browsers too.
 *
 * Health lines read `part:state[:detail]` — see `describeHealthPart` in
 * `lab/lab.ts`.
 */
import type { LabApi } from "../../lab/labApi";
import type { ContractCase } from "./cases";
import {
  deepEqual,
  equal,
  excludes,
  includes,
  notOk,
  ok,
  rejects,
  sleep,
  stayFalse,
  waitFor,
} from "./assert";

const SCRIPTED = { scriptedHealth: true } as const;

async function gumCount(lab: LabApi): Promise<number> {
  return (await lab.gumCalls()).length;
}

export const HEALTH_CASES: ContractCase[] = [
  {
    name: "health: subscribed before initialize, the mic goes starting then live before connect",
    requires: ["scriptedHealth"],
    reset: SCRIPTED,
    async run({ lab }) {
      deepEqual(await lab.healthLog(), [
        "mic:off",
        "cam:off",
        "speaker:idle",
        "screen:off",
        "connection:disconnected",
      ]);
      await lab.initialize();
      await lab.waitForHealth("mic", "live:sound");
      deepEqual(await lab.healthLog("mic"), ["mic:off", "mic:starting", "mic:live:sound"]);
      const health = await lab.health();
      equal(health.connection.state, "disconnected", "no connect() was called");
      ok(health.mic.state === "live" && health.mic.device.deviceId !== "", "names the device");
    },
  },

  {
    name: "health: in a real browser the mic is live before connect",
    tiers: ["browser"],
    async run({ lab, note }) {
      await lab.initialize();
      await waitFor(async () => (await lab.health()).mic.state === "live", {
        timeout: 5000,
        message: "mic never went live",
      });
      const mic = (await lab.health()).mic;
      if (mic.state === "live") note(`mic before connect: local=${mic.signal.local}`);
    },
  },

  {
    name: "health: a dead mic at join is reopened once, then failed no-signal",
    requires: ["scriptedHealth"],
    reset: SCRIPTED,
    async run({ lab }) {
      await lab.setInputLevel("*", 0);
      await lab.initialize();
      await lab.waitForHealth("mic", "failed:no-signal");
      deepEqual(await lab.healthLog("mic"), [
        "mic:off",
        "mic:starting",
        "mic:recovering:no-signal",
        "mic:failed:no-signal",
      ]);
      equal(await gumCount(lab), 2, "exactly one reopen");
      const mic = (await lab.health()).mic;
      ok(mic.state === "failed");
      if (mic.state === "failed") includes(mic.fixes, "unmute-hardware");
      equal((await lab.deviceErrors()).length, 0, "silence is not a DeviceError");

      // Sound after all (a hardware mute switched off) is simply live.
      await lab.setInputLevel("*", 0.2);
      await lab.waitForHealth("mic", "live:sound");
    },
  },

  {
    name: "health: a dead mic that the reopen fixes reports how it recovered",
    requires: ["scriptedHealth"],
    reset: SCRIPTED,
    async run({ lab }) {
      await lab.setInputLevel("*", 0);
      await lab.initialize();
      await lab.waitForHealth("mic", "recovering:no-signal");
      await lab.setInputLevel("*", 0.2);
      await lab.waitForHealth("mic", "live:sound:recovered-from-no-signal");
      excludes(await lab.healthLog("mic"), "mic:failed:no-signal");
    },
  },

  {
    name: "health: a mic that goes silent mid-call is degraded, and sound brings it back",
    requires: ["scriptedHealth"],
    reset: SCRIPTED,
    async run({ lab }) {
      await lab.initialize();
      await lab.waitForHealth("mic", "live:sound");
      await sleep(500); // long enough to count as heard, not a click
      await lab.setInputLevel("*", 0);
      await lab.waitForHealth("mic", "degraded:no-signal");
      equal(await gumCount(lab), 1, "a mid-call silence is reported, not reopened");
      await lab.clearHealthLog();
      await lab.setInputLevel("*", 0.2);
      await lab.waitForHealth("mic", "live:sound");
    },
  },

  {
    name: "health: a click from a dead mic is not a voice, so its silence is still reopened",
    requires: ["scriptedHealth"],
    reset: SCRIPTED,
    async run({ lab }) {
      await lab.setInputLevel("*", 0);
      await lab.initialize();
      await sleep(300);
      await lab.setInputLevel("*", 0.2);
      await sleep(120);
      await lab.setInputLevel("*", 0);
      await lab.waitForHealth("mic", "recovering:no-signal");
      excludes(await lab.healthLog("mic"), "mic:degraded:no-signal");
    },
  },

  {
    name: "health: digital silence at the voice runtime while this browser hears the mic is not acted on",
    requires: ["scriptedHealth"],
    reset: SCRIPTED,
    async run({ lab }) {
      await lab.initialize();
      await lab.waitForHealth("mic", "live:sound");
      await sleep(500);
      await lab.clearHealthLog();
      await lab.setServerSignal("silent");
      await sleep(300);
      deepEqual(await lab.healthLog("mic"), [], "the page's own reading wins");
      equal(await gumCount(lab), 1);
    },
  },

  {
    name: "health: clicks from a failed mic do not bring it back; a voice does",
    requires: ["scriptedHealth"],
    reset: SCRIPTED,
    async run({ lab }) {
      await lab.setInputLevel("*", 0);
      await lab.initialize();
      await lab.waitForHealth("mic", "failed:no-signal");
      await lab.clearHealthLog();
      // Clicks further apart than `heardGapMs` (the default, 1 s): sound with
      // shorter gaps is a run of speech, and a run is a voice.
      for (let i = 0; i < 2; i += 1) {
        await lab.setInputLevel("*", 0.2);
        await sleep(40);
        await lab.setInputLevel("*", 0);
        await sleep(1100);
      }
      deepEqual(await lab.healthLog("mic"), [], "a click is not a voice");
      await lab.setInputLevel("*", 0.2);
      await lab.waitForHealth("mic", "live:sound");
    },
  },

  {
    name: "health: where the page cannot measure, the voice runtime's silent reopens the mic and its none does not",
    requires: ["scriptedHealth"],
    reset: { ...SCRIPTED, unmeasuredMic: true },
    async run({ lab }) {
      await lab.initialize();
      await lab.waitForHealth("mic", "live:unmeasured");
      await sleep(300); // past the join window
      await lab.clearHealthLog();
      await lab.setServerSignal("none");
      await sleep(200);
      deepEqual(await lab.healthLog("mic"), [], "no packets is the network's to report");
      equal(await gumCount(lab), 1);
      await lab.setServerSignal("silent");
      await lab.waitForHealth("mic", "recovering:no-signal");
    },
  },

  {
    name: "health: no packets at the voice runtime while this browser hears sound is the network's to report",
    requires: ["scriptedHealth"],
    reset: SCRIPTED,
    async run({ lab }) {
      await lab.initialize();
      await lab.waitForHealth("mic", "live:sound");
      await sleep(500);
      await lab.clearHealthLog();
      await lab.setServerSignal("none");
      await sleep(300);
      excludes(await lab.healthLog("mic"), "mic:degraded:no-signal");
    },
  },

  {
    name: "health: a quiet room is not silence",
    requires: ["scriptedHealth"],
    reset: SCRIPTED,
    async run({ lab }) {
      // -70 dBFS: far below speech, far above one least-significant bit.
      await lab.setInputLevel("*", 0.0003);
      await lab.initialize();
      await lab.waitForHealth("mic", "live:sound");
      await sleep(500);
      deepEqual(await lab.healthLog("mic"), ["mic:off", "mic:starting", "mic:live:sound"]);
    },
  },

  {
    name: "health: the browser refusing the mic is blocked by user, with the raw error",
    requires: ["scriptedHealth"],
    reset: SCRIPTED,
    async run({ lab }) {
      await lab.setPermission("microphone", "denied");
      await lab.failNextGetUserMedia("NotAllowedError", "Permission denied");
      await lab.initialize();
      const mic = (await lab.health()).mic;
      ok(mic.state === "failed");
      if (mic.state !== "failed") return;
      deepEqual(mic.problem, { code: "blocked", by: "user" });
      deepEqual(mic.fixes, ["allow-in-browser"]);
      deepEqual(mic.error, { name: "NotAllowedError", message: "Permission denied" });
      includes(await lab.events(), "onDeviceError:permissions", "the DeviceError still fires");
    },
  },

  {
    name: "health: a refusal while the browser says granted is the operating system",
    requires: ["scriptedHealth"],
    reset: SCRIPTED,
    async run({ lab }) {
      await lab.failNextGetUserMedia("NotAllowedError", "Permission denied");
      await lab.initialize();
      await lab.waitForHealth("mic", "failed:blocked:os");
      const mic = (await lab.health()).mic;
      if (mic.state === "failed") deepEqual(mic.fixes, ["allow-in-os-settings"]);
    },
  },

  {
    name: "health: a frame without the microphone permission is blocked by page",
    requires: ["scriptedHealth"],
    reset: { ...SCRIPTED, framePolicyBlocked: true },
    async run({ lab }) {
      await lab.setPermission("microphone", "denied");
      await lab.failNextGetUserMedia("NotAllowedError", "Permission denied");
      await lab.initialize();
      await lab.waitForHealth("mic", "failed:blocked:page");
    },
  },

  {
    name: "health: a refusal inside an in-app browser says to open a real browser",
    requires: ["scriptedHealth"],
    reset: {
      ...SCRIPTED,
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 300.0",
    },
    async run({ lab }) {
      await lab.setPermission("microphone", "denied");
      await lab.failNextGetUserMedia("NotAllowedError", "Permission denied");
      await lab.initialize();
      await lab.waitForHealth("mic", "failed:blocked:in-app-browser");
    },
  },

  {
    name: "health: an unanswered prompt shows asking, and a grant in site settings recovers",
    requires: ["scriptedHealth"],
    reset: SCRIPTED,
    async run({ lab }) {
      await lab.setPermission("microphone", "prompt");
      await lab.initialize();
      await lab.waitForHealth("mic", "live:sound");
      deepEqual((await lab.healthLog("mic")).slice(0, 4), [
        "mic:off",
        "mic:asking",
        "mic:starting",
        "mic:live:sound",
      ]);

      // Later the person blocks it, the next open fails, and then they allow
      // it again in the site settings: the mic comes back without a click.
      await lab.reset(SCRIPTED);
      await lab.setPermission("microphone", "denied");
      await lab.failNextGetUserMedia("NotAllowedError", "Permission denied");
      await lab.initialize();
      await lab.waitForHealth("mic", "failed:blocked:user");
      await lab.setPermission("microphone", "granted");
      await lab.waitForHealth("mic", "recovering:permission-granted");
      await lab.waitForHealth("mic", "live:sound:recovered-from-permission-granted");
    },
  },

  {
    name: "health: a busy device is already-in-use",
    requires: ["scriptedHealth"],
    reset: SCRIPTED,
    async run({ lab }) {
      await lab.failNextGetUserMedia("NotReadableError", "Could not start audio source");
      await lab.initialize();
      await lab.waitForHealth("mic", "failed:already-in-use");
      const mic = (await lab.health()).mic;
      if (mic.state === "failed")
        deepEqual(mic.fixes, ["close-other-apps", "choose-another-device"]);
    },
  },

  {
    name: "health: one bad device does not take the other kind down — split retry",
    requires: ["scriptedHealth"],
    reset: { ...SCRIPTED, enableCam: true },
    async run({ lab }) {
      await lab.failNextGetUserMedia("NotReadableError", "Could not start video source");
      await lab.initialize();
      await lab.waitForHealth("mic", "live:sound");
      await lab.waitForHealth("cam", "live:unmeasured");
      equal(await gumCount(lab), 3, "the combined call, then one per kind");
      excludes(await lab.healthLog(), "mic:failed:already-in-use");
      equal((await lab.deviceErrors()).length, 0, "a split that succeeds is not an error");
    },
  },

  {
    name: "health: a denial is never split into a second prompt",
    requires: ["scriptedHealth"],
    reset: { ...SCRIPTED, enableCam: true },
    async run({ lab }) {
      await lab.setPermission("microphone", "denied");
      await lab.failNextGetUserMedia("NotAllowedError", "Permission denied");
      await lab.initialize();
      equal(await gumCount(lab), 1);
      await lab.waitForHealth("mic", "failed:blocked:user");
    },
  },

  {
    name: "health: an unplugged mic is device-lost while it reopens, then live and says so",
    requires: ["scriptedHealth"],
    reset: SCRIPTED,
    async run({ lab }) {
      await lab.initialize();
      await lab.waitForHealth("mic", "live:sound");
      await lab.clearHealthLog();
      await lab.simulateEnded("audio");
      await lab.waitForHealth("mic", "live:sound:recovered-from-device-lost");
      deepEqual(await lab.healthLog("mic"), [
        "mic:recovering:device-lost",
        "mic:live:sound:recovered-from-device-lost",
      ]);
      const mic = (await lab.health()).mic;
      if (mic.state === "live") ok(mic.recovered?.from, "names the device it lost");
    },
  },

  {
    name: "health: a phone call taking the mic while hidden is interrupted until the page is back",
    requires: ["scriptedHealth"],
    reset: SCRIPTED,
    async run({ lab }) {
      await lab.initialize();
      await lab.waitForHealth("mic", "live:sound");
      await lab.setVisibility("hidden");
      await lab.simulateMute("audio");
      await lab.waitForHealth("mic", "recovering:interrupted");
      await sleep(150);
      equal(await gumCount(lab), 1, "nothing reopens while hidden");
      await lab.simulateUnmute("audio");
      await lab.waitForHealth("mic", "live:sound:recovered-from-interrupted");
      await lab.setVisibility("visible");
    },
  },

  {
    name: "health: a device that keeps coming back muted stops churning and names what holds it",
    // Unscripted: nothing measured, so no sound resets the run of interruptions.
    async run({ lab }) {
      await lab.initialize();
      await waitFor(async () => (await lab.health()).mic.state === "live", {
        timeout: 2000,
        message: "mic never live",
      });
      for (let i = 0; i < 6; i++) {
        if ((await lab.health()).mic.state === "failed") break;
        const before = (await lab.captureTracks()).audio?.id;
        await lab.simulateMute("audio");
        // Mute the next device only once it is installed and live: a mute that
        // lands while the reopen is still in flight hits the track being
        // replaced. Waiting on the getUserMedia count raced the install.
        await waitFor(
          async () => {
            const state = (await lab.health()).mic.state;
            if (state === "failed") return true;
            const now = (await lab.captureTracks()).audio;
            return state === "live" && !!now && now.id !== before && now.readyState === "live";
          },
          { timeout: 3000, message: "the reopened mic never settled" },
        );
      }
      await lab.waitForHealth("mic", "failed:interrupted");
      const mic = (await lab.health()).mic;
      // The page is in front, so "return to the page" would not help.
      if (mic.state === "failed")
        deepEqual(mic.fixes, ["close-other-apps", "unmute-hardware", "choose-another-device"]);
      // Whatever held it lets go: the failure clears without a reopen.
      await lab.simulateUnmute("audio");
      await waitFor(async () => (await lab.health()).mic.state === "live", {
        timeout: 2000,
        message: "an unmuted mic stayed failed",
      });
    },
  },

  {
    name: "health: muting holds the device as muted, unmuting is live again",
    requires: ["scriptedHealth"],
    reset: SCRIPTED,
    async run({ lab }) {
      await lab.initialize();
      await lab.waitForHealth("mic", "live:sound");
      await lab.enableMic(false);
      await lab.waitForHealth("mic", "muted");
      await lab.clearHealthLog();
      await lab.setInputLevel("*", 0);
      await sleep(500);
      deepEqual(await lab.healthLog("mic"), [], "a muted mic is never judged silent");
      await lab.setInputLevel("*", 0.2);
      await lab.enableMic(true);
      await lab.waitForHealth("mic", "live:sound");
    },
  },

  {
    name: "health: a released mic is off when muted",
    requires: ["scriptedHealth"],
    reset: { ...SCRIPTED, releaseMicOnDisable: true },
    async run({ lab }) {
      await lab.initialize();
      await lab.waitForHealth("mic", "live:sound");
      await lab.clearHealthLog();
      await lab.enableMic(false);
      await lab.waitForHealth("mic", "off");
    },
  },

  {
    name: "health: a default that is a loopback is swapped for a real mic, once",
    requires: ["scriptedHealth"],
    reset: SCRIPTED,
    async run({ lab }) {
      await lab.addDevice("default", "audioinput", "Default - Stereo Mix (Realtek(R) Audio)");
      await lab.initialize();
      await waitFor(async () => (await gumCount(lab)) === 2, {
        timeout: 2000,
        message: "never moved off the loopback",
      });
      await lab.waitForHealth("mic", "live:sound");
      const mic = (await lab.health()).mic;
      ok(mic.state === "live");
      if (mic.state === "live")
        notOk(mic.device.traits.includes("loopback"), "still on the loopback");
      equal(await lab.requestedMicId(), "mic-a");
    },
  },

  {
    name: "health: a noise-gated virtual mic is never judged silent",
    requires: ["scriptedHealth"],
    reset: SCRIPTED,
    async run({ lab }) {
      // Krisp and NVIDIA Broadcast send exact zeros until someone speaks.
      await lab.addDevice("default", "audioinput", "Default - Krisp Microphone (Krisp Audio)");
      await lab.setInputLevel("*", 0);
      await lab.initialize();
      await sleep(800);
      equal((await lab.health()).mic.state, "live", "silent at join");
      equal(await gumCount(lab), 1, "no reopen");
      await lab.setInputLevel("*", 0.2);
      await lab.waitForHealth("mic", "live:sound");
      await sleep(500);
      await lab.setInputLevel("*", 0);
      await sleep(800);
      equal((await lab.health()).mic.state, "live", "silent mid-call");
    },
  },

  {
    name: "health: a chosen loopback is respected",
    requires: ["scriptedHealth"],
    reset: SCRIPTED,
    async run({ lab }) {
      await lab.addDevice("mix", "audioinput", "Stereo Mix (Realtek(R) Audio)");
      await lab.initialize();
      await lab.updateMic("mix");
      await lab.waitForHealth("mic", "live:sound");
      await sleep(100);
      equal(await lab.requestedMicId(), "mix");
      const mic = (await lab.health()).mic;
      if (mic.state === "live") deepEqual(mic.device.traits, ["loopback"]);
    },
  },

  {
    name: "health: in a real browser a working camera is live, and unmeasured until the voice runtime says",
    tiers: ["browser"],
    // The page does not look at its own picture: the voice runtime does (`caller-video`).
    // Nothing here plays the voice runtime, so the camera must go live and stay there.
    async run({ lab }) {
      await lab.initialize();
      await lab.enableCam(true);
      await waitFor(async () => (await lab.health()).cam.state === "live", {
        timeout: 5000,
        message: "the camera never went live",
      });
      await stayFalse(
        async () => (await lab.health()).cam.state !== "live",
        2000,
        "a working camera left live",
      );
      const cam = (await lab.health()).cam;
      if (cam.state === "live")
        deepEqual(cam.signal, { local: "unmeasured", server: "unmeasured" });
    },
  },

  {
    name: "health: a camera the voice runtime sees black from the start fails no-signal without a reopen",
    requires: ["scriptedHealth"],
    reset: { ...SCRIPTED, enableCam: true },
    async run({ lab }) {
      await lab.initialize();
      await lab.waitForHealth("cam", "live:unmeasured");
      await lab.setServerSignal("silent", "cam");
      await lab.waitForHealth("cam", "failed:no-signal");
      equal(await gumCount(lab), 1, "the voice runtime's black is not the page's to reopen");
      const cam = (await lab.health()).cam;
      if (cam.state === "failed") includes(cam.fixes, "open-camera-shutter");
      await lab.setServerSignal("sound", "cam");
      await waitFor(async () => (await lab.health()).cam.state === "live", {
        message: "an open shutter never cleared the failure",
      });
      const live = (await lab.health()).cam;
      if (live.state === "live") equal(live.signal.server, "sound");
    },
  },

  {
    name: "health: interruptions far apart in a long call never add up to a failure",
    requires: ["scriptedHealth"],
    reset: { ...SCRIPTED, enableCam: true },
    async run({ lab }) {
      await lab.initialize();
      await lab.waitForHealth("cam", "live:unmeasured");
      // More interruptions than one run allows, each a run of its own.
      for (let i = 0; i < 4; i++) {
        const before = (await lab.captureTracks()).video?.id;
        await lab.simulateMute("video");
        await waitFor(
          async () => {
            const now = (await lab.captureTracks()).video;
            const state = (await lab.health()).cam.state;
            return state === "failed" || (state === "live" && !!now && now.id !== before);
          },
          { timeout: 3000, message: "the reopened camera never settled" },
        );
        equal((await lab.health()).cam.state, "live", `interruption ${i + 1} failed the camera`);
        await sleep(450);
      }
    },
  },

  {
    name: "health: a camera the voice runtime saw, then sees black, is degraded",
    requires: ["scriptedHealth"],
    reset: { ...SCRIPTED, enableCam: true },
    async run({ lab }) {
      await lab.initialize();
      await lab.waitForHealth("cam", "live:unmeasured");
      await lab.setServerSignal("sound", "cam");
      await lab.setServerSignal("silent", "cam");
      await lab.waitForHealth("cam", "degraded:no-signal");
      equal(await gumCount(lab), 1);
    },
  },

  {
    name: "health: no camera frames at the voice runtime is degraded, unless the uplink is poor or the voice runtime has lost the mic too",
    requires: ["scriptedHealth"],
    reset: { ...SCRIPTED, enableCam: true },
    async run({ lab }) {
      await lab.initialize();
      await lab.waitForHealth("cam", "live:unmeasured");
      await lab.setServerSignal("sound", "cam");
      await lab.setServerSignal("none", "cam");
      await lab.waitForHealth("cam", "degraded:no-signal");
      const missing = (await lab.health()).cam;
      // A missing picture is not a closed shutter.
      if (missing.state === "degraded") deepEqual(missing.fixes, ["choose-another-device"]);
      // A congested uplink drops video first: that is the connection's to say.
      await lab.setUplink("poor");
      await waitFor(async () => (await lab.health()).cam.state === "live", {
        message: "a poor uplink still blamed the camera",
      });
      await lab.setUplink("good");
      await lab.waitForHealth("cam", "degraded:no-signal");
      await lab.setServerSignal("sound", "cam");
      await waitFor(async () => (await lab.health()).cam.state === "live", {
        message: "frames again never cleared it",
      });
      // Neither lane reaching the voice runtime is the network, and the connection's to say.
      await lab.setServerSignal("none");
      await lab.setServerSignal("none", "cam");
      await sleep(100);
      equal((await lab.health()).cam.state, "live");
    },
  },

  {
    name: "health: a camera switched off forgets the voice runtime's verdict",
    requires: ["scriptedHealth"],
    reset: { ...SCRIPTED, enableCam: true },
    async run({ lab }) {
      await lab.initialize();
      await lab.waitForHealth("cam", "live:unmeasured");
      await lab.setServerSignal("silent", "cam");
      await lab.waitForHealth("cam", "failed:no-signal");
      await lab.enableCam(false);
      await lab.waitForHealth("cam", "off");
      // A verdict in flight as the camera went off is about the old picture.
      await lab.setServerSignal("sound", "cam");
      await lab.clearHealthLog();
      await lab.enableCam(true);
      // The voice runtime judges a camera afresh once it is back on.
      await lab.waitForHealth("cam", "live:unmeasured");
      const cam = (await lab.health()).cam;
      if (cam.state === "live") equal(cam.signal.server, "unmeasured");
    },
  },

  {
    name: "health: a switched camera keeps the voice runtime's verdict until the voice runtime looks again",
    requires: ["scriptedHealth", "multipleCams"],
    reset: { ...SCRIPTED, enableCam: true },
    async run({ lab }) {
      await lab.initialize();
      await lab.waitForHealth("cam", "live:unmeasured");
      await lab.setServerSignal("silent", "cam");
      await lab.waitForHealth("cam", "failed:no-signal");
      const before = (await lab.selectedCam())?.deviceId;
      const target = (await lab.getAllCams()).find(
        (c) => c.deviceId !== "" && c.deviceId !== "default" && c.deviceId !== before,
      )?.deviceId;
      ok(before && target, "a second camera to switch to");
      // A device switch sends the voice runtime no trackStatus; it re-looks at a black
      // camera every 2 s and says what the new one shows.
      await lab.updateCam(target);
      await lab.setServerSignal("sound", "cam");
      await waitFor(async () => (await lab.health()).cam.state === "live", {
        message: "the new camera's picture never cleared the failure",
      });
    },
  },

  {
    name: "health: a closed screen picker is cancelled — no error, no callbacks",
    requires: ["screenShare"],
    async run({ lab }) {
      await lab.initialize();
      await lab.clearEvents();
      await lab.failNextGetDisplayMedia("NotAllowedError", "Permission denied");
      equal(await lab.enableScreenShare(true), "cancelled");
      equal(await lab.isSharingScreen(), false);
      excludes(await lab.events(), "onScreenShareError");
      equal((await lab.deviceErrors()).length, 0);
      deepEqual((await lab.healthLog("screen")).slice(-2), ["screen:asking", "screen:off"]);

      // Asking again prompts again.
      equal(await lab.enableScreenShare(true), "started");
      equal((await lab.displayCalls()).length, 2);
    },
  },

  {
    name: "health: a screen share the operating system refuses is failed and rejects",
    requires: ["screenShare"],
    async run({ lab }) {
      await lab.initialize();
      await lab.failNextGetDisplayMedia("NotAllowedError", "Permission denied by system");
      const error = await rejects(() => lab.enableScreenShare(true));
      equal(error.type, "permissions");
      includes(await lab.events(), "onScreenShareError");
      const screen = (await lab.health()).screen;
      ok(screen.state === "failed");
      if (screen.state === "failed") {
        deepEqual(screen.problem, { code: "blocked", by: "os" });
        deepEqual(screen.fixes, ["allow-in-os-settings"]);
      }
    },
  },

  {
    name: "health: a screen share Safari refuses outside a user gesture is not-supported, with no fix",
    requires: ["screenShare"],
    async run({ lab }) {
      await lab.initialize();
      await lab.failNextGetDisplayMedia(
        "InvalidAccessError",
        "getDisplayMedia must be called from a user gesture handler.",
      );
      await rejects(() => lab.enableScreenShare(true));
      const screen = (await lab.health()).screen;
      ok(screen.state === "failed");
      if (screen.state === "failed") {
        deepEqual(screen.problem, { code: "not-supported" });
        deepEqual(screen.fixes, []);
      }
    },
  },

  {
    name: "health: the browser bar's Stop sharing is ended by user and flips isSharingScreen",
    requires: ["screenShare"],
    async run({ lab }) {
      await lab.initialize();
      equal(await lab.enableScreenShare(true), "started");
      const live = (await lab.health()).screen;
      ok(live.state === "live", "live after started");
      await lab.simulateEnded("screen");
      await lab.waitForHealth("screen", "off:user");
      equal(await lab.isSharingScreen(), false);
    },
  },

  {
    name: "health: the app stopping a share is ended by app",
    requires: ["screenShare"],
    async run({ lab }) {
      await lab.initialize();
      await lab.enableScreenShare(true);
      await lab.enableScreenShare(false);
      await lab.waitForHealth("screen", "off:app");
    },
  },

  {
    name: "health: a monitor-only picker that excludes monitors is refused up front",
    requires: ["screenShare"],
    async run({ lab }) {
      await lab.initialize();
      const error = await rejects(() =>
        lab.enableScreenShare(true, { displaySurface: "monitor", monitorTypeSurfaces: "exclude" }),
      );
      equal(error.name, "TypeError");
      equal((await lab.displayCalls()).length, 0, "the engine was never asked");
    },
  },

  {
    name: "health: the speaker is idle until bound, then playing, and blocked under autoplay",
    tiers: ["unit"],
    async run({ lab }) {
      await lab.initialize();
      equal((await lab.health()).speaker.state, "idle");
      await lab.bindOutputElement();
      await lab.waitForHealth("speaker", "playing");
      await lab.unbindLastOutputElement();
      await lab.waitForHealth("speaker", "idle");
      await lab.blockAutoplay(true);
      await lab.bindOutputElement();
      await lab.waitForHealth("speaker", "blocked");
    },
  },

  {
    name: "health: every snapshot is frozen data",
    async run({ lab }) {
      await lab.initialize();
      const health = await lab.health();
      for (const part of ["mic", "cam", "speaker", "screen", "connection"] as const) {
        ok(health[part], `has ${part}`);
      }
    },
  },
];
