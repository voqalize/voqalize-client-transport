import { defineConfig } from "vite";

import { udpRelayPlugin } from "./lab/relay/udpRelay";

// Serves two pages, from `src/` as the root:
//
//   /probe.html  the tier-2 harness surface. No UI at all, on purpose — a
//                test drives `window.__lab` through `page.evaluate`.
//   /demo.html   the tier-3 manual lab page. This one *is* a UI: a person
//                opens it, presses Start, and watches real frames encode
//                through a loopback peer connection built in the page.
//
// `pnpm dev` and the Playwright `webServer` block run the same command, so
// the page the owner opens is the page the suite tests.
export default defineConfig({
  root: "lab",
  // The controllable UDP relay scenarios 6 and 7 run through, mounted at
  // `/__relay`. It lives in the dev server because a relay has to be a real
  // socket on the network the peers are told to use — see relay/udpRelay.ts.
  plugins: [udpRelayPlugin()],
  server: {
    // **127.0.0.1, never the default `localhost`.** Vite resolves `localhost`
    // to `[::1]` and binds IPv6 only, and Firefox gathers **zero** ICE
    // candidates on an IPv6-loopback origin — `iceGatheringState` never
    // leaves `new` and the peer connection fails in ~600 ms with "ICE failed,
    // add a STUN server". Bound to 127.0.0.1 the same page gathers 3 and
    // connects. Measured 2026-09-07 as a 2x2 of bind address x scheme: both
    // `::1` cells fail and both `127.0.0.1` cells pass, so the scheme is not
    // a factor and TLS is not a fix. Chromium and WebKit connect either way,
    // which is what made this look like a Firefox incapability for a while.
    host: "127.0.0.1",
    port: 5183,
    strictPort: true,
  },
  preview: {
    host: "127.0.0.1",
    port: 5183,
    strictPort: true,
  },
});
