/**
 * `@voqalize/client-transport` — local media for pipecat, without Daily.
 *
 * Two entry points, and most applications need only the first:
 *
 *   `createVoqalizeTransport()` — a stock `SmallWebRTCTransport` with our
 *   media manager in place of `DailyMediaManager`, fully wired. Drop it where
 *   you build your transport today and nothing else in your app changes.
 *
 *   `VoqalizeMediaManager` — the manager on its own, for a codebase that
 *   already constructs its transport somewhere you cannot reach. Pair it with
 *   `attachTrackChangedHandler()`, or mid-call device switches will not reach
 *   the peer connection (see `src/transport.ts` for why).
 */

export { createVoqalizeTransport, attachTrackChangedHandler } from "./transport";
export type { VoqalizeTransport, VoqalizeTransportOptions } from "./transport";

export {
  VoqalizeMediaManager,
  normalizeDeviceError,
  ENCODING_POLICY,
  CAMERA_CONSTRAINTS,
  SCREEN_CONSTRAINTS,
} from "./mediaManager";
export type {
  VoqalizeMediaManagerOptions,
  LocalTrackChangedEvent,
  LocalTrackChangedHandler,
  LocalTrackType,
  SlotKey,
  EncodingPolicy,
} from "./mediaManager";

export type {
  MediaDevicesLike,
  StreamLike,
  TrackLike,
  InputKind,
  VisibilitySource,
  OutputElementLike,
} from "./mediaPlatform";

export type { MediaManagerSurface, MediaClientOptions, MediaEventCallbacks } from "./pipecatTypes";
