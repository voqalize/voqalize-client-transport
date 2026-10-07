/**
 * `@voqalize/client-transport` — local media for pipecat's
 * `SmallWebRTCTransport`, over `navigator.mediaDevices` alone.
 *
 * The public surface is deliberately small:
 *
 *   `createVoqalizeTransport()` — a stock `SmallWebRTCTransport` with our
 *   media manager in place of the default one, fully wired. Drop it where
 *   you build your transport today and nothing else in your app changes.
 *
 *   `VoqalizeMediaManager` — pipecat's `MediaManager`, plus
 *   `bindOutputElement()` for the element the agent plays on. Construct one
 *   yourself when the app needs it before the transport exists, and hand it
 *   to `createVoqalizeTransport({ mediaManager })`.
 *
 *   `attachTrackChangedHandler()` — for a codebase that builds its transport
 *   somewhere you cannot reach (pipecat's `PipecatAppBase`, say). Without it,
 *   mid-call device switches do not reach the peer connection (see
 *   `src/transport.ts` for why).
 *
 * Everything else in `src/` is internal and may change in any release.
 */

export { createVoqalizeTransport, attachTrackChangedHandler } from "./transport";
export type { VoqalizeTransportOptions } from "./transport";
export { VoqalizeMediaManager } from "./mediaManager";
