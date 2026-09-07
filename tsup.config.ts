import { defineConfig } from "tsup";

// The published artefact is `src/` only. `lab/`, `tests/` and `e2e/` are the
// proof, not the product — they ship in the repository and never in the
// tarball (see `files` in package.json).
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  // A browser package. Nothing in `src/` touches a Node builtin, and the
  // published bundle is not meant to run outside a page.
  platform: "browser",
  target: "es2022",
  outExtension: ({ format }) => ({ js: format === "cjs" ? ".cjs" : ".js" }),
  // Peer dependencies. Bundling either would put a second copy of pipecat in
  // the consumer's tree, and `instanceof DeviceError` would stop working —
  // the exact bug `src/pipecatTypes.ts` exists to avoid.
  external: ["@pipecat-ai/client-js", "@pipecat-ai/small-webrtc-transport"],
});
