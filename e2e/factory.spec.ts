/**
 * The factory's own proof.
 *
 * The contract suite (`tests/contract/cases.ts`, run in both tiers) drives a
 * `VoqalizeMediaManager` directly — that is what lets tier 1 run the same
 * bodies in node. It therefore never touches `createVoqalizeTransport()`,
 * which is the only function most consumers will call. This file covers that
 * gap, against a real `SmallWebRTCTransport` and real `RTCPeerConnection`s.
 *
 * The claim under test is narrow and load-bearing: an injected media manager
 * receives **no** track-changed wiring from stock pipecat 1.10.x, because the
 * transport passes that callback into the *constructor* of its own default
 * manager, in the branch it takes only when you did not supply one. Without the
 * factory, a mic swapped mid-call is published by the manager and never
 * reaches a sender — the call stays up and the far end keeps the old track.
 */
import { test, expect } from "@playwright/test";
import type { Factory } from "../lab/factory";

declare global {
  interface Window {
    __factory: Factory;
  }
}

test.beforeEach(async ({ page }) => {
  await page.goto("/factory.html");
  await page.evaluate(() => window.__factory.build());
});

test.afterEach(async ({ page }) => {
  await page.evaluate(() => window.__factory.teardown()).catch(() => {});
});

test("the transport holds our manager, and the page loaded no foreign code", async ({ page }) => {
  const injected = await page.evaluate(() => window.__factory.injected());
  expect(injected.sameObject).toBe(true);
  expect(injected.constructorName).toBe("VoqalizeMediaManager");
  // The point of the package: nothing in the media path fetches code at
  // runtime, so a transport that fell back to a manager that does would show
  // up here even if it passed every behavioural assertion below.
  expect(injected.foreignScripts).toEqual([]);
});

test("initDevices() acquires through our manager and tracks() reports it", async ({ page }) => {
  const result = await page.evaluate(() => window.__factory.initDevices());
  expect(result.kind).toBe("audio");
  expect(result.readyState).toBe("live");
});

test("getAllMics() is answered by our manager", async ({ page }) => {
  expect(await page.evaluate(() => window.__factory.getAllMics())).toBeGreaterThan(0);
});

for (const withGetter of [true, false]) {
  const path = withGetter
    ? "through the transport's own getAudioTransceiver()"
    : "through the standards-only sender fallback";

  test(`a mid-call mic switch reaches the live sender — ${path}`, async ({ page }) => {
    await page.evaluate(() => window.__factory.initDevices());
    const result = await page.evaluate(
      (flag) => window.__factory.switchMicOnLiveSender(flag),
      withGetter,
    );

    expect(result.before).not.toBeNull();
    expect(result.published).not.toBeNull();
    // The switch produced a genuinely different published clone…
    expect(result.published).not.toBe(result.before);
    // …and the sender is carrying it. Without the factory's wiring, `after`
    // would still equal `before`: that is the defect this test pins.
    expect(result.after).toBe(result.published);
  });
}

test("attachTrackChangedHandler wires a transport the factory did not build", async ({ page }) => {
  expect(await page.evaluate(() => window.__factory.attachByHand())).toBe(true);
});
