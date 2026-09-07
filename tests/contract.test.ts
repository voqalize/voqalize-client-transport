/**
 * Tier 1 — the contract suite against the fake MediaDevices platform, in node.
 *
 * This file is a *runner*, not a suite: every assertion lives in
 * `tests/contract/cases.ts` and is shared verbatim with `contract.spec.ts`,
 * which runs the same bodies in chromium, firefox and webkit. Nothing that
 * looks like a test belongs here.
 */
import { afterAll, describe, it } from "vitest";

import { Lab, localLabApi } from "../lab/lab";
import { FakeLabPlatform } from "../lab/labPlatform";
import type { LabCapabilities } from "../lab/labPlatform";
import { CONTRACT_CASES, type Tier } from "./contract/cases";

const TIER: Tier = "unit";

const lab = new Lab(() => new FakeLabPlatform());
const api = localLabApi(lab);
const notes: string[] = [];

afterAll(async () => {
  if (notes.length > 0) {
    // Measured observations, not assertions. Tier 2 prints the same list per
    // engine, and the differences between the two are what land in Findings.
    console.log(`\n[tier 1 — fake platform] observations:\n  ${notes.join("\n  ")}`);
  }
});

describe("VoqalizeMediaManager contract — tier 1 (fake MediaDevices)", () => {
  for (const contractCase of CONTRACT_CASES) {
    const tiers = contractCase.tiers ?? ["unit", "browser"];
    if (!tiers.includes(TIER)) {
      it.skip(`${contractCase.name} [browser-only case]`, () => {});
      continue;
    }

    it(contractCase.name, async (ctx) => {
      await api.reset(contractCase.reset);
      const caps: LabCapabilities = await api.capabilities();
      const missing = (contractCase.requires ?? []).filter((key) => !caps[key]);
      if (missing.length > 0) {
        // Named, never silent: a capability an engine lacks is a fact about
        // that engine, and a case that quietly weakened itself would hide it.
        ctx.skip(true, `platform lacks: ${missing.join(", ")}`);
        return;
      }
      await contractCase.run({
        lab: api,
        caps,
        note: (text) => notes.push(`${contractCase.name}: ${text}`),
      });
    });
  }
});
