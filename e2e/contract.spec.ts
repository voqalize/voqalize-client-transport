/**
 * Tier 2 — the same contract suite, in chromium, firefox and webkit.
 *
 * Every body here comes from `tests/contract/cases.ts` unchanged. What this
 * file supplies is the transport: a `LabApi` whose every method is one
 * `page.evaluate` into `window.__lab.call(method, args)`, with the result
 * envelope unwrapped on the node side.
 *
 * The envelope is not ceremony. An exception thrown inside `page.evaluate`
 * reaches node with its `name` folded into the message, and `name` is exactly
 * what the error-mapping cases assert on — so errors cross as data and are
 * rethrown here.
 *
 * SPEC.md § Test taxonomy: "A tier-1 pass that fails tier 2 is a bug in our
 * model of the browser." When these disagree, fix the manager or the fake.
 */
import { test, type Page } from "@playwright/test";

import { LAB_METHODS } from "../lab/lab";
import { LabError, type LabApi, type LabMethod, type LabResult } from "../lab/labApi";
import type { LabCapabilities } from "../lab/labPlatform";
import { CONTRACT_CASES, type Tier } from "../tests/contract/cases";

const TIER: Tier = "browser";

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

test.beforeEach(async ({ page }) => {
  await page.goto("/probe.html");
});

for (const contractCase of CONTRACT_CASES) {
  const tiers = contractCase.tiers ?? ["unit", "browser"];
  if (!tiers.includes(TIER)) {
    test.skip(`${contractCase.name} [tier-1-only case]`, () => {});
    continue;
  }

  test(contractCase.name, async ({ page }, testInfo) => {
    const lab = remoteLab(page);
    await lab.reset(contractCase.reset);
    const caps: LabCapabilities = await lab.capabilities();
    testInfo.annotations.push({
      type: "capabilities",
      description: `[${testInfo.project.name}] ${JSON.stringify(caps)}`,
    });

    const missing = (contractCase.requires ?? []).filter((key) => !caps[key]);
    if (missing.length > 0) {
      // An engine that cannot support an assertion is recorded by name. This
      // is how "Firefox enumerates exactly one microphone" stays visible in
      // the run output instead of turning into a silently green test.
      test.skip(true, `${testInfo.project.name} lacks: ${missing.join(", ")}`);
      return;
    }

    await contractCase.run({
      lab,
      caps,
      note: (text) =>
        testInfo.annotations.push({
          type: "finding",
          description: `[${testInfo.project.name}] ${text}`,
        }),
    });
  });
}

test.afterEach(async ({ page }) => {
  // Best effort: a failed case can leave a live capture track behind, and the
  // next test in the same worker gets a fresh page anyway.
  await page.evaluate(() => window.__lab.call("disconnect", [])).catch(() => {});
});
