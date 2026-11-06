/**
 * Fails the build when `dist/` breaks a promise the package makes:
 *
 * - **No daily-js.** pipecat's transport is bundled with daily stubbed out
 *   (`src/vendor/noDaily.ts`); daily's own code carries `DailyIframe` and the
 *   `c.daily.co` origin it loads its call machine from.
 * - **Declared imports only.** The peer `@pipecat-ai/client-js`, and `events`
 *   and `lodash` (dependencies). Anything else is a package the consumer was
 *   told it need not install.
 * - **Every bundled package has its licence in THIRD_PARTY_NOTICES.md**, read
 *   off the metafiles tsup writes, which are then deleted.
 */
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { transformSync } from "esbuild";

const fail = (msg) => {
  console.error(`check-dist: ${msg}`);
  process.exit(1);
};

const DAILY = /DailyIframe|c\.daily\.co/;
// The peer, and what pipecat's transport imports that is not daily: kept
// external so an app shares one copy with client-js (`package.json`).
const ALLOWED = (spec) =>
  spec === "@pipecat-ai/client-js" ||
  spec === "events" ||
  spec === "lodash" ||
  spec.startsWith("lodash/");
// A bare `require(` only: lodash probes for Node with `freeModule.require("util")`
// inside a try, which is not an import.
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|(?<![.\w$])require\s*\(\s*)["']([^"']+)["']/g;

for (const file of ["dist/index.js", "dist/index.cjs", "dist/index.d.ts", "dist/index.d.cts"]) {
  const text = readFileSync(file, "utf8");
  if (DAILY.test(text)) fail(`${file} carries daily-js`);
  // Doc comments name modules too (`@returns {import('./x.js').T}`); match
  // against the code alone. esbuild strips JS comments without touching code;
  // the declarations only need their block comments gone.
  const code =
    file.endsWith(".ts") || file.endsWith(".cts")
      ? text.replace(/\/\*[\s\S]*?\*\//g, "")
      : transformSync(text, { loader: "js", minifyWhitespace: true, legalComments: "none" }).code;
  for (const [, spec] of code.matchAll(SPECIFIER)) {
    if (!ALLOWED(spec)) fail(`${file} imports "${spec}", which is not a declared dependency`);
  }
}

const notices = readFileSync("THIRD_PARTY_NOTICES.md", "utf8");
const headings = new Set([...notices.matchAll(/^## (\S+)$/gm)].map((m) => m[1]));
const bundled = new Set();
for (const meta of readdirSync("dist").filter((f) => /^metafile-.*\.json$/.test(f))) {
  for (const input of Object.keys(JSON.parse(readFileSync(`dist/${meta}`, "utf8")).inputs)) {
    // …/node_modules/<name or @scope/name>/… — the last node_modules wins.
    const m = input.match(/.*node_modules\/((?:@[^/]+\/)?[^/]+)\//);
    if (m) bundled.add(m[1]);
  }
  rmSync(`dist/${meta}`); // not for publishing
}
if (bundled.size === 0) fail("found no bundled packages: did tsup stop writing its metafile?");
for (const name of bundled) {
  if (!headings.has(name)) fail(`${name} is bundled but has no section in THIRD_PARTY_NOTICES.md`);
}
for (const name of headings) {
  if (!bundled.has(name)) fail(`THIRD_PARTY_NOTICES.md lists ${name}, which is no longer bundled`);
}
console.log(`check-dist: ok (bundled: ${[...bundled].sort().join(", ")})`);
