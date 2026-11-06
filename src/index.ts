/**
 * `@voqalize/client-transport` — local media for pipecat's
 * `SmallWebRTCTransport`, over `navigator.mediaDevices` alone.
 *
 * The public surface is deliberately small:
 *
 *   `createVoqalizeClient()` — the client for a page: pipecat's
 *   `PipecatClient` over our transport, typed as `VoqalizeSession`, so the
 *   app imports nothing from pipecat. The types it is described in
 *   (`src/clientTypes.ts`) are ours and import nothing.
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
 *   `SmallWebRTCTransport` and its option types — pipecat's transport, which
 *   this package carries itself, built without daily-js (`src/vendor/`), so
 *   an app installs this package and not `@pipecat-ai/small-webrtc-transport`.
 *   Import it from here to name the type or test `instanceof`;
 *   `createVoqalizeTransport()` is still how you build one.
 *
 * Everything else in `src/` is internal and may change in any release.
 */

export { createVoqalizeClient, isDeviceError } from "./client";
export type { VoqalizeClientOptions } from "./client";
export type {
  ActionData,
  AgentOutput,
  ConnectionState,
  DeviceProblem,
  ErrorMessage,
  ParticipantInfo,
  SessionParams,
  UserTranscript,
  VoqalizeClient,
  VoqalizeEvents,
  VoqalizeSession,
} from "./clientTypes";
export { createVoqalizeTransport, attachTrackChangedHandler } from "./transport";
export type { VoqalizeTransportOptions } from "./transport";
export { VoqalizeMediaManager } from "./mediaManager";
export { SmallWebRTCTransport } from "@pipecat-ai/small-webrtc-transport";
export type {
  IceConfig,
  SmallWebRTCTransportConnectionOptions,
  SmallWebRTCTransportConstructorOptions,
} from "@pipecat-ai/small-webrtc-transport";
