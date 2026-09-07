/**
 * Can this engine, on this machine, resolve `getDisplayMedia` headlessly with
 * no user gesture?
 *
 * It has to be measured, and it cannot be measured from inside the page under
 * test. Two facts force that shape, both found the expensive way:
 *
 * **A headless Linux runner has no display to capture.** On macOS all three
 * engines resolve, so the old gate — `typeof navigator.mediaDevices
 * .getDisplayMedia === "function"` — read `true` for the right reason by
 * accident. On GitHub's ubuntu runner Firefox rejects with `NotFoundError` and
 * WebKit with `NotAllowedError`, and eleven screen-share cases turned into
 * failures rather than the named skips they should have been. A capability
 * gate is a claim, and an unverified claim hides bugs for as long as it stands.
 *
 * **WebKit grants exactly one gesture-free `getDisplayMedia` per page.** The
 * first call resolves; the second throws `InvalidStateError: getDisplayMedia
 * must be called from a user gesture handler`. So a probe that runs inside the
 * page under test *spends the very call the case needs*, and every WebKit
 * screen-share case skips itself. The measurement therefore happens once per
 * worker, in a throwaway page that is closed immediately, and the answer is
 * handed to the cases.
 */
import { test, type Browser, type BrowserContextOptions } from "@playwright/test";

const answers = new Map<string, boolean>();
// One measurement per worker even when several tests reach this at once —
// without it, `fullyParallel` opens one throwaway context per test.
const inFlight = new Map<string, Promise<boolean>>();

export async function screenShareSupport(browser: Browser, baseURL: string): Promise<boolean> {
  const key = browser.browserType().name();
  const cached = answers.get(key);
  if (cached !== undefined) return cached;
  const pending = inFlight.get(key);
  if (pending) return pending;

  const measure = (async () => {
    // Its own context, so the page this burns is never one a case will use.
    //
    // A hand-made context does NOT inherit the project's `use` block, and on
    // WebKit the mock capture devices only exist once the context has been
    // granted microphone and camera. Carrying `permissions` across is what
    // keeps this measuring the same engine the cases run against. Firefox
    // declares none — its backend rejects `"microphone"` outright — so the
    // field is copied rather than assumed.
    const projectUse = test.info().project.use as BrowserContextOptions;
    const context = await browser.newContext(
      projectUse.permissions ? { permissions: projectUse.permissions } : {},
    );
    const page = await context.newPage();
    try {
      await page.goto(new URL("/probe.html", baseURL).toString());
      const supported = await page.evaluate(async () => {
        if (typeof navigator.mediaDevices?.getDisplayMedia !== "function") return false;
        try {
          const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
          for (const track of stream.getTracks()) track.stop();
          return true;
        } catch {
          return false;
        }
      });
      answers.set(key, supported);
      return supported;
    } finally {
      await context.close();
    }
  })();
  inFlight.set(key, measure);
  return measure;
}
