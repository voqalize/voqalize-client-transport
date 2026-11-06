// After tsup: pipecat's `SmallWebRTCTransport` declarations, inlined into ours,
// import `MediaManager` from `@pipecat-ai/transport-lib`, a package pipecat
// never published. A consumer type-checking without `skipLibCheck` would fail
// on it, and with it would get `any`. `MediaManagerSurface` (src/pipecatTypes.ts)
// is the same public shape, written down, so the import is pointed at it.
import { readFileSync, writeFileSync } from "node:fs";

const IMPORT = "import { MediaManager } from '@pipecat-ai/transport-lib';\n";
for (const file of ["dist/index.d.ts", "dist/index.d.cts"]) {
  let text = readFileSync(file, "utf8");
  if (!text.includes(IMPORT))
    throw new Error(`${file}: pipecat's MediaManager import changed; re-check scripts/fix-dts.mjs`);
  if (!/^interface MediaManagerSurface \{/m.test(text))
    throw new Error(`${file}: no MediaManagerSurface to point MediaManager at`);
  text = text.replace(IMPORT, "");
  text += "\ntype MediaManager = MediaManagerSurface;\n";
  if (
    /from ['"](@pipecat-ai\/transport-lib|@daily-co\/daily-js|@pipecat-ai\/small-webrtc-transport)['"]/.test(
      text,
    )
  ) {
    throw new Error(`${file}: still names a package a consumer does not install`);
  }
  writeFileSync(file, text);
}
