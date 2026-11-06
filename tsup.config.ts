import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";

// The published artefact is `src/` only. `lab/`, `tests/` and `e2e/` are the
// proof, not the product — they ship in the repository and never in the
// tarball (see `files` in package.json).
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  // pipecat's transport types are inlined too, so a consumer needs no copy of
  // the package to type-check against ours.
  dts: { resolve: ["@pipecat-ai/small-webrtc-transport"] },
  sourcemap: true,
  clean: true,
  treeshake: true,
  // A browser package. Nothing in `src/` touches a Node builtin, and the
  // published bundle is not meant to run outside a page.
  platform: "browser",
  target: "es2022",
  outExtension: ({ format }) => ({ js: format === "cjs" ? ".cjs" : ".js" }),
  // `@pipecat-ai/client-js` is a peer. Bundling it would put a second copy of
  // pipecat in the consumer's tree, and `instanceof DeviceError` would stop
  // working — the exact bug `src/pipecatTypes.ts` exists to avoid.
  external: ["@pipecat-ai/client-js"],
  // pipecat's `SmallWebRTCTransport` is bundled, at the exact version pinned in
  // devDependencies, with daily-js replaced by `src/vendor/noDaily.ts`: its
  // static import of daily is for a default media manager this package never
  // builds. What it needs at runtime comes with it (lodash, and `events` for
  // its EventEmitter), so the package keeps no runtime dependencies. Licences:
  // THIRD_PARTY_NOTICES.md; `scripts/check-dist.mjs` fails the build when a
  // bundled package is missing from it, or when daily-js is back.
  noExternal: ["@pipecat-ai/small-webrtc-transport", "lodash", "events"],
  esbuildOptions(options) {
    options.alias = {
      ...options.alias,
      "@daily-co/daily-js": fileURLToPath(new URL("./src/vendor/noDaily.ts", import.meta.url)),
    };
  },
});
