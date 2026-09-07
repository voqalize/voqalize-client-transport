/**
 * Assertions that belong to neither runner.
 *
 * A contract body runs under vitest in tier 1 and under Playwright in tier 2.
 * `expect` from either one only works inside its own worker, so a shared body
 * cannot use either. These are the whole vocabulary the bodies get, and they
 * throw plain `Error`s that both runners report identically.
 */

export class AssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssertionError";
  }
}

function fail(message: string): never {
  throw new AssertionError(message);
}

export function ok(value: unknown, message = "expected a truthy value"): asserts value {
  if (!value) fail(`${message} (got ${describe(value)})`);
}

export function notOk(value: unknown, message = "expected a falsy value"): void {
  if (value) fail(`${message} (got ${describe(value)})`);
}

export function equal<T>(actual: T, expected: T, message = "values differ"): void {
  if (actual !== expected) {
    fail(`${message}: expected ${describe(expected)}, got ${describe(actual)}`);
  }
}

export function notEqual<T>(actual: T, unexpected: T, message = "values should differ"): void {
  if (actual === unexpected) fail(`${message}: both are ${describe(actual)}`);
}

export function deepEqual(actual: unknown, expected: unknown, message = "values differ"): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) fail(`${message}: expected ${b}, got ${a}`);
}

export function includes<T>(
  haystack: readonly T[],
  needle: T,
  message = "value not present",
): void {
  if (!haystack.includes(needle)) {
    fail(`${message}: ${describe(needle)} not in ${describe(haystack)}`);
  }
}

export function excludes<T>(haystack: readonly T[], needle: T, message = "value present"): void {
  if (haystack.includes(needle)) {
    fail(`${message}: ${describe(needle)} found in ${describe(haystack)}`);
  }
}

export function nonEmpty(value: string, message = "expected a non-empty string"): void {
  if (typeof value !== "string" || value.length === 0) fail(`${message} (got ${describe(value)})`);
}

/** The error a rejected `LabApi` call carries, in both tiers. */
export interface CaughtError {
  name: string;
  message: string;
  type: string | undefined;
}

/** Runs `fn`, requires it to reject, and hands back the error as plain data. */
export async function rejects(
  fn: () => Promise<unknown>,
  message = "expected the call to reject",
): Promise<CaughtError> {
  try {
    await fn();
  } catch (raw) {
    const error = raw as { name?: string; message?: string; deviceErrorType?: string };
    return {
      name: error.name ?? "Error",
      message: error.message ?? "",
      type: error.deviceErrorType,
    };
  }
  return fail(message);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls until the predicate holds. Every tier-2 wait is a real wait — there is
 * no fake clock in a browser we drive over CDP, so tier 1 does not get one
 * either. Timers in the contract cases are set small enough (tens of ms) that
 * this stays fast, and long enough that a loaded CI box does not race.
 */
export async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  options: { timeout?: number; interval?: number; message?: string } = {},
): Promise<void> {
  const timeout = options.timeout ?? 3000;
  const interval = options.interval ?? 15;
  const deadline = Date.now() + timeout;
  let last: unknown;
  for (;;) {
    try {
      if (await predicate()) return;
      last = undefined;
    } catch (error) {
      last = error;
    }
    if (Date.now() >= deadline) {
      const detail = last instanceof Error ? ` (last error: ${last.message})` : "";
      fail(`${options.message ?? "condition never became true"} after ${timeout}ms${detail}`);
    }
    await sleep(interval);
  }
}

/**
 * Waits out a window that is supposed to produce nothing. Used by the negative
 * recovery cases — "still not re-acquired while the tab is hidden" is only
 * meaningful if we waited longer than the recovery timer.
 */
export async function stayFalse(
  predicate: () => Promise<boolean> | boolean,
  ms: number,
  message = "condition became true when it should not have",
): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) fail(message);
    await sleep(15);
  }
}

function describe(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
