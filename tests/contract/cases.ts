/**
 * The contract suite. Written once; run by two runners.
 *
 * SPEC.md § Test taxonomy: "**The same test bodies as tier 1**, run against
 * real `navigator.mediaDevices` with fake capture devices. This is the point
 * of the design: one contract suite, two harnesses."
 *
 * A body never names vitest, Playwright, `FakeMediaDevices` or
 * `navigator` — it gets a `LabApi` and the measured `LabCapabilities` of
 * whatever it is running on. Two escape hatches keep that honest without
 * watering anything down:
 *
 *   `tiers`    — a case that is only *meaningful* in one tier says so. There
 *                is exactly one (a device vanishing mid-`getUserMedia`), and
 *                its reason is written on it.
 *   `requires` — a case that needs a capability the engine does not have is
 *                reported as skipped **with the capability named**, never
 *                silently passed. Firefox enumerating one microphone is a
 *                fact about Firefox; a device-switch assertion that quietly
 *                weakens itself there would hide it.
 */

import type { LabApi, LabResetOptions } from "../../lab/labApi";
import type { LabCapabilities } from "../../lab/labPlatform";
import {
  deepEqual,
  equal,
  excludes,
  includes,
  nonEmpty,
  notEqual,
  notOk,
  ok,
  rejects,
  sleep,
  stayFalse,
  waitFor,
} from "./assert";

export type Tier = "unit" | "browser";

export interface CaseContext {
  readonly lab: LabApi;
  readonly caps: LabCapabilities;
  /** Record a measured, per-engine observation. Runners surface these; several became Findings. */
  note(text: string): void;
}

export interface ContractCase {
  name: string;
  /** Defaults to both tiers. */
  tiers?: Tier[];
  requires?: (keyof LabCapabilities)[];
  /** Applied by the runner via `lab.reset()` before the body runs. */
  reset?: LabResetOptions;
  run(ctx: CaseContext): Promise<void>;
}

// The recovery timers the runner installs (see `Lab.reset` defaults): a muted
// track is re-acquired after 60ms, a devicechange burst coalesces over 40ms.
const MUTED_MS = 60;
const DEBOUNCE_MS = 40;

/** A mic that is not the platform default, for the switch cases. */
async function otherMicId(lab: LabApi): Promise<string | null> {
  const mics = await lab.getAllMics();
  const usable = mics.filter(
    (m) => m.deviceId !== "" && m.deviceId !== "default" && m.deviceId !== "communications",
  );
  return usable[0]?.deviceId ?? null;
}

/**
 * A camera to switch *to*, which is not the one we are already on. Firefox
 * under `media.navigator.streams.fake` enumerates exactly one, which is what
 * the `multipleCams` capability gate exists for.
 */
async function otherCamId(lab: LabApi): Promise<string | null> {
  const cams = await lab.getAllCams();
  const usable = cams.filter((c) => c.deviceId !== "" && c.deviceId !== "default");
  const current = await lab.selectedCam();
  return (
    usable.find((c) => c.deviceId !== current?.deviceId)?.deviceId ?? usable[0]?.deviceId ?? null
  );
}

async function gumCount(lab: LabApi): Promise<number> {
  return (await lab.gumCalls()).length;
}

export const CONTRACT_CASES: ContractCase[] = [
  // ---------------------------------------------------------------- acquire

  {
    name: "tracks() is empty before initialize",
    async run({ lab }) {
      const tracks = await lab.tracks();
      equal(tracks.audio, null, "nothing is published before initialize");
      equal(await gumCount(lab), 0, "initialize is what acquires, not construction");
    },
  },

  {
    name: "initialize acquires one mic track and publishes a clone of it",
    async run({ lab, caps, note }) {
      await lab.initialize();
      const calls = await lab.gumCalls();
      equal(calls.length, 1, "exactly one getUserMedia");
      equal(calls[0]?.audio, true, "asked for audio");
      equal(calls[0]?.video, false, "phase 1 never asks for video");
      equal(calls[0]?.echoCancellation, true, "echo cancellation is on by default");

      const capture = (await lab.captureTracks()).audio;
      const published = (await lab.tracks()).audio;
      ok(capture, "a capture track is owned by the manager");
      ok(published, "a clone is published");
      // Decision 1: the peer connection must never get the capture track.
      notEqual(published.id, capture.id, "the published track is a clone, not the capture track");
      equal(capture.readyState, "live");
      equal(published.readyState, "live");
      equal(published.enabled, true);
      // Labels may be empty on an engine that gates them; a device id from
      // `getSettings()` is the one identifier that is always there.
      nonEmpty(capture.deviceId, "the capture track reports the device it came from");
      note(
        `capture label=${JSON.stringify(capture.label)} deviceId=${JSON.stringify(capture.deviceId)}`,
      );

      if (caps.contentHint) {
        equal(capture.contentHint, "speech", "decision 6: contentHint on the capture track");
        equal(published.contentHint, "speech", "decision 6: and on the published clone");
      } else {
        note("contentHint is not implemented on this engine; decision 6 is unobservable here");
      }
    },
  },

  {
    name: "initialize is idempotent — a second call acquires nothing new",
    async run({ lab }) {
      await lab.initialize();
      const first = (await lab.tracks()).audio;
      await lab.initialize();
      equal(await gumCount(lab), 1, "the second initialize reuses the live track");
      equal((await lab.tracks()).audio?.id, first?.id, "and does not republish");
    },
  },

  {
    name: "connect publishes a fresh clone over the same capture track",
    async run({ lab }) {
      await lab.initialize();
      const capture = (await lab.captureTracks()).audio;
      const firstClone = (await lab.tracks()).audio;
      await lab.connect();
      const secondClone = (await lab.tracks()).audio;
      ok(secondClone);
      // Decision 1: closePeerConnection() stops sender tracks, so a clone must
      // never be shared by two peer connections.
      notEqual(secondClone.id, firstClone?.id, "a new peer connection gets a new clone");
      equal((await lab.captureTracks()).audio?.id, capture?.id, "the capture track survives");
      equal((await lab.captureTracks()).audio?.readyState, "live");
      equal(await gumCount(lab), 1, "connect does not re-acquire the device");
    },
  },

  {
    name: "a published clone stopped by the transport is replaced while the capture lives",
    async run({ lab }) {
      await lab.initialize();
      await lab.connect();
      const capture = (await lab.captureTracks()).audio;
      const killed = (await lab.tracks()).audio;
      ok(capture, "a microphone is captured");
      ok(killed, "and a clone is published");

      // This is what `SmallWebRTCTransport` does on every reconnect, in the
      // order it does it: `startNewPeerConnection()` publishes the *existing*
      // clone onto the new senders, then `closePeerConnection(old)` calls
      // `sender.track.stop()` — on that same object. Decision 1 saves the
      // microphone and loses the call: measured on chromium 2026-09-07, the
      // peer connection stayed `connected` with three m-lines and a `live`
      // capture track, and sent zero packets, forever.
      //
      // `stop()` fires no `ended` event on any engine, so there is nothing to
      // listen for and the manager polls (`publishWatchdogMs`).
      ok(await lab.stopPublishedTrack("audio"), "the transport stops the clone it was handed");
      await waitFor(async () => (await lab.tracks()).audio?.readyState === "live", {
        message: "the dead clone was never replaced",
      });

      const replacement = (await lab.tracks()).audio;
      notEqual(replacement?.id, killed.id, "a *new* clone, not the corpse");
      equal((await lab.captureTracks()).audio?.id, capture.id, "over the same capture track");
      equal((await lab.captureTracks()).audio?.readyState, "live");
      equal(await gumCount(lab), 1, "and without re-prompting for the device");
      equal(
        (await lab.trackChanges()).at(-1),
        `audio:${replacement?.id}`,
        "the transport is handed the replacement",
      );
    },
  },

  {
    name: "disconnect releases capture and publishes nothing",
    async run({ lab }) {
      await lab.initialize();
      await lab.connect();
      await lab.disconnect();
      equal((await lab.tracks()).audio, null, "nothing published after disconnect");
      equal((await lab.captureTracks()).audio, null, "the device is released");
    },
  },

  {
    name: "our own stop is not mistaken for the device going away",
    async run({ lab }) {
      await lab.initialize();
      await lab.resetCounters();
      await lab.disconnect();
      // stop() is a silent local transition on every engine (proven in
      // harness.spec.ts, mirrored by the fake). If recovery ever fires here it
      // means the intentional-stop WeakSet has stopped working, and the
      // symptom in production is a mic that re-opens after hangup.
      await stayFalse(
        async () => (await gumCount(lab)) > 0,
        150,
        "a released device was re-acquired",
      );
      equal((await lab.captureTracks()).audio, null);
    },
  },

  {
    name: "enableMic:false at construction acquires nothing",
    reset: { enableMic: false },
    async run({ lab }) {
      await lab.initialize();
      equal(await gumCount(lab), 0, "no getUserMedia when the mic is not wanted");
      equal((await lab.tracks()).audio, null);
      equal(await lab.isMicEnabled(), false);
    },
  },

  // -------------------------------------------------------------- enableMic

  {
    name: "enableMic(false) keeps the device and mirrors enabled onto the clone",
    async run({ lab }) {
      await lab.initialize();
      await lab.enableMic(false);
      equal(await lab.isMicEnabled(), false);
      const capture = (await lab.captureTracks()).audio;
      const published = (await lab.tracks()).audio;
      ok(capture, "the device is held, not released");
      equal(capture.readyState, "live", "muting is not releasing");
      equal(capture.enabled, false);
      // Decision 1 again: the clone is what the peer connection carries, so
      // `enabled` has to be mirrored or the far side keeps hearing us.
      equal(published?.enabled, false, "enabled is mirrored onto the published clone");
      includes(await lab.events(), "onTrackStopped:audio");
    },
  },

  {
    name: "enableMic(true) after a disable re-enables without a second getUserMedia",
    async run({ lab }) {
      await lab.initialize();
      const id = (await lab.captureTracks()).audio?.id;
      await lab.enableMic(false);
      await lab.clearEvents();
      await lab.enableMic(true);
      equal(await gumCount(lab), 1, "the held device is re-enabled, not re-acquired");
      equal((await lab.captureTracks()).audio?.id, id, "same capture track");
      equal((await lab.tracks()).audio?.enabled, true);
      includes(await lab.events(), "onTrackStarted:audio");
    },
  },

  {
    name: "enableMic toggling announces the track exactly once per transition",
    async run({ lab }) {
      await lab.initialize();
      await lab.clearEvents();
      await lab.enableMic(false);
      await lab.enableMic(false);
      await lab.enableMic(true);
      await lab.enableMic(true);
      const events = await lab.events();
      equal(
        events.filter((e) => e === "onTrackStopped:audio").length,
        1,
        "a redundant disable announces nothing",
      );
      equal(
        events.filter((e) => e === "onTrackStarted:audio").length,
        1,
        "a redundant enable announces nothing",
      );
    },
  },

  {
    name: "releaseMicOnDisable releases the device and re-acquires on enable",
    reset: { releaseMicOnDisable: true },
    async run({ lab }) {
      await lab.initialize();
      await lab.enableMic(false);
      equal((await lab.captureTracks()).audio, null, "the device is released");
      equal((await lab.tracks()).audio, null);
      await lab.enableMic(true);
      equal(await gumCount(lab), 2, "re-enabling re-acquires");
      equal((await lab.captureTracks()).audio?.readyState, "live");
    },
  },

  {
    name: "isMicEnabled answers immediately, before the queue drains",
    async run({ lab }) {
      await lab.initialize();
      // The transport reads this synchronously right after calling enableMic;
      // if it lagged the queue the UI would show the wrong state for a frame.
      const [status] = await lab.burst([
        ["enableMic", [false]],
        ["isMicEnabled", []],
      ]);
      equal(status, "fulfilled");
      equal(await lab.isMicEnabled(), false);
    },
  },

  // ---------------------------------------------------------------- devices

  {
    name: "getAllMics returns only audioinput, and never relies on labels",
    async run({ lab, note }) {
      await lab.initialize();
      const mics = await lab.getAllMics();
      ok(mics.length > 0, "at least one microphone");
      for (const mic of mics) equal(mic.kind, "audioinput");
      const labelled = mics.filter((m) => m.label.length > 0).length;
      // `enumerateDevices` returns empty labels before a permission grant on
      // every engine; nothing in the manager may key off a label.
      note(`mics=${mics.length} labelled=${labelled}`);
      const speakers = await lab.getAllSpeakers();
      for (const speaker of speakers) equal(speaker.kind, "audiooutput");
      note(`speakers=${speakers.length}`);
    },
  },

  {
    name: "selectedMic is populated after a successful acquire",
    async run({ lab }) {
      await lab.initialize();
      const selected = await lab.selectedMic();
      ok(selected, "selectedMic is not the empty record once a track is live");
      nonEmpty(selected.deviceId, "the selected mic has a device id");
      includes(await lab.events(), `onMicUpdated:${selected.deviceId}`);
    },
  },

  {
    name: "updateMic switches device with an exact constraint and re-acquires",
    requires: ["multipleMics"],
    async run({ lab, note }) {
      await lab.initialize();
      const target = await otherMicId(lab);
      ok(target, "a non-default microphone to switch to");
      await lab.resetCounters();
      await lab.updateMic(target);

      const calls = await lab.gumCalls();
      equal(calls.length, 1, "one getUserMedia per switch");
      equal(calls[0]?.audioDeviceId, target, "the switch asks for the requested device");
      equal(
        calls[0]?.audioDeviceIdExact,
        true,
        "as an exact constraint, so a silent fallback is impossible",
      );
      equal(await lab.requestedMicId(), target);
      const capture = (await lab.captureTracks()).audio;
      ok(capture);
      equal(capture.readyState, "live");
      note(
        `switched to deviceId=${JSON.stringify(capture.deviceId)} label=${JSON.stringify(capture.label)}`,
      );
    },
  },

  {
    name: "a failed updateMic keeps the mic we already had",
    async run({ lab }) {
      await lab.initialize();
      const before = (await lab.captureTracks()).audio;
      ok(before);
      await lab.failNextGetUserMedia("NotReadableError", "device is in use");
      const error = await rejects(() => lab.updateMic("default"));
      equal(error.type, "in-use", "NotReadableError maps to the in-use DeviceErrorType");
      // Losing a working microphone because a picker offered a stale id is the
      // failure this rollback exists to prevent.
      const after = (await lab.captureTracks()).audio;
      equal(after?.id, before.id, "the live capture track is untouched");
      equal(after?.readyState, "live");
      equal(await lab.requestedMicId(), "default", "the requested device id is rolled back");
    },
  },

  {
    name: "updateMic('') falls back to the default device",
    async run({ lab }) {
      await lab.initialize();
      await lab.updateMic("");
      equal(await lab.requestedMicId(), "default");
      const calls = await lab.gumCalls();
      const last = calls[calls.length - 1];
      // `default` is a real device id on chromium and a name no other engine
      // mints. As `exact` it would fail the whole call on firefox and webkit;
      // as an ideal it is satisfied by whatever the OS picked. This assertion
      // is the reason `buildTrackConstraints` special-cases it.
      equal(last?.audioDeviceIdExact, false, "'default' goes in as an ideal, never as exact");
      const capture = (await lab.captureTracks()).audio;
      ok(capture, "asking for 'default' still yields a device on every engine");
      equal(capture.readyState, "live");
    },
  },

  // --------------------------------------------------------------- speakers

  {
    name: "updateSpeaker records the selection and routes bound elements",
    requires: ["audiooutputEnumerated", "setSinkId"],
    async run({ lab, note }) {
      await lab.initialize();
      await lab.bindOutputElement();
      const speakers = await lab.getAllSpeakers();
      const target = speakers.find((s) => s.deviceId !== "")?.deviceId;
      ok(target, "an enumerated audio output");
      await lab.updateSpeaker(target);
      equal((await lab.selectedSpeaker())?.deviceId, target);
      // SmallWebRTCTransport owns no playback element, so routing has to be
      // applied where playback happens — which is why binding exists at all.
      const sinks = await lab.boundSinkIds();
      note(`setSinkId(${JSON.stringify(target)}) -> sinkId=${JSON.stringify(sinks[0])}`);
      equal(sinks[0], target, "the bound element followed the selection");
      includes(await lab.events(), `onSpeakerUpdated:${target}`);
    },
  },

  {
    // The engine that had nothing to enumerate is exactly the engine this
    // breaks on, so this case deliberately does *not* require
    // `audiooutputEnumerated`. Firefox names its outputs with opaque hashed
    // ids and exposes none at all before a mic grant, so `"default"` — our
    // sentinel for "the user picked nothing" — is never a device id there and
    // passing it straight to `setSinkId` rejects with NotFoundError. Because
    // `bindOutputElement` is
    // fire-and-forget, that rejection surfaced as an uncaught error in the
    // host page rather than anywhere a caller could see it. The empty string
    // is the spec's own "route to the user-agent default" and every engine
    // takes it.
    name: "binding an output element with no selection routes to the engine default",
    requires: ["setSinkId"],
    async run({ lab, note }) {
      await lab.initialize();
      await lab.bindOutputElement();
      await waitFor(async () => (await lab.boundSinkIds()).length > 0, {
        message: "the bound element never reported a sinkId",
      });
      const sinks = await lab.boundSinkIds();
      note(`default selection -> sinkId=${JSON.stringify(sinks[0])}`);
      // Either answer is correct and which one you get is a fact about the
      // engine: `"default"` where it is a real enumerated device, `""` where
      // it is not. What must never happen is a rejection nobody catches.
      ok(
        sinks[0] === "" || sinks[0] === "default",
        `bound element routed to the default, got ${JSON.stringify(sinks[0])}`,
      );
      equal(
        (await lab.deviceErrors()).length,
        0,
        "routing to the default device is not a device error",
      );
    },
  },

  {
    name: "updateSpeaker rejects an unknown output device",
    async run({ lab }) {
      await lab.initialize();
      const error = await rejects(() => lab.updateSpeaker("no-such-speaker"));
      equal(error.type, "not-found");
    },
  },

  {
    // The gap this closes: `handleDeviceChange` used to refresh the speaker
    // only when the selection was `"default"`, so unplugging a headset the
    // user had explicitly chosen left the bound elements routed at a device id
    // that no longer existed, `selectedSpeaker` reporting it, and no callback
    // fired. Every input slot already did the right thing; the output side did
    // not.
    name: "a vanished speaker falls back to the default and re-routes bound elements",
    requires: ["setSinkId", "selectableSpeaker"],
    async run({ lab, note }) {
      await lab.initialize();
      const speakers = await lab.getAllSpeakers();
      const target = speakers.find(
        (s) => s.deviceId !== "" && s.deviceId !== "default" && s.deviceId !== "communications",
      );
      ok(target, "a speaker that is not the default");
      await lab.updateSpeaker(target.deviceId);
      await lab.bindOutputElement();
      await waitFor(async () => (await lab.boundSinkIds())[0] === target.deviceId, {
        message: "the element never routed to the chosen speaker",
      });
      await lab.clearEvents();

      await lab.hideDevice(target.deviceId);
      await lab.dispatchDeviceChange();

      await waitFor(async () => (await lab.selectedSpeaker())?.deviceId !== target.deviceId, {
        message: "the manager went on reporting a speaker that had been unplugged",
      });
      const sink = (await lab.boundSinkIds())[0];
      note(`speaker vanished -> sinkId=${JSON.stringify(sink)}`);
      // Same two correct answers as binding with no selection: the engine's
      // own default device where it has one, the empty string where it does
      // not. What must not survive is the dead id.
      ok(
        sink === "" || sink === "default",
        `the element re-routed off the dead device, got ${JSON.stringify(sink)}`,
      );
      // Not `onSpeakerUpdated:default`: Firefox names its outputs with opaque
      // hashed ids and has nothing literally called `default`, so the fallback
      // announces *its* default's id. What every engine must agree on is that a
      // speaker was re-announced and that it is not the one that vanished.
      const announced = (await lab.events())
        .filter((e) => e.startsWith("onSpeakerUpdated:"))
        .map((e) => e.slice("onSpeakerUpdated:".length));
      ok(announced.length > 0, "no speaker was re-announced after the device vanished");
      ok(
        !announced.includes(target.deviceId),
        `the fallback re-announced the dead device ${JSON.stringify(target.deviceId)}`,
      );
    },
  },

  {
    // `fallbackToDefaultDevice` governs the speaker the same way it governs
    // the mic and camera. An app that would rather hold a stale selection and
    // decide for itself must be able to.
    name: "fallbackToDefaultDevice:false keeps a vanished speaker selected",
    requires: ["setSinkId", "selectableSpeaker"],
    reset: { fallbackToDefaultDevice: false },
    async run({ lab }) {
      await lab.initialize();
      const speakers = await lab.getAllSpeakers();
      const target = speakers.find(
        (s) => s.deviceId !== "" && s.deviceId !== "default" && s.deviceId !== "communications",
      );
      ok(target, "a speaker that is not the default");
      await lab.updateSpeaker(target.deviceId);
      await lab.hideDevice(target.deviceId);
      await lab.dispatchDeviceChange();
      await sleep(DEBOUNCE_MS * 3);
      equal((await lab.selectedSpeaker())?.deviceId, target.deviceId, "the selection is held");
    },
  },

  // --------------------------------------------------------------- playback
  //
  // Autoplay is the failure where every other number looks healthy: frames
  // encode, packets arrive, `getStats()` is green, and the person on the call
  // hears nothing. Nothing else in the stack reports it.

  {
    name: "binding an element attempts playback and reports nothing blocked",
    async run({ lab }) {
      await lab.initialize();
      await lab.bindOutputElement();
      await waitFor(async () => (await lab.playAttempts())[0] === 1, {
        message: "binding never attempted playback",
      });
      notOk(await lab.playbackBlocked(), "nothing is blocked when the browser plays");
      deepEqual(await lab.playbackEvents(), [], "no news is not an event");
      equal((await lab.deviceErrors()).length, 0, "playing is not a device error");
    },
  },

  {
    name: "a refused play is reported as blocked, not as a device error",
    async run({ lab }) {
      await lab.initialize();
      await lab.blockAutoplay(true);
      await lab.bindOutputElement();

      await waitFor(async () => lab.playbackBlocked(), {
        message: "a refused play was swallowed",
      });
      deepEqual(await lab.playbackEvents(), ["blocked"]);
      // The distinction that matters: this is not a device fault and there is
      // nothing the app can retry on its own. It needs a gesture, so it goes
      // on the playback channel and the device-error channel stays clean.
      equal((await lab.deviceErrors()).length, 0, "an autoplay refusal is not a device error");
      // And it must not take the call down with it.
      ok((await lab.captureTracks()).audio?.readyState === "live", "capture is untouched");
    },
  },

  {
    name: "resumePlayback clears the block once the gesture arrives",
    async run({ lab }) {
      await lab.initialize();
      await lab.blockAutoplay(true);
      await lab.bindOutputElement();
      await waitFor(async () => lab.playbackBlocked(), { message: "never blocked" });

      // Still blocked: a retry with the policy unchanged must not report success.
      notOk(await lab.resumePlayback(), "retrying into the same policy still fails");
      ok(await lab.playbackBlocked());
      deepEqual(await lab.playbackEvents(), ["blocked"], "and it is not re-announced");

      await lab.blockAutoplay(false);
      ok(await lab.resumePlayback(), "the gesture lands");
      notOk(await lab.playbackBlocked());
      deepEqual(await lab.playbackEvents(), ["blocked", "playing"]);
    },
  },

  {
    name: "an element that unbinds while blocked releases the blocked state",
    async run({ lab }) {
      await lab.initialize();
      await lab.blockAutoplay(true);
      await lab.bindOutputElement();
      await waitFor(async () => lab.playbackBlocked(), { message: "never blocked" });

      await lab.unbindLastOutputElement();
      notOk(await lab.playbackBlocked(), "a player that unmounted cannot still be blocked");
      deepEqual(await lab.playbackEvents(), ["blocked", "playing"]);
    },
  },

  {
    name: "changing the speaker re-asserts playback on every bound element",
    requires: ["setSinkId", "selectableSpeaker"],
    async run({ lab }) {
      await lab.initialize();
      await lab.bindOutputElement();
      await waitFor(async () => ((await lab.playAttempts())[0] ?? 0) >= 1, {
        message: "never played",
      });
      const before = (await lab.playAttempts())[0] ?? 0;
      const speakers = await lab.getAllSpeakers();
      const target = speakers.find(
        (s) => s.deviceId !== "" && s.deviceId !== "default" && s.deviceId !== "communications",
      );
      ok(target);
      await lab.updateSpeaker(target.deviceId);
      ok(((await lab.playAttempts())[0] ?? 0) > before, "a route change re-asserts playback");
    },
  },

  // --------------------------------------------------------------- recovery

  {
    name: "an unexpected ended re-acquires the microphone",
    async run({ lab }) {
      await lab.initialize();
      const before = (await lab.captureTracks()).audio;
      ok(before);
      await lab.resetCounters();
      await lab.clearEvents();
      ok(await lab.simulateEnded("audio"), "the platform could end the capture track");

      await waitFor(async () => (await lab.captureTracks()).audio?.readyState === "live", {
        message: "the manager never re-acquired after a device-initiated ended",
      });
      equal(await gumCount(lab), 1, "exactly one re-acquire");
      const after = (await lab.captureTracks()).audio;
      notEqual(after?.id, before.id, "a genuinely new track");
      const events = await lab.events();
      includes(events, "onTrackStopped:audio");
      includes(events, "onTrackStarted:audio");
    },
  },

  {
    name: "ended recovery does not fire once the mic is no longer wanted",
    async run({ lab }) {
      await lab.initialize();
      await lab.enableMic(false);
      await lab.resetCounters();
      ok(await lab.simulateEnded("audio"));
      await stayFalse(
        async () => (await gumCount(lab)) > 0,
        150,
        "recovered a mic nobody asked for",
      );
    },
  },

  {
    name: "a track that mutes and stays muted is re-acquired",
    async run({ lab }) {
      await lab.initialize();
      const before = (await lab.captureTracks()).audio;
      await lab.resetCounters();
      ok(await lab.simulateMute("audio"), "the platform could mute the capture track");
      await waitFor(async () => (await gumCount(lab)) === 1, {
        message: "a persistently muted track was never re-acquired",
      });
      notEqual((await lab.captureTracks()).audio?.id, before?.id);
    },
  },

  {
    name: "a mute that clears inside the window is not recovered",
    async run({ lab }) {
      await lab.initialize();
      const before = (await lab.captureTracks()).audio;
      await lab.resetCounters();
      ok(await lab.simulateMute("audio"));
      ok(await lab.simulateUnmute("audio"));
      // A transient mute is what a device does when it is re-negotiating, and
      // tearing the track down for it would be a self-inflicted glitch.
      await stayFalse(
        async () => (await gumCount(lab)) > 0,
        MUTED_MS * 4,
        "a transient mute triggered a re-acquire",
      );
      equal((await lab.captureTracks()).audio?.id, before?.id, "the same track is still in place");
    },
  },

  {
    name: "muted recovery is withheld while the document is hidden, and runs when it returns",
    async run({ lab }) {
      await lab.initialize();
      await lab.setVisibility("hidden");
      await lab.resetCounters();
      ok(await lab.simulateMute("audio"));
      // Some engines mute capture on purpose in a backgrounded tab.
      // Re-acquiring there fights the browser and can raise a permission
      // prompt on a page the user cannot see.
      await stayFalse(
        async () => (await gumCount(lab)) > 0,
        MUTED_MS * 4,
        "re-acquired the microphone in a hidden tab",
      );
      await lab.setVisibility("visible");
      await waitFor(async () => (await gumCount(lab)) === 1, {
        message: "the mic was never recovered after the tab came back",
      });
    },
  },

  // ---------------------------------------------------------- device change

  {
    name: "a devicechange burst is coalesced into one enumerate",
    async run({ lab }) {
      await lab.initialize();
      await lab.resetCounters();
      // Chrome fires devicechange before enumerateDevices() settles; an
      // undebounced handler reads a transiently short list and drops the mic.
      for (let i = 0; i < 5; i++) await lab.dispatchDeviceChange();
      await waitFor(async () => (await lab.enumerateCount()) >= 1, {
        message: "devicechange was never handled",
      });
      await sleep(DEBOUNCE_MS * 3);
      equal(await lab.enumerateCount(), 1, "five events, one enumerate");
    },
  },

  {
    name: "a vanished selection is abandoned and the default is acquired",
    requires: ["multipleMics"],
    async run({ lab, note }) {
      await lab.initialize();
      const target = await otherMicId(lab);
      ok(target);
      await lab.updateMic(target);
      equal(await lab.requestedMicId(), target);
      await lab.resetCounters();

      await lab.hideDevice(target);
      await lab.dispatchDeviceChange();

      await waitFor(async () => (await lab.requestedMicId()) === "default", {
        message: "the manager kept asking for a device that is gone",
      });
      await waitFor(async () => (await lab.captureTracks()).audio?.readyState === "live", {
        message: "no microphone after the selected one disappeared",
      });
      const mics = await lab.getAllMics();
      excludes(
        mics.map((m) => m.deviceId),
        target,
        "the hidden device is gone from enumeration",
      );
      note(`fell back to deviceId=${JSON.stringify((await lab.captureTracks()).audio?.deviceId)}`);
    },
  },

  {
    name: "a device that vanishes mid-getUserMedia leaves the previous mic intact",
    // Tier 1 only, and this is the reason tier 1 exists: no engine can be
    // driven into losing a device *while* getUserMedia is in flight, so the
    // rollback path has no other way to be exercised. `vanishMidAcquire` is
    // false on every real platform and the runner reports the skip.
    tiers: ["unit"],
    requires: ["vanishMidAcquire", "multipleMics"],
    async run({ lab }) {
      await lab.initialize();
      const before = (await lab.captureTracks()).audio;
      const target = await otherMicId(lab);
      ok(target);
      ok(await lab.vanishDeviceDuringNextAcquire(target));
      const error = await rejects(() => lab.updateMic(target));
      equal(error.type, "constraints", "an exact id that is gone is an OverconstrainedError");
      equal(await lab.requestedMicId(), "default", "the half-made switch is rolled back");
      equal((await lab.captureTracks()).audio?.id, before?.id, "and the old mic is still live");
      equal((await lab.captureTracks()).audio?.readyState, "live");
    },
  },

  // ----------------------------------------------------------------- errors

  {
    name: "a denied permission is reported as a permissions DeviceError",
    async run({ lab }) {
      await lab.failNextGetUserMedia("NotAllowedError", "Permission denied");
      // initialize() must stay usable after a refusal — the user can grant it
      // and try again, and a thrown initialize would take the whole client down.
      await lab.initialize();
      const errors = await lab.deviceErrors();
      equal(errors.length, 1);
      equal(errors[0]?.type, "permissions");
      equal(errors[0]?.name, "NotAllowedError");
      includes(errors[0]?.devices ?? [], "mic");
      includes(await lab.events(), "onDeviceError:permissions");
      equal((await lab.tracks()).audio, null);
    },
  },

  {
    name: "a busy device is reported as in-use",
    async run({ lab }) {
      await lab.failNextGetUserMedia("NotReadableError", "Could not start audio source");
      await lab.initialize();
      equal((await lab.deviceErrors())[0]?.type, "in-use");
    },
  },

  {
    name: "a missing device is reported as not-found",
    async run({ lab }) {
      await lab.failNextGetUserMedia("NotFoundError", "Requested device not found");
      await lab.initialize();
      equal((await lab.deviceErrors())[0]?.type, "not-found");
    },
  },

  // ------------------------------------------------------------------ queue

  {
    name: "overlapping mutations are serialized and the last one wins",
    requires: ["multipleMics"],
    async run({ lab }) {
      await lab.initialize();
      const target = await otherMicId(lab);
      ok(target);
      await lab.resetCounters();

      // Decision 2. Fired together, inside the page, so they genuinely overlap.
      const results = await lab.burst([
        ["updateMic", [target]],
        ["updateMic", ["default"]],
        ["enableMic", [false]],
      ]);
      equal(
        results.filter((r) => r === "fulfilled").length,
        3,
        `all three settled: ${results.join()}`,
      );

      equal(await lab.requestedMicId(), "default", "the last device switch wins");
      equal(await lab.isMicEnabled(), false);
      const capture = (await lab.captureTracks()).audio;
      ok(capture, "the device is held, just disabled");
      equal(capture.enabled, false, "no interleaving left the track enabled");
      equal((await lab.tracks()).audio?.enabled, false);
      // Two switches, two acquires — never one call clobbering another's install.
      equal(await gumCount(lab), 2);
    },
  },

  {
    name: "an overlapping burst survives one operation failing",
    async run({ lab }) {
      await lab.initialize();
      await lab.resetCounters();
      await lab.failNextGetUserMedia("NotReadableError", "device is in use");
      const results = await lab.burst([
        ["updateMic", ["default"]],
        ["enableMic", [false]],
        ["enableMic", [true]],
      ]);
      equal(results[0], "rejected", "the failing switch rejects");
      equal(results[1], "fulfilled", "a rejection does not poison the queue tail");
      equal(results[2], "fulfilled");
      equal(await lab.isMicEnabled(), true);
      equal((await lab.captureTracks()).audio?.readyState, "live");
    },
  },

  // --------------------------------------------------------------- camera

  {
    name: "enabling the camera acquires video without re-asking for the microphone",
    async run({ lab, caps, note }) {
      await lab.initialize();
      const mic = (await lab.captureTracks()).audio;
      ok(mic, "the mic is live before the camera is enabled");
      await lab.resetCounters();
      await lab.clearEvents();
      await lab.enableCam(true);

      const calls = await lab.gumCalls();
      equal(calls.length, 1, "one getUserMedia for the camera");
      equal(calls[0]?.video, true, "asked for video");
      // Decision 3's other half. WebKit stops an earlier track when a second
      // getUserMedia targets the same device group, so re-requesting audio we
      // already hold would silently kill the live microphone.
      equal(calls[0]?.audio, false, "did not re-request the microphone it already holds");
      equal(
        (await lab.captureTracks()).audio?.id,
        mic.id,
        "the same microphone track is still ours",
      );
      equal((await lab.captureTracks()).audio?.readyState, "live");

      equal(await lab.isCamEnabled(), true);
      const capture = (await lab.captureTracks()).video;
      const published = (await lab.tracks()).video;
      ok(capture, "a camera capture track is owned by the manager");
      ok(published, "a clone is published");
      equal(capture.kind, "video");
      notEqual(published.id, capture.id, "decision 1: the peer connection gets the clone");
      equal(capture.readyState, "live");
      equal(published.enabled, true);
      includes(await lab.events(), "onTrackStarted:video");
      note(
        `camera label=${JSON.stringify(capture.label)} deviceId=${JSON.stringify(capture.deviceId)}`,
      );

      if (caps.contentHint) {
        equal(capture.contentHint, "motion", "decision 6: motion for a camera");
      } else {
        note("contentHint is not implemented on this engine; decision 6 is unobservable here");
      }
    },
  },

  {
    name: "mic and camera wanted together issue exactly one getUserMedia",
    reset: { enableMic: true, enableCam: true },
    async run({ lab }) {
      await lab.initialize();
      const calls = await lab.gumCalls();
      // Decision 3, and the case that makes it load-bearing rather than tidy:
      // on WebKit a second getUserMedia aimed at the same device group stops
      // the track the first one returned, so two calls is a bug even on the
      // engines where it appears to work.
      equal(calls.length, 1, `one call for both kinds, got ${calls.length}`);
      equal(calls[0]?.audio, true, "audio in the same call");
      equal(calls[0]?.video, true, "and video");
      const capture = await lab.captureTracks();
      equal(capture.audio?.readyState, "live", "the microphone survived");
      equal(capture.video?.readyState, "live", "and so did the camera");
      equal(await lab.isMicEnabled(), true);
      equal(await lab.isCamEnabled(), true);
      ok((await lab.tracks()).audio, "both are published");
      ok((await lab.tracks()).video);
    },
  },

  {
    name: "disabling the camera releases the device and leaves the microphone alone",
    reset: { enableCam: true },
    async run({ lab }) {
      await lab.initialize();
      const mic = (await lab.captureTracks()).audio;
      ok(mic);
      await lab.clearEvents();
      await lab.enableCam(false);

      // Unlike the mic, the camera is released on disable by default: holding
      // it leaves the hardware indicator lit, and a user who turned the camera
      // off and still sees the light is right to conclude we are lying.
      equal((await lab.captureTracks()).video, null, "the camera device is released");
      equal((await lab.tracks()).video, null, "and unpublished");
      equal(await lab.isCamEnabled(), false);
      includes(await lab.events(), "onTrackStopped:video");
      equal((await lab.captureTracks()).audio?.id, mic.id, "the microphone is untouched");
      equal((await lab.captureTracks()).audio?.readyState, "live");
    },
  },

  {
    name: "a camera released on disable is re-acquired on enable",
    async run({ lab }) {
      await lab.initialize();
      await lab.enableCam(true);
      const first = (await lab.captureTracks()).video;
      ok(first);
      await lab.enableCam(false);
      await lab.resetCounters();
      await lab.enableCam(true);

      equal(await gumCount(lab), 1, "one getUserMedia to get it back");
      const second = (await lab.captureTracks()).video;
      ok(second);
      notEqual(second.id, first.id, "a genuinely new capture track");
      equal(second.readyState, "live");
      equal(await lab.isCamEnabled(), true);
    },
  },

  {
    name: "releaseCamOnDisable:false holds the device and mirrors enabled onto the clone",
    reset: { releaseCamOnDisable: false },
    async run({ lab }) {
      await lab.initialize();
      await lab.enableCam(true);
      await lab.resetCounters();
      await lab.enableCam(false);

      const capture = (await lab.captureTracks()).video;
      ok(capture, "the device is held, just disabled");
      equal(capture.enabled, false);
      equal(
        (await lab.tracks()).video?.enabled,
        false,
        "decision 1: mirrored onto the published clone",
      );
      equal(await lab.isCamEnabled(), false);

      await lab.enableCam(true);
      equal(await gumCount(lab), 0, "no getUserMedia to re-enable a track we still hold");
      equal((await lab.tracks()).video?.enabled, true);
      equal(await lab.isCamEnabled(), true);
    },
  },

  {
    name: "updateCam switches camera with an exact constraint and re-acquires",
    requires: ["multipleCams"],
    async run({ lab, note }) {
      await lab.initialize();
      await lab.enableCam(true);
      const target = await otherCamId(lab);
      ok(target, "a second camera to switch to");
      await lab.resetCounters();
      await lab.clearEvents();
      await lab.updateCam(target);

      const calls = await lab.gumCalls();
      equal(calls.length, 1, "one getUserMedia per switch");
      equal(calls[0]?.video, true);
      equal(calls[0]?.audio, false, "a camera switch never touches the microphone");
      equal(calls[0]?.videoDeviceId, target, "the switch asks for the requested camera");
      equal(
        calls[0]?.videoDeviceIdExact,
        true,
        "as an exact constraint, so a silent fallback is impossible",
      );
      equal(await lab.requestedCamId(), target);
      const capture = (await lab.captureTracks()).video;
      ok(capture);
      equal(capture.readyState, "live");
      equal((await lab.selectedCam())?.deviceId, target, "selectedCam follows the switch");
      includes(await lab.events(), `onCamUpdated:${target}`);
      note(
        `switched camera to deviceId=${JSON.stringify(capture.deviceId)} label=${JSON.stringify(capture.label)}`,
      );
    },
  },

  {
    name: "a failed updateCam keeps the camera we already had",
    async run({ lab }) {
      await lab.initialize();
      await lab.enableCam(true);
      const before = (await lab.captureTracks()).video;
      ok(before);
      const beforeId = await lab.requestedCamId();
      await lab.failNextGetUserMedia("OverconstrainedError", "Requested device not found");
      await rejects(() => lab.updateCam("no-such-camera"));

      equal(await lab.requestedCamId(), beforeId, "the failed id is not kept");
      equal((await lab.captureTracks()).video?.id, before.id, "the live camera is untouched");
      equal((await lab.captureTracks()).video?.readyState, "live");
    },
  },

  {
    name: "an unexpected ended re-acquires the camera",
    async run({ lab }) {
      await lab.initialize();
      await lab.enableCam(true);
      const before = (await lab.captureTracks()).video;
      ok(before);
      await lab.resetCounters();
      await lab.clearEvents();
      ok(await lab.simulateEnded("video"), "the platform could end the camera track");

      await waitFor(async () => (await lab.captureTracks()).video?.readyState === "live", {
        message: "the manager never re-acquired after a device-initiated ended",
      });
      equal(await gumCount(lab), 1, "exactly one re-acquire");
      notEqual((await lab.captureTracks()).video?.id, before.id, "a genuinely new track");
      const events = await lab.events();
      includes(events, "onTrackStopped:video");
      includes(events, "onTrackStarted:video");
    },
  },

  {
    name: "a denied camera is a cam DeviceError and does not cost the microphone",
    async run({ lab }) {
      await lab.initialize();
      const mic = (await lab.captureTracks()).audio;
      ok(mic);
      await lab.failNextGetUserMedia("NotAllowedError", "Permission denied");
      // Must not throw: the transport calls this from a UI toggle and a
      // refused camera cannot take the client down.
      await lab.enableCam(true);

      const errors = await lab.deviceErrors();
      equal(errors.length, 1);
      equal(errors[0]?.type, "permissions");
      equal(errors[0]?.name, "NotAllowedError");
      includes(errors[0]?.devices ?? [], "cam");
      equal((await lab.tracks()).video, null);
      equal(await lab.isCamEnabled(), false);
      equal((await lab.captureTracks()).audio?.id, mic.id, "the microphone is still ours");
      equal((await lab.captureTracks()).audio?.readyState, "live");
    },
  },

  // --------------------------------------------------------- screen share

  {
    name: "enableScreenShare captures video only and announces it as a screen track",
    requires: ["screenShare"],
    async run({ lab, caps, note }) {
      await lab.initialize();
      await lab.clearEvents();
      await lab.enableScreenShare(true);

      const calls = await lab.displayCalls();
      equal(calls.length, 1, "exactly one getDisplayMedia");
      equal(calls[0]?.video, true, "asked for video");
      // Decision 9: screen *video* only. Screen audio needs a fourth
      // transceiver pipecat's interface has no member for, and it puts system
      // audio into the AEC's reference path.
      equal(calls[0]?.audio, false, "never system audio");
      equal(calls[0]?.width, 1920, "decision 8's ideal capture size");
      equal(calls[0]?.height, 1080);
      equal(calls[0]?.frameRate, 5, "decision 8: legibility over motion");

      equal(await lab.isSharingScreen(), true);
      const capture = (await lab.captureTracks()).screenVideo;
      const published = (await lab.tracks()).screenVideo;
      ok(capture, "the manager owns the screen capture track");
      ok(published, "and publishes a clone of it");
      notEqual(published.id, capture.id, "decision 1 applies to the screen lane too");
      equal(capture.readyState, "live");
      equal(published.readyState, "live");

      const events = await lab.events();
      includes(events, "onScreenTrackStarted:video");
      // A screen capture is `kind === "video"` too. An app listening on
      // onTrackStarted to render a camera preview must never be handed one.
      excludes(events, "onTrackStarted:video");
      equal((await lab.tracks()).video, null, "and it is not the camera lane");

      if (caps.contentHint) {
        equal(capture.contentHint, "detail", "decision 6: detail for a screen");
        equal(published.contentHint, "detail");
      } else {
        note("contentHint is not implemented on this engine; decision 6 is unobservable here");
      }
      note(
        `screen label=${JSON.stringify(capture.label)} settingsDeviceId=${JSON.stringify(capture.deviceId)}`,
      );
    },
  },

  {
    name: "camera and screen share are live together, and stopping one leaves the other",
    requires: ["screenShare"],
    async run({ lab }) {
      await lab.initialize();
      await lab.enableCam(true);
      await lab.enableScreenShare(true);

      // Decision 10: two independent video lanes, transceiver 1 and 2. The
      // failure this guards is a manager that treats "a video track" as one
      // slot and lets the screen evict the camera.
      const both = await lab.captureTracks();
      ok(both.video, "the camera is live");
      ok(both.screenVideo, "and so is the screen");
      notEqual(both.video.id, both.screenVideo.id);
      equal(both.video.readyState, "live");
      equal(both.screenVideo.readyState, "live");
      ok((await lab.tracks()).video, "both are published");
      ok((await lab.tracks()).screenVideo);
      equal(await lab.isCamEnabled(), true);
      equal(await lab.isSharingScreen(), true);

      await lab.enableScreenShare(false);
      equal(await lab.isSharingScreen(), false);
      equal((await lab.tracks()).screenVideo, null);
      equal((await lab.captureTracks()).video?.id, both.video.id, "the camera is untouched");
      equal((await lab.captureTracks()).video?.readyState, "live");
      equal(await lab.isCamEnabled(), true);

      await lab.enableCam(false);
      equal((await lab.captureTracks()).video, null);
      equal((await lab.captureTracks()).audio?.readyState, "live", "and the mic outlives both");
    },
  },

  {
    name: "two concurrent enableScreenShare calls leave exactly one live screen track",
    requires: ["screenShare"],
    async run({ lab }) {
      await lab.initialize();
      await lab.clearEvents();
      // The confirmed bug in the prior attempt (SPEC.md § Prior art): the two
      // callers shared the getDisplayMedia promise but each queued its own
      // install, both passed an isLive guard taken before anything had been
      // installed, and the second install's "already sharing" branch stopped
      // the very stream the first had just published. The symptom is a share
      // that reports itself on while sending a dead track.
      const results = await lab.burst([
        ["enableScreenShare", [true]],
        ["enableScreenShare", [true]],
      ]);
      equal(results.filter((r) => r === "fulfilled").length, 2, `both settle: ${results.join()}`);
      equal((await lab.displayCalls()).length, 1, "one prompt, not two");

      const capture = (await lab.captureTracks()).screenVideo;
      const published = (await lab.tracks()).screenVideo;
      ok(capture, "a screen capture track survives");
      ok(published, "and it is published");
      equal(capture.readyState, "live", "the second caller did not stop the first caller's track");
      equal(published.readyState, "live");
      equal(await lab.isSharingScreen(), true);
      equal(
        (await lab.events()).filter((e) => e === "onScreenTrackStarted:video").length,
        1,
        "announced exactly once",
      );
    },
  },

  {
    name: "the browser's own Stop sharing ends the share without re-prompting",
    requires: ["screenShare"],
    async run({ lab }) {
      await lab.initialize();
      await lab.enableScreenShare(true);
      await lab.clearEvents();
      // No call of ours ends this — the user pressed the browser's own chrome.
      // The intentionalStops WeakSet is what tells that apart from our stop().
      ok(await lab.simulateEnded("screen"), "the platform could end the display track");

      await waitFor(async () => (await lab.isSharingScreen()) === false, {
        message: "the manager still claims to be sharing a screen that ended",
      });
      await waitFor(async () => (await lab.tracks()).screenVideo === null, {
        message: "the dead screen track was never unpublished",
      });
      equal((await lab.captureTracks()).screenVideo, null);
      includes(await lab.events(), "onScreenTrackStopped:video");

      // A device slot recovers from `ended`; the screen slot must not. A
      // re-prompt here is a picker the user never asked for.
      await stayFalse(
        async () => (await lab.displayCalls()).length > 1,
        150,
        "re-prompted for a share the user stopped",
      );
      // And it is not a device failure: nothing to report, nothing to retry.
      equal((await lab.deviceErrors()).length, 0, "a user stopping a share is not a device error");
      excludes(await lab.events(), "onScreenShareError");

      // Asking again afterwards still works.
      await lab.enableScreenShare(true);
      equal((await lab.displayCalls()).length, 2, "a fresh request prompts again");
      equal(await lab.isSharingScreen(), true);
    },
  },

  {
    name: "a dismissed screen-share prompt maps to a typed DeviceError",
    requires: ["screenShare"],
    async run({ lab }) {
      await lab.initialize();
      await lab.clearEvents();
      await lab.failNextGetDisplayMedia("NotAllowedError", "Permission denied");
      const error = await rejects(() => lab.enableScreenShare(true));
      equal(error.name, "NotAllowedError");
      equal(error.type, "permissions", "the same typed mapping a denied camera gets");

      equal(await lab.isSharingScreen(), false);
      equal((await lab.tracks()).screenVideo, null);
      const events = await lab.events();
      // Both lanes: onScreenShareError is the one pipecat gives a share and it
      // carries only a string; onDeviceError is where the type lives.
      includes(events, "onScreenShareError");
      includes(events, "onDeviceError:permissions");
      const errors = await lab.deviceErrors();
      equal(errors.length, 1);
      includes(errors[0]?.devices ?? [], "cam");

      // A refusal is not sticky: the next click prompts again.
      await lab.enableScreenShare(true);
      equal(await lab.isSharingScreen(), true);
      equal((await lab.displayCalls()).length, 2);
    },
  },

  {
    name: "connect republishes a screen share and disconnect releases it",
    requires: ["screenShare"],
    async run({ lab }) {
      await lab.initialize();
      await lab.enableScreenShare(true);
      const first = (await lab.tracks()).screenVideo;
      ok(first);
      const capture = (await lab.captureTracks()).screenVideo;
      ok(capture);

      await lab.connect();
      const second = (await lab.tracks()).screenVideo;
      ok(second, "a reconnect must not silently drop a share the user started");
      notEqual(second.id, first.id, "decision 1: a fresh clone per peer connection");
      equal((await lab.captureTracks()).screenVideo?.id, capture.id, "over the same capture track");
      equal((await lab.displayCalls()).length, 1, "and no second prompt");
      includes(await lab.trackChanges(), `screenVideo:${second.id}`);

      await lab.disconnect();
      equal(await lab.isSharingScreen(), false, "the call is over, so the share is over");
      equal((await lab.tracks()).screenVideo, null);
      includes(await lab.trackChanges(), "screenVideo:null");
    },
  },

  {
    name: "contentHint is set per track kind, on the capture track and the clone",
    requires: ["contentHint", "screenShare"],
    async run({ lab }) {
      await lab.initialize();
      await lab.enableCam(true);
      await lab.enableScreenShare(true);
      const capture = await lab.captureTracks();
      const published = await lab.tracks();
      // Decision 6, all three lanes at once. The hint is what tells an encoder
      // to hold detail on a screen and hold framerate on a face.
      equal(capture.audio?.contentHint, "speech");
      equal(published.audio?.contentHint, "speech");
      equal(capture.video?.contentHint, "motion");
      equal(published.video?.contentHint, "motion");
      equal(capture.screenVideo?.contentHint, "detail");
      equal(published.screenVideo?.contentHint, "detail");
    },
  },

  // -------------------------------------------------------- phase-2 surface

  {
    name: "supportsScreenShare is constant true and turning things off acquires nothing",
    async run({ lab }) {
      equal(
        await lab.supportsScreenShare(),
        true,
        "decision 4: the m-line count must not vary by engine",
      );
      equal(await lab.isCamEnabled(), false);
      equal(await lab.isSharingScreen(), false);
      // Turning off what was never on is a no-op, not an error — the transport
      // calls these on teardown.
      await lab.enableCam(false);
      await lab.enableScreenShare(false);
      equal(await gumCount(lab), 0, "and nothing was acquired to turn off");
      equal((await lab.displayCalls()).length, 0);
    },
  },

  {
    name: "the encoding policy phase 2b applies is exposed per track kind",
    async run({ lab }) {
      // Decision 8 lives on RTCRtpSender.setParameters, which needs the peer
      // connection phase 2b builds. The *policy* is still this layer's to
      // state, so it is published as data for 2b to apply and assert against
      // rather than re-derive and drift from.
      const policy = await lab.encodingPolicy();
      deepEqual(Object.keys(policy).sort(), ["audio", "screenVideo", "video"]);
      equal(policy["audio"]?.contentHint, "speech");
      equal(policy["audio"]?.maxBitrate, 32_000, "mono Opus, matching what pygato negotiates");
      equal(policy["video"]?.contentHint, "motion");
      equal(
        policy["video"]?.degradationPreference,
        "maintain-framerate",
        "a smooth face beats a sharp one",
      );
      equal(policy["video"]?.maxFramerate, 30);
      equal(policy["video"]?.maxBitrate, 600_000);
      equal(policy["screenVideo"]?.contentHint, "detail");
      // The opposite bias, deliberately: a blurry screen is a broken feature,
      // a slow one is not, so a scroll drops frames rather than resolution.
      equal(policy["screenVideo"]?.degradationPreference, "maintain-resolution");
      equal(policy["screenVideo"]?.maxFramerate, 5);
      equal(policy["screenVideo"]?.maxBitrate, 1_500_000);
    },
  },

  {
    name: "the inert transport members answer without doing anything",
    async run({ lab }) {
      await lab.initialize();
      // Bot audio arrives as a remote WebRTC track; there is no local player.
      equal(await lab.bufferBotAudio(), true, "bufferBotAudio returns undefined");
      equal(await lab.userStartedSpeaking(), true, "userStartedSpeaking resolves to undefined");
      notOk((await lab.trackChanges()).includes("audio:null"), "no spurious unpublish");
    },
  },

  {
    name: "every publish is announced to the replaceTrack hook",
    async run({ lab }) {
      await lab.initialize();
      await lab.connect();
      const changes = await lab.trackChanges();
      // Phase 4 wires this to the transport's sender.replaceTrack. If it ever
      // stops firing, device switches silently stop reaching the peer
      // connection — the exact bug SPEC.md § Ground truth describes.
      equal(changes.length, 2, `one per publish: ${changes.join()}`);
      const published = (await lab.tracks()).audio;
      equal(changes[1], `audio:${published?.id}`, "the hook is handed the published clone");
      await lab.disconnect();
      equal((await lab.trackChanges())[2], "audio:null", "and told when it goes away");
    },
  },

  // ------------------------------------------- phase 2b: the peer connection
  //
  // Everything above this line is structural: a track exists, it has this id,
  // that callback fired, this many `getUserMedia` calls happened. None of it
  // proves a frame was ever *encoded*. These cases do, by wiring two
  // `RTCPeerConnection`s to each other inside the page (`src/loopback.ts`) and
  // reading `framesEncoded` off the sender.
  //
  // All of them are `tiers: ["browser"]` — node has no `RTCPeerConnection` —
  // and all of them require `loopbackPeerConnection`, which is *probed*. That
  // gate is not decoration: Playwright's Firefox on this host gathers zero ICE
  // candidates and cannot connect a loopback at all (measured 2026-09-07, with
  // a bare data channel and no media), so it reports a named skip here rather
  // than a silent pass.

  {
    name: "the loopback offers exactly three m-lines, in lane order",
    tiers: ["browser"],
    requires: ["loopbackPeerConnection"],
    async run({ lab, note }) {
      await lab.initialize();
      await lab.connect();
      await lab.pcOpen();

      const shape = await lab.pcShape();
      // Decision 4: `supportsScreenShare` is a constant `true`, so lane 2
      // exists in the very first offer with nothing published on it.
      equal(shape.mLineCount, 3, "three m-lines in the offer, screen share live or not");
      equal(shape.transceivers.length, 3);
      deepEqual(
        shape.transceivers.map((t) => `${t.index}:${t.lane}:${t.kind}`),
        ["0:audio:audio", "1:video:video", "2:screenVideo:video"],
        "lane index is m-line index, and lane 2 is a video transceiver",
      );
      deepEqual(
        shape.transceivers.map((t) => t.direction),
        ["sendonly", "sendonly", "sendonly"],
        "all three created sendonly before the first offer",
      );
      deepEqual(
        shape.transceivers.map((t) => t.mid),
        ["0", "1", "2"],
        "mids follow the same order",
      );
      equal(shape.connection.local, "connected");
      equal(shape.connection.remote, "connected");
      note(`connected: ${JSON.stringify(shape.connection)}`);
      await lab.pcClose();
    },
  },

  {
    name: "the m-line count does not change when screen share starts or stops",
    tiers: ["browser"],
    requires: ["loopbackPeerConnection", "screenShare"],
    async run({ lab, note }) {
      await lab.initialize();
      await lab.connect();
      await lab.pcOpen();
      equal(await lab.pcMLineCount(), 3, "three before the share");

      await lab.enableScreenShare(true);
      equal(await lab.isSharingScreen(), true);
      equal(await lab.pcMLineCount(), 3, "three while sharing — the lane was already there");
      const sharing = await lab.pcShape();
      // The payoff decision 4 was made for: the transport never has to
      // renegotiate to start a screen share, so there is no glare window and
      // no m-line reshuffle for the far end to survive.
      equal(sharing.renegotiationsNeeded, 0, "a mid-call share needs no renegotiation at all");

      await lab.enableScreenShare(false);
      equal(await lab.isSharingScreen(), false);
      equal(await lab.pcMLineCount(), 3, "and three after it stops");
      const stopped = await lab.pcShape();
      equal(stopped.renegotiationsNeeded, 0, "stopping does not renegotiate either");
      equal(stopped.transceivers.length, 3, "the empty lane is kept, not removed");
      note(`renegotiations across a full share cycle: ${stopped.renegotiationsNeeded}`);
      await lab.pcClose();
    },
  },

  {
    name: "published clones actually encode — frames flow on the mic and camera lanes",
    reset: { enableMic: true, enableCam: true },
    tiers: ["browser"],
    requires: ["loopbackPeerConnection"],
    async run({ lab, note }) {
      await lab.initialize();
      await lab.connect();
      await lab.pcOpen();

      // The single most important assertion on this track. Everything before
      // phase 2b proved a track object existed; this proves a frame did.
      await waitFor(
        async () => {
          const stats = await lab.pcStats();
          return (stats.video.framesEncoded ?? 0) > 0 && stats.audio.packetsSent > 0;
        },
        { timeout: 15_000, interval: 200, message: "no frame was ever encoded on the video lane" },
      );

      const first = await lab.pcStats();
      ok((first.video.framesEncoded ?? 0) > 0, "the camera lane encoded a frame");
      ok(first.audio.packetsSent > 0, "the mic lane sent RTP");
      ok(first.audio.bytesSent > 0, "with bytes in it");

      // Encoding is not the whole path: the far end has to decode it too, and
      // the far end here is a real receiver, not a mock.
      await waitFor(
        async () => {
          const stats = await lab.pcStats();
          return (stats.video.framesDecoded ?? 0) > 0 && stats.audio.packetsReceived > 0;
        },
        { timeout: 15_000, interval: 200, message: "the loopback never decoded a frame" },
      );

      await sleep(1500);
      const later = await lab.pcStats();
      ok(
        (later.video.framesEncoded ?? 0) > (first.video.framesEncoded ?? 0),
        "and it keeps encoding, not one frame and stop",
      );
      ok(later.audio.bytesSent > first.audio.bytesSent, "audio keeps flowing too");
      equal(later.video.senderTrackReadyState, "live");

      const lanes = await lab.pcRemoteTrackLanes();
      includes(lanes, "audio", "the decoded mic track arrived at the far end");
      includes(lanes, "video", "and the decoded camera track");

      // The receiving-side level is what the demo's meter reads (decision 7
      // forbids a Web Audio meter on the capture path), so where it can be
      // read from is a per-engine fact worth recording rather than asserting.
      let level = later.audio;
      for (let attempt = 0; attempt < 20 && (level.audioLevel ?? 0) === 0; attempt++) {
        await sleep(250);
        level = (await lab.pcStats()).audio;
      }
      note(
        (level.audioLevel ?? 0) > 0
          ? `receiver audioLevel readable: ${level.audioLevel} via ${level.audioLevelSource}`
          : `receiver audioLevel stayed 0 on this engine (source reported: ${level.audioLevelSource}) ` +
              `after ${later.audio.packetsSent}+ packets — the fake capture device may simply be silent here`,
      );

      note(
        `audio: codec=${later.audio.codec} packetsSent=${later.audio.packetsSent} ` +
          `bytesSent=${later.audio.bytesSent} audioLevel=${later.audio.audioLevel} ` +
          `(${later.audio.audioLevelSource}) packetsReceived=${later.audio.packetsReceived}`,
      );
      note(
        `video: codec=${later.video.codec} framesEncoded=${later.video.framesEncoded} ` +
          `framesDecoded=${later.video.framesDecoded} ${later.video.frameWidth}x${later.video.frameHeight} ` +
          `@${later.video.framesPerSecond}fps bytesSent=${later.video.bytesSent} ` +
          `qualityLimitation=${later.video.qualityLimitationReason}`,
      );
      await lab.pcClose();
    },
  },

  {
    name: "replaceTrack swaps the mic mid-call, and the stats keep advancing",
    tiers: ["browser"],
    requires: ["loopbackPeerConnection", "multipleMics"],
    async run({ lab, note }) {
      await lab.initialize();
      await lab.connect();
      await lab.pcOpen();
      await waitFor(async () => (await lab.pcStats()).audio.packetsSent > 0, {
        timeout: 15_000,
        interval: 200,
        message: "the mic lane never sent a packet before the switch",
      });

      const before = await lab.pcStats();
      const beforeId = (await lab.pcSenderTrackIds()).audio;
      ok(beforeId, "a track is on the audio sender");
      equal(before.audio.senderTrackId, beforeId, "the stats agree about which track that is");
      const bytesBefore = before.audio.bytesSent;

      const target = await otherMicId(lab);
      ok(target, "a second mic to switch to");
      await lab.updateMic(target);

      const afterId = (await lab.pcSenderTrackIds()).audio;
      ok(afterId, "the sender still has a track after the switch");
      notEqual(afterId, beforeId, "the replaceTrack hook put the new clone on the sender");
      // The whole point of `replaceTrack`: the m-line count and the
      // negotiation state are untouched, so no offer/answer is needed.
      const shape = await lab.pcShape();
      equal(shape.mLineCount, 3, "a device switch changes no m-line");
      equal(shape.renegotiationsNeeded, 0, "and needs no renegotiation");
      equal(shape.connection.local, "connected", "the call never dropped");

      // Not "it is still connected" — "it is still *sending*". A switch that
      // leaves a dead sender attached looks identical from every other angle.
      await waitFor(async () => (await lab.pcStats()).audio.bytesSent > bytesBefore, {
        timeout: 10_000,
        interval: 200,
        message: "the mic lane stopped sending after the switch",
      });
      const after = await lab.pcStats();
      note(
        `mic switch: bytesSent ${before.audio.bytesSent} -> ${after.audio.bytesSent}, track ${beforeId} -> ${afterId}`,
      );
      await lab.pcClose();
    },
  },

  {
    name: "replaceTrack swaps the camera mid-call, and frames keep encoding",
    reset: { enableMic: true, enableCam: true },
    tiers: ["browser"],
    requires: ["loopbackPeerConnection", "multipleCams"],
    async run({ lab, note }) {
      await lab.initialize();
      await lab.connect();
      await lab.pcOpen();
      await waitFor(async () => ((await lab.pcStats()).video.framesEncoded ?? 0) > 0, {
        timeout: 15_000,
        interval: 200,
        message: "the camera lane never encoded before the switch",
      });

      const before = await lab.pcStats();
      const beforeId = (await lab.pcSenderTrackIds()).video;
      const target = await otherCamId(lab);
      ok(target, "a second camera to switch to");
      await lab.updateCam(target);

      const afterId = (await lab.pcSenderTrackIds()).video;
      notEqual(afterId, beforeId, "a new clone is on the video sender");
      const shape = await lab.pcShape();
      equal(shape.renegotiationsNeeded, 0, "a camera switch needs no renegotiation");
      equal(shape.mLineCount, 3);

      const baseline = before.video.framesEncoded ?? 0;
      await waitFor(async () => ((await lab.pcStats()).video.framesEncoded ?? 0) > baseline, {
        timeout: 15_000,
        interval: 200,
        message: "encoding stopped after the camera switch",
      });
      const after = await lab.pcStats();
      note(
        `camera switch: framesEncoded ${baseline} -> ${after.video.framesEncoded}, ` +
          `${after.video.frameWidth}x${after.video.frameHeight}, track ${beforeId} -> ${afterId}`,
      );
      await lab.pcClose();
    },
  },

  {
    name: "the peer connection stopping its own tracks leaves the capture tracks live",
    reset: { enableMic: true, enableCam: true },
    tiers: ["browser"],
    requires: ["loopbackPeerConnection"],
    async run({ lab, note }) {
      await lab.initialize();
      await lab.connect();
      await lab.pcOpen();
      await waitFor(async () => ((await lab.pcStats()).video.framesEncoded ?? 0) > 0, {
        timeout: 15_000,
        interval: 200,
        message: "nothing was encoding before the teardown",
      });

      const capture = await lab.captureTracks();
      const published = await lab.tracks();
      ok(capture.audio && capture.video, "the manager owns capture tracks");
      notEqual(published.audio?.id, capture.audio?.id, "decision 1: what is published is a clone");
      notEqual(published.video?.id, capture.video?.id);

      // Verbatim what `SmallWebRTCTransport.closePeerConnection()` does:
      // `sender.track?.stop()` on every sender. Decision 1 exists entirely so
      // that this cannot kill the live microphone — and it matters because
      // `attemptReconnection(true)` builds the new peer connection *before*
      // closing the old one, so this runs while a call is meant to continue.
      await lab.pcStopSenderTracks();

      const survivors = await lab.captureTracks();
      equal(
        survivors.audio?.readyState,
        "live",
        "the capture mic survived the transport's teardown",
      );
      equal(survivors.video?.readyState, "live", "and so did the capture camera");
      equal(survivors.audio?.id, capture.audio?.id, "same track, not a re-acquire");
      equal(survivors.video?.id, capture.video?.id);
      // One, not two: decision 3 acquires the mic and the camera in a single
      // `getUserMedia`. The number that matters is that it did not go *up*.
      equal(await gumCount(lab), 1, "and nothing had to be re-acquired to make that true");

      const stopped = await lab.tracks();
      equal(stopped.audio?.readyState, "ended", "the published clone is what died");
      equal(stopped.video?.readyState, "ended");
      note("closePeerConnection() stopped both published clones; both capture tracks stayed live");
      await lab.pcClose();
    },
  },

  {
    name: "the encoding policy is applied to the senders, and the engine says what it kept",
    reset: { enableMic: true, enableCam: true },
    tiers: ["browser"],
    requires: ["loopbackPeerConnection", "screenShare"],
    async run({ lab, note }) {
      await lab.initialize();
      await lab.connect();
      await lab.enableScreenShare(true);
      await lab.pcOpen();

      const policy = await lab.encodingPolicy();
      const applied = await lab.pcApplyEncoding();
      equal(applied.length, 3, "one result per lane");

      for (const lane of applied) {
        equal(lane.hasSender, true, `lane ${lane.lane} has a sender`);
        // A parameter the browser drops is a *finding*, not a failure — the
        // note is the deliverable here, and the assertions below only pin what
        // must be true for the policy to mean anything at all.
        note(
          `setParameters[${lane.lane}]: error=${lane.error} encodings=${lane.encodingCount} ` +
            `degradationPreference=${lane.degradationPreference} (asked ${lane.requested.degradationPreference}) ` +
            `maxBitrate=${lane.maxBitrate} (asked ${lane.requested.maxBitrate}) ` +
            `maxFramerate=${lane.maxFramerate} (asked ${lane.requested.maxFramerate})`,
        );
        equal(lane.error, null, `setParameters was accepted for ${lane.lane}`);
        ok(lane.encodingCount >= 1, `${lane.lane} reports at least one encoding`);
      }

      const screen = applied.find((a) => a.lane === "screenVideo");
      ok(screen, "the screen lane is in the report");
      // Decision 8's two numbers, read back off the sender rather than trusted.
      equal(screen.maxBitrate, policy["screenVideo"]?.maxBitrate, "screen maxBitrate stuck");
      equal(screen.maxFramerate, 5, "screen maxFramerate stuck at the policy's 5");
      equal(
        screen.degradationPreference,
        "maintain-resolution",
        "a scroll drops frames, never sharpness",
      );

      const video = applied.find((a) => a.lane === "video");
      ok(video, "the camera lane is in the report");
      equal(video.maxBitrate, policy["video"]?.maxBitrate, "camera maxBitrate stuck");
      equal(video.maxFramerate, 30);
      equal(video.degradationPreference, "maintain-framerate", "a face stays smooth, not sharp");

      const audio = applied.find((a) => a.lane === "audio");
      ok(audio, "the mic lane is in the report");
      equal(audio.maxBitrate, policy["audio"]?.maxBitrate, "mic maxBitrate stuck");
      // The policy records 0 rather than omitting the field, and 0 is never set.
      equal(audio.maxFramerate, null, "maxFramerate is meaningless for audio and is not set");
      await lab.pcClose();
    },
  },

  {
    name: "a screen share started mid-call encodes without disturbing the other lanes",
    reset: { enableMic: true, enableCam: true },
    tiers: ["browser"],
    requires: ["loopbackPeerConnection", "screenShare"],
    async run({ lab, note }) {
      await lab.initialize();
      await lab.connect();
      await lab.pcOpen();
      await waitFor(async () => ((await lab.pcStats()).video.framesEncoded ?? 0) > 0, {
        timeout: 15_000,
        interval: 200,
        message: "the camera lane never started",
      });

      const before = await lab.pcStats();
      equal(before.screenVideo.senderTrackId, null, "lane 2 is empty but present");
      equal(before.screenVideo.framesEncoded ?? 0, 0, "and has encoded nothing");

      // The call is already connected. Nothing below renegotiates.
      await lab.enableScreenShare(true);
      const senderIds = await lab.pcSenderTrackIds();
      ok(senderIds.screenVideo, "the replaceTrack hook published the screen clone onto lane 2");
      await lab.pcApplyEncoding();

      await waitFor(async () => ((await lab.pcStats()).screenVideo.framesEncoded ?? 0) > 0, {
        timeout: 20_000,
        interval: 250,
        message: "the screen lane never encoded a frame",
      });

      const after = await lab.pcStats();
      ok((after.screenVideo.framesEncoded ?? 0) > 0, "lane 2 is encoding");
      // The other two lanes are the point: a share must not cost the call.
      ok(
        (after.video.framesEncoded ?? 0) > (before.video.framesEncoded ?? 0),
        "the camera lane kept encoding through the share",
      );
      ok(after.audio.bytesSent > before.audio.bytesSent, "and the mic lane kept sending");
      const shape = await lab.pcShape();
      equal(shape.renegotiationsNeeded, 0, "no renegotiation was needed for any of it");
      equal(shape.connection.local, "connected");
      includes(await lab.pcRemoteTrackLanes(), "screenVideo", "the far end decoded lane 2");

      note(
        `mid-call share: screen framesEncoded=${after.screenVideo.framesEncoded} ` +
          `${after.screenVideo.frameWidth}x${after.screenVideo.frameHeight} ` +
          `@${after.screenVideo.framesPerSecond}fps decoded=${after.screenVideo.framesDecoded}`,
      );
      await lab.pcClose();
    },
  },

  {
    name: "camera and screen encode at once — the screen holds resolution, the camera holds frame rate",
    reset: { enableMic: true, enableCam: true },
    tiers: ["browser"],
    requires: ["loopbackPeerConnection", "screenShare"],
    async run({ lab, note }) {
      await lab.initialize();
      await lab.connect();
      await lab.enableScreenShare(true);
      await lab.pcOpen();

      // Decision 10: both are live at the same time, on their own lanes, with
      // opposite degradation preferences. This is the case that would have
      // caught a shared-slot implementation.
      await waitFor(
        async () => {
          const stats = await lab.pcStats();
          return (stats.video.framesEncoded ?? 0) > 5 && (stats.screenVideo.framesEncoded ?? 0) > 2;
        },
        { timeout: 25_000, interval: 250, message: "the two video lanes never encoded together" },
      );

      const stats = await lab.pcStats();
      const camera = stats.video;
      const screen = stats.screenVideo;
      notEqual(camera.senderTrackId, screen.senderTrackId, "two distinct tracks, two lanes");
      ok(camera.packetsSent > 0 && screen.packetsSent > 0, "both lanes are on the wire");
      ok(stats.audio.packetsSent > 0, "with audio underneath both");

      // "Holds resolution" and "holds frame rate" as measurables: the screen
      // is sent at its native size and few frames, the camera is small and
      // smooth. Ranges rather than exact numbers — the display size is the
      // host's, not ours — with the real figures in the note.
      ok((screen.frameHeight ?? 0) >= 720, `screen keeps its resolution (${screen.frameHeight}p)`);
      ok((camera.frameHeight ?? 0) <= 480, `camera is downscaled (${camera.frameHeight}p)`);
      ok(
        (screen.frameHeight ?? 0) > (camera.frameHeight ?? 0),
        "the screen is the bigger picture of the two",
      );
      ok(
        (camera.framesPerSecond ?? 0) >= (screen.framesPerSecond ?? 0),
        `the camera is the smoother of the two (${camera.framesPerSecond} vs ${screen.framesPerSecond} fps)`,
      );
      ok(
        (screen.framesPerSecond ?? 0) <= 8,
        `the screen honours its 5fps cap (${screen.framesPerSecond})`,
      );

      note(
        `simultaneous — camera: ${camera.frameWidth}x${camera.frameHeight} @${camera.framesPerSecond}fps ` +
          `framesEncoded=${camera.framesEncoded} bytesSent=${camera.bytesSent} codec=${camera.codec}; ` +
          `screen: ${screen.frameWidth}x${screen.frameHeight} @${screen.framesPerSecond}fps ` +
          `framesEncoded=${screen.framesEncoded} bytesSent=${screen.bytesSent} ` +
          `qualityLimitation=${screen.qualityLimitationReason}`,
      );
      await lab.pcClose();
    },
  },
];
