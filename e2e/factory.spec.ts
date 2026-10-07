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
  expect(injected.ours).toBe(true);
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

test("the playout guard leaves a healthy call alone", async ({ page }) => {
  // A real click first, so no engine's autoplay policy decides the outcome.
  await page.mouse.click(1, 1);
  const result = await page.evaluate(() => window.__factory.healthyPlayout(5_000));
  expect(result.paused).toBe(false);
  expect(result.samplesAdvanced).toBe(true);
  expect(result.recoveries).toEqual([]);
});

test("keepAcrossPageLoads rejoins across a real reload, and forgets a refused call", async ({
  page,
}) => {
  const offers: Array<{ authorization: string | null; pcId: unknown }> = [];
  let answer = 0; // 0: hold the offer, as a slow server would; else the status.
  await page.route("**/__offer", async (route) => {
    const body = route.request().postDataJSON() as { pc_id?: unknown };
    offers.push({
      authorization: await route.request().headerValue("authorization"),
      pcId: body.pc_id,
    });
    if (answer) await route.fulfill({ status: answer, body: "{}" });
  });
  const endpoint = "http://127.0.0.1:5183/__offer";

  expect(await page.evaluate(() => window.__factory.keptPage())).toBe(false);
  await page.evaluate(
    (endpoint) => window.__factory.keptConnect({ endpoint, token: "t1" }),
    endpoint,
  );
  await expect.poll(() => offers.length).toBe(1);

  // The page goes away mid-call. Nothing hangs up; the next page finds the call.
  await page.reload();
  answer = 410;
  expect(await page.evaluate(() => window.__factory.keptPage())).toBe(true);
  await page.evaluate(() => window.__factory.keptConnect(null));
  await expect
    .poll(() => page.evaluate(() => window.__factory.keptState().outcome))
    .toMatch(/^rejected/);

  // The same request, as a fresh offer: no peer-connection id.
  expect(offers[1]).toEqual({ authorization: "Bearer t1", pcId: null });
  expect(offers.length).toBe(2);
  // The server refused it, so the call is gone, and the next page starts none.
  expect(await page.evaluate(() => window.__factory.keptState().hasLiveCall)).toBe(false);
  await page.reload();
  expect(await page.evaluate(() => window.__factory.keptPage())).toBe(false);
});

// The network changing under a call: a real transport, a real rebuild, and an
// in-page bot on the far end (`lab/inPageBot.ts`).
test.describe("a rebuilt connection", () => {
  // Not on WebKit. With both ends of a call in one page, WebKit leaves the
  // rebuilt connection's DTLS at "connecting" beside the old one: always on
  // CI's Linux WebKit, now and then on macOS. The transport has done its part
  // by then (the restart offer went out and was answered), and a bare second
  // loopback connection comes up fine there, so it is something of the
  // in-page shape, not of ours. The logic is covered in
  // `tests/reconnect.test.ts`; Chromium and Firefox run it end to end.
  test.beforeEach(({ browserName }) => {
    test.skip(browserName === "webkit", "WebKit stalls a rebuilt in-page connection at DTLS");
  });

  test("the agent is heard again after the connection is rebuilt", async ({ page }) => {
    await page.mouse.click(1, 1);
    const result = await page.evaluate(() => window.__factory.rebuildCall(true, "failed"));
    expect(result, JSON.stringify(result)).toMatchObject({
      firstHeard: true,
      rebuilt: true,
      restart: true,
      newHeard: true,
    });
  });

  // The control. The stock transport loses the new connection's audio
  // (pipecat 1.10.6 through 1.10.8; `src/reconnect.ts`). When this starts
  // failing, pipecat has fixed it, and the workaround can go.
  test("the stock transport is not heard after a rebuild", async ({ page }) => {
    await page.mouse.click(1, 1);
    const result = await page.evaluate(() => window.__factory.rebuildCall(false, "failed"));
    expect(result, JSON.stringify(result)).toMatchObject({
      firstHeard: true,
      rebuilt: true,
      newHeard: false,
    });
  });

  test("a disconnected path is rebuilt after the short grace, not five seconds", async ({
    page,
  }) => {
    await page.mouse.click(1, 1);
    const result = await page.evaluate(() => window.__factory.rebuildCall(true, "disconnected"));
    expect(result, JSON.stringify(result)).toMatchObject({ rebuilt: true, newHeard: true });
    expect(result.offerAfterMs).toBeGreaterThanOrEqual(1_400);
    expect(result.offerAfterMs).toBeLessThan(4_000);
  });
});
