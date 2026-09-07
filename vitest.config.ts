import { defineConfig } from "vitest/config";

// Tier 1 — the contract cases against the fake `MediaDevices`, in node with no
// browser at all. This tier proves the state machine; tier 2 (`e2e/`, the same
// case bodies through Playwright) proves the browsers. See docs/TESTING.md.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
