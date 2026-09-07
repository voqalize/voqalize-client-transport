/**
 * Tier-2 conformance config — the same probe, driven from three real
 * browser engines with fake capture devices, so no test here ever touches
 * real hardware.
 *
 * Per-engine fake-media story, verified empirically (see lab/README.md for
 * the measured support table — do not trust this comment block over that
 * table if they ever disagree):
 *
 * - **chromium**: `--use-fake-device-for-media-stream` presents a synthetic
 *   camera/mic; `--use-fake-ui-for-media-stream` skips the permission
 *   prompt instead of just pre-granting it, which matters because a
 *   pre-granted permission without this flag still shows a UI in some
 *   configurations. `--use-fake-ui-for-media-stream` also auto-accepts a
 *   `getDisplayMedia()` prompt, picking the first available fake source, so
 *   no separate `--auto-select-desktop-capture-source` is needed for the
 *   synthetic case tier 2 exercises.
 * - **firefox**: no CLI flags — Firefox is configured entirely through
 *   `firefoxUserPrefs`. `media.navigator.streams.fake` swaps in synthetic
 *   devices; `media.navigator.permission.disabled` removes the permission
 *   prompt so `getUserMedia` doesn't hang waiting for a click that never
 *   comes.
 * - **webkit**: Playwright's WebKit has no equivalent of either flag above.
 *   `use.permissions` pre-grants the permission (WebKit *does* honor that),
 *   but there is no synthetic-device switch — `getUserMedia` on a CI/headless
 *   box with no real camera/mic fails or hangs. See the README table for
 *   exactly what was and wasn't reachable, and the harness spec for how
 *   tests skip the parts that aren't.
 */
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  // Playwright's default testMatch also picks up *.test.ts, which is
  // vitest's tier-1 naming convention (see vitest.config.ts) — restrict to
  // *.spec.ts so `playwright test` doesn't try to run the vitest suite
  // (and fail: vitest's `expect` only works inside a vitest worker).
  testMatch: /.*\.spec\.ts$/,
  outputDir: "./.artifacts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never" }]],

  webServer: {
    command: "pnpm exec vite --port 5183 --strictPort",
    url: "http://127.0.0.1:5183/probe.html",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },

  use: {
    baseURL: "http://127.0.0.1:5183",
    trace: "retain-on-failure",
  },

  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        permissions: ["microphone", "camera"],
        launchOptions: {
          args: [
            "--use-fake-device-for-media-stream",
            "--use-fake-ui-for-media-stream",
            "--autoplay-policy=no-user-gesture-required",
          ],
        },
      },
    },
    {
      name: "firefox",
      use: {
        ...devices["Desktop Firefox"],
        // No `permissions` here — Playwright's Firefox backend rejects
        // `context.grantPermissions(["microphone"])` with "Unknown
        // permission: microphone" (verified: it throws at newContext).
        // `media.navigator.permission.disabled` below is what actually
        // suppresses the prompt on this engine.
        launchOptions: {
          firefoxUserPrefs: {
            "media.navigator.streams.fake": true,
            "media.navigator.permission.disabled": true,
            // Phase 2b reported that Firefox here "cannot open a peer
            // connection at all", and capability-gated every peer-connection
            // case off it. That was wrong. The cause was the dev server's
            // bind address: Vite defaults to `localhost`, resolves it to
            // `[::1]` and binds IPv6 only, and Firefox gathers **zero** ICE
            // candidates on an IPv6-loopback origin. `vite.config.ts` now
            // pins `host: "127.0.0.1"` and this engine connects.
            //
            // Measured 2026-09-07, and worth keeping because each of these
            // was believed to be the answer at some point: it is not the
            // scheme (a 2x2 of bind address x http/https puts both `::1`
            // cells at zero candidates and both `127.0.0.1` cells at three),
            // not HTTP/2, not Vite's injected HMR client, not the port, and
            // not any pref — `ice.loopback`,
            // `ice.obfuscate_host_addresses`, `ice.link_local`,
            // `ice.no_host`, `ice.default_address_only` and
            // `network.proxy.allow_hijacking_localhost` were each measured
            // against the failing origin and every combination still
            // gathered zero. The two ICE prefs that used to sit here are
            // gone, because they never did anything.
          },
        },
      },
    },
    {
      name: "webkit",
      use: {
        ...devices["Desktop Safari"],
        permissions: ["microphone", "camera"],
      },
    },
  ],
});
