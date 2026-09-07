/**
 * Tier 2, phase 4 — scenarios 6 and 7, on a media path a test can break.
 *
 * Everything else in this suite runs over a same-page loopback, where both
 * peers find each other directly and the only way to end a call is to close
 * it.
 * These tests run over the Node-side UDP relay (`relay/udpRelay.ts`) with
 * pipecat's own reconnect state machine on top (`src/transport.ts`), so the
 * two failures that matter in production become things a test can *do*:
 *
 *   6. the network path changes — `netRebind()` closes the ports the call is
 *      using and opens different ones, which is what a laptop moving from
 *      Wi-Fi to a VPN looks like to the far end.
 *   7. ICE gets wedged — `netBlackhole()` leaves the path in place and stops
 *      the packets, so consent checks go unanswered and nothing on either peer
 *      changes.
 *
 * What is under proof is never "WebRTC reconnects". It is the manager's half:
 * across a break and a recovery, **the capture tracks stay live, no second
 * `getUserMedia` is issued, and the m-line count stays at three**. A call that
 * comes back by re-prompting the user for their microphone has not come back.
 */
import { expect, test, type Page } from "@playwright/test";

import { LAB_METHODS } from "../lab/lab";
import { LabError, type LabApi, type LabMethod, type LabResult } from "../lab/labApi";

function remoteLab(page: Page): LabApi {
  const api: Record<string, unknown> = {};
  for (const method of LAB_METHODS) {
    api[method] = async (...args: unknown[]): Promise<unknown> => {
      const result = (await page.evaluate(
        ([name, callArgs]) => window.__lab.call(name as LabMethod, callArgs as unknown[]),
        [method, args] as [string, unknown[]],
      )) as LabResult;
      if (result.ok) return result.value;
      throw new LabError(result.error);
    };
  }
  return api as unknown as LabApi;
}

/**
 * The relay is real UDP between two real peer connections, and every step is a
 * timeout somewhere: ICE consent failure, pipecat's `disconnected` grace, a
 * rebuild, and a fresh set of connectivity checks. 90 s is slack, not an
 * expectation — the fast paths finish in well under ten.
 */
test.describe.configure({ timeout: 90_000 });

test.beforeEach(async ({ page }) => {
  await page.goto("/probe.html");
});

/** A call with a live microphone on lane 0, running through the relay. */
async function callThroughRelay(page: Page): Promise<LabApi> {
  const lab = remoteLab(page);
  await lab.reset({ enableMic: true, enableCam: false });
  const caps = await lab.capabilities();
  // A named skip, never a silent pass — an engine that cannot open a peer
  // connection on this host has not proven anything about a wedged one.
  test.skip(!caps.loopbackPeerConnection, "engine cannot open a peer connection on this host");
  await lab.initialize();
  await lab.connect();
  const captured = await lab.captureTracks();
  test.skip(!captured.audio, "engine produced no microphone track to put on the wire");
  // Firefox forms no candidate pair against a loopback remote (see
  // `RelayPorts.address`), so on a host with no non-internal IPv4 the relay
  // can only advertise `127.0.0.1` and this engine cannot reach it at all.
  // Chromium and webkit still can, so the skip is per-engine and named.
  const address = (await (await fetch(`${new URL(page.url()).origin}/__relay/address`)).json()) as {
    address: string;
  };
  test.skip(
    address.address === "127.0.0.1" && page.context().browser()?.browserType().name() === "firefox",
    "no non-loopback IPv4 on this host: Firefox gathers no loopback ICE candidate, so the relay is unreachable",
  );
  await lab.netOpen({ disconnectedGraceMs: 500, maxReconnectionAttempts: 20 });
  return lab;
}

test("the relay carries a real call — every packet crosses the middle", async ({ page }) => {
  const lab = await callThroughRelay(page);
  const relay = await lab.netRelayStats();

  // Both counters non-zero is the load-bearing assertion of this whole file:
  // it says the peers are not talking directly and the middle is real. If
  // either were zero the rest of the suite would be testing nothing.
  expect(relay.forwardedAToB, "client -> server datagrams").toBeGreaterThan(0);
  expect(relay.forwardedBToA, "server -> client datagrams").toBeGreaterThan(0);

  const snapshot = await lab.netSnapshot();
  expect(snapshot.connectionState).toBe("connected");
  expect(snapshot.generation, "one peer connection, never rebuilt").toBe(1);
  expect(snapshot.mLineCount, "decision 4: three lanes, always").toBe(3);
});

test("scenario 7 — a wedged path recovers, with the same capture track and no re-prompt", async ({
  page,
}, testInfo) => {
  const lab = await callThroughRelay(page);
  const before = await lab.captureTracks();
  const gumBefore = (await lab.gumCalls()).length;
  expect(before.audio?.readyState).toBe("live");

  await lab.netBlackhole();
  const broken = await lab.netWaitBroken(45_000);
  testInfo.annotations.push({
    type: "finding",
    description: `[${testInfo.project.name}] blackhole -> iceConnectionState:${broken}`,
  });

  // pipecat rebuilds the peer connection rather than restarting ICE. Wait for
  // the second one to exist before letting the path back up, so the recovery
  // being measured is a real rebuild and not the original connection healing.
  await lab.netWaitGeneration(2, 45_000);

  // The wedge must not have touched capture. Nothing about a dead network is
  // a reason to stop a microphone, and stopping one is unrecoverable without
  // a fresh prompt on every engine.
  const during = await lab.captureTracks();
  expect(during.audio?.readyState, "the capture mic died during the wedge").toBe("live");
  expect(during.audio?.id, "the capture mic was re-acquired during the wedge").toBe(
    before.audio?.id,
  );

  await lab.netResume();
  await lab.netWaitConnected(45_000);

  const after = await lab.captureTracks();
  expect(after.audio?.readyState).toBe("live");
  expect(after.audio?.id, "the capture mic changed identity across the recovery").toBe(
    before.audio?.id,
  );
  expect((await lab.gumCalls()).length, "the recovery re-prompted for the microphone").toBe(
    gumBefore,
  );
  expect((await lab.netSnapshot()).mLineCount).toBe(3);

  // And the media itself. A connected peer connection that carries no packets
  // is the failure this scenario is really about.
  await expect
    .poll(async () => (await lab.netLanes())[0]?.packetsReceived ?? 0, { timeout: 20_000 })
    .toBeGreaterThan(0);
});

test("scenario 6 — the path moves and the call follows it", async ({ page }, testInfo) => {
  const lab = await callThroughRelay(page);
  const before = await lab.captureTracks();
  const gumBefore = (await lab.gumCalls()).length;

  // Close the ports the call is using and open different ones. The peers are
  // untouched: what changed is the address that works.
  await lab.netRebind();
  const broken = await lab.netWaitBroken(45_000);
  testInfo.annotations.push({
    type: "finding",
    description: `[${testInfo.project.name}] rebind -> iceConnectionState:${broken}`,
  });

  await lab.netWaitConnected(45_000);
  const relay = await lab.netRelayStats();
  expect(relay.rebinds).toBe(1);
  expect(relay.forwardedAToB, "no traffic on the new path").toBeGreaterThan(0);
  expect(relay.forwardedBToA, "no traffic back along the new path").toBeGreaterThan(0);

  const after = await lab.captureTracks();
  expect(after.audio?.readyState, "the capture mic died when the path moved").toBe("live");
  expect(after.audio?.id).toBe(before.audio?.id);
  expect((await lab.gumCalls()).length, "moving the path re-prompted for the microphone").toBe(
    gumBefore,
  );
  expect((await lab.netSnapshot()).mLineCount).toBe(3);

  await expect
    .poll(async () => (await lab.netLanes())[0]?.packetsReceived ?? 0, { timeout: 20_000 })
    .toBeGreaterThan(0);
});

test.afterEach(async ({ page }) => {
  await page.evaluate(() => window.__lab.call("netClose", [])).catch(() => {});
  await page.evaluate(() => window.__lab.call("disconnect", [])).catch(() => {});
});
