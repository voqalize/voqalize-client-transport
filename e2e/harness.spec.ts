/**
 * Tier 2 — conformance tests. Proves the harness itself (real
 * navigator.mediaDevices, fake capture devices, no hardware touched), not
 * any MediaManager behaviour — there is none yet. See SPEC.md § Test
 * taxonomy.
 *
 * Every assertion an engine cannot support is an explicit `test.skip` with
 * a comment saying why, never a silent pass. Read lab/README.md for the
 * measured per-engine table this file produces.
 */
import { test, expect } from "@playwright/test";
import type { Probe } from "../lab/probe";

// The probe's own module declares `window.__probe`'s type; importing the
// type here (rather than redeclaring it) is what keeps this file and
// src/probe.ts from drifting out of sync.
declare global {
  interface Window {
    __probe: Probe;
  }
}

test.beforeEach(async ({ page }) => {
  await page.goto("/probe.html");
});

test.afterEach(async ({ page }) => {
  // Best-effort — a failed test may leave live tracks; don't let that fail cleanup too.
  await page.evaluate(() => window.__probe.stopAllTracks()).catch(() => {});
});

test("navigator.mediaDevices exists in a secure context", async ({ page }) => {
  const env = await page.evaluate(() => window.__probe.environment());
  expect(env.secureContext).toBe(true);
  expect(env.hasMediaDevices).toBe(true);
});

test("enumerateDevices returns at least one audioinput", async ({ page }) => {
  const devices = await page.evaluate(() => window.__probe.enumerateDevices());
  const audioInputs = devices.filter((d) => d.kind === "audioinput");
  expect(audioInputs.length).toBeGreaterThan(0);
});

test("getUserMedia({audio:true}) yields a live audio track", async ({ page }) => {
  const tracks = await page.evaluate(() => window.__probe.getUserMedia({ audio: true }));
  expect(tracks).toHaveLength(1);
  expect(tracks[0]?.kind).toBe("audio");
  expect(tracks[0]?.readyState).toBe("live");
});

test("getUserMedia({video:true}) yields a live video track", async ({ page }) => {
  const tracks = await page.evaluate(() => window.__probe.getUserMedia({ video: true }));
  expect(tracks).toHaveLength(1);
  expect(tracks[0]?.kind).toBe("video");
  expect(tracks[0]?.readyState).toBe("live");
});

test("one getUserMedia({audio:true,video:true}) call resolves both tracks", async ({ page }) => {
  // SPEC.md design decision 3: one gUM call for audio+video together — WebKit
  // stops an earlier track when a second gUM targets the same device group.
  // This test proves the *browser* handles the combined call; it says
  // nothing yet about our manager, which doesn't exist.
  const tracks = await page.evaluate(() =>
    window.__probe.getUserMedia({ audio: true, video: true }),
  );
  expect(tracks).toHaveLength(2);
  const kinds = tracks.map((t) => t.kind).sort();
  expect(kinds).toEqual(["audio", "video"]);
  for (const track of tracks) {
    expect(track.readyState).toBe("live");
  }
});

test("device labels — recorded, not asserted either way", async ({ page }, testInfo) => {
  // Label population differs by engine/permission state and matters later
  // for device-picker UI. We record what we saw rather than assert a
  // specific answer, since the "right" answer is engine policy, not a bug.
  await page.evaluate(() => window.__probe.getUserMedia({ audio: true }));
  const devices = await page.evaluate(() => window.__probe.enumerateDevices());
  const audioInputs = devices.filter((d) => d.kind === "audioinput");
  const labelsPopulated = audioInputs.length > 0 && audioInputs.every((d) => d.label.length > 0);
  await testInfo.attach("audioinput-labels", {
    body: JSON.stringify(audioInputs, null, 2),
    contentType: "application/json",
  });
  testInfo.annotations.push({
    type: "finding",
    description: `[${testInfo.project.name}] audioinput labels populated after grant: ${labelsPopulated}`,
  });
  // Sanity only — some browsers legitimately return "" until a track from
  // that exact device is live, which the getUserMedia above just did.
  expect(typeof labelsPopulated).toBe("boolean");
});

test("getDisplayMedia — existence and auto-accept, recorded per engine", async ({
  page,
}, testInfo) => {
  const exists = await page.evaluate(() => window.__probe.hasGetDisplayMedia());
  testInfo.annotations.push({
    type: "finding",
    description: `[${testInfo.project.name}] getDisplayMedia exists: ${exists}`,
  });
  if (!exists) {
    test.skip(
      true,
      `${testInfo.project.name}: navigator.mediaDevices.getDisplayMedia is not implemented`,
    );
    return;
  }
  const result = await page.evaluate(() => window.__probe.getDisplayMedia());
  testInfo.annotations.push({
    type: "finding",
    description: `[${testInfo.project.name}] getDisplayMedia auto-accept: ${JSON.stringify(result)}`,
  });
  // Record, don't assert a specific outcome — an engine that requires a
  // real user gesture or a real screen-capture source is expected to
  // reject headless, and that rejection is the finding.
  expect(result).toHaveProperty("ok");
});

test("HTMLMediaElement.setSinkId — existence recorded per engine", async ({ page }, testInfo) => {
  const exists = await page.evaluate(() => window.__probe.hasSetSinkId());
  testInfo.annotations.push({
    type: "finding",
    description: `[${testInfo.project.name}] setSinkId exists: ${exists}`,
  });
  expect(typeof exists).toBe("boolean");
});

test("stop() transitions readyState to ended and fires no ended event", async ({ page }) => {
  // This is the browser contract our recovery logic (SPEC.md design
  // decisions, "ended"/"mute" recovery) depends on: a locally-stopped track
  // must NOT look like a device-initiated failure. Proving it here, against
  // real engines, is the point of tier 2 mirroring tier 1's fake.
  const [track] = await page.evaluate(() => window.__probe.getUserMedia({ audio: true }));
  expect(track).toBeDefined();
  const id = track!.id;

  const firedPromise = page.evaluate(
    ({ id, timeoutMs }) => window.__probe.waitForEvent(id, "ended", timeoutMs),
    { id, timeoutMs: 500 },
  );
  await page.evaluate((id) => window.__probe.stopTrack(id), id);
  const fired = await firedPromise;
  expect(fired).toBe(false);

  const state = await page.evaluate((id) => window.__probe.getTrackState(id), id);
  expect(state?.readyState).toBe("ended");
});
