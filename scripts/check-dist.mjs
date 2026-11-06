/**
 * Fails the build when `dist/` breaks a promise the package makes:
 *
 * - **No daily-js.** pipecat's transport is bundled with daily stubbed out
 *   (`src/vendor/noDaily.ts`); daily's own code carries `DailyIframe` and the
 *   `c.daily.co` origin it loads its call machine from.
 * - **One import.** `@pipecat-ai/client-js`, the peer, is the only module the
 *   JS or the types may name. Anything else is a package the consumer was told
 *   it need not install.
 * - **Every bundled package has its licence in THIRD_PARTY_NOTICES.md**, read
 *   off the `// node_modules/...` path comments esbuild writes above each
 *   module it inlines.
 */
import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";

const fail = (msg) => {
  console.error(`check-dist: ${msg}`);
  process.exit(1);
};

const DAILY = /DailyIframe|c\.daily\.co/;
const PEER = "@pipecat-ai/client-js";
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
    if (spec !== PEER) fail(`${file} imports "${spec}"; only ${PEER} may be imported`);
  }
}

const notices = readFileSync("THIRD_PARTY_NOTICES.md", "utf8");
const headings = new Set([...notices.matchAll(/^## (\S+)$/gm)].map((m) => m[1]));
const bundled = new Set();
for (const [, dir] of readFileSync("dist/index.js", "utf8").matchAll(
  /^\/\/ node_modules\/\.pnpm\/([^/]+)\/node_modules\//gm,
)) {
  // `@scope+name@version_peer…` or `name@version`
  const at = dir.indexOf("@", dir.startsWith("@") ? 1 : 0);
  bundled.add(dir.slice(0, at).replace("+", "/"));
}
if (bundled.size === 0) fail("found no bundled packages: has the esbuild path comment changed?");
for (const name of bundled) {
  if (!headings.has(name)) fail(`${name} is bundled but has no section in THIRD_PARTY_NOTICES.md`);
}
for (const name of headings) {
  if (!bundled.has(name)) fail(`THIRD_PARTY_NOTICES.md lists ${name}, which is no longer bundled`);
}
console.log(`check-dist: ok (bundled: ${[...bundled].sort().join(", ")})`);
