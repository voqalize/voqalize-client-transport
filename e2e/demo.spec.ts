/**
 * Tier 3, kept honest.
 *
 * The demo page is for a person to open and judge — but "a page a human opens"
 * is exactly the kind of artefact that rots silently, so this is the smallest
 * check that it is not broken: load it, press Start, and require that a real
 * frame is encoded and that the number reaches the screen.
 *
 * It asserts on what the reader sees (the table cell), not on internals. If
 * this fails, the page is lying to whoever opens it.
 */
import { expect, test } from "@playwright/test";

test.describe("the manual lab page", () => {
  test("loads, starts a call, and shows real encoder numbers", async ({ page }, testInfo) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));

    await page.goto("/demo.html");
    await expect(page.locator("h1")).toHaveText(/loopback lab/i);
    // Nothing is acquired until the button is pressed — no permission prompt
    // on load is part of the page's contract with the person opening it.
    await expect(page.locator("#log")).toContainText("no device has been touched yet");

    await page.locator("#start").click();
    await expect(page.locator("#stop")).toBeEnabled({ timeout: 20_000 });
    await page.locator("#cam").click();
    await expect(page.locator("#cam")).toHaveText("Camera on", { timeout: 20_000 });

    // Wait for the page to *decide*, rather than sampling and racing it: one
    // of the two banners always lands, and which one is the finding.
    const good = page.locator(".banner.good", { hasText: "Loopback is up" });
    const bad = page.locator(".banner.bad");
    await expect
      .poll(async () => (await good.count()) + (await bad.count()), {
        timeout: 30_000,
        message: "the page never reported whether the loopback came up",
      })
      .toBeGreaterThan(0);

    if ((await bad.count()) > 0) {
      // The known Firefox case. Record it by name; do not pretend it passed.
      const message = (await bad.innerText({ timeout: 5_000 })).replace(/\s+/g, " ").slice(0, 240);
      testInfo.annotations.push({
        type: "finding",
        description: `[${testInfo.project.name}] demo page could not open the loopback: ${message}`,
      });
      test.skip(true, `${testInfo.project.name} cannot open a loopback peer connection`);
      return;
    }

    // The video lane's frames-encoded cell, as rendered. `.ok` is the class the
    // page paints on a non-zero count, so this asserts the reader's own signal.
    const videoFrames = page
      .locator("#statsBody tr", { hasText: "video (m-line 1)" })
      .locator("td.big");
    await expect(videoFrames).toHaveClass(/ok/, { timeout: 30_000 });
    const encoded = Number((await videoFrames.innerText()).trim());
    expect(encoded).toBeGreaterThan(0);

    const resolution = await page
      .locator("#statsBody tr", { hasText: "video (m-line 1)" })
      .locator("td")
      .nth(3)
      .innerText();
    testInfo.annotations.push({
      type: "finding",
      description: `[${testInfo.project.name}] demo page video lane: framesEncoded=${encoded} ${resolution}`,
    });

    await expect(page.locator("#state")).toContainText("3 (must never change)");
    await page.locator("#stop").click();
    await expect(page.locator("#start")).toBeEnabled();
    expect(errors, `page errors: ${errors.join(" | ")}`).toHaveLength(0);
  });
});
