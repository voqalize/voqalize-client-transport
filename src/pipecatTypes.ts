/**
 * The pipecat surface this package is written against.
 *
 * Two kinds of declaration live here, and the difference matters.
 *
 * **Re-exported from `@pipecat-ai/client-js`** — anything a consumer can hold
 * at runtime. `DeviceError` above all: an app catches it or tests it with
 * `instanceof`, and a locally-declared twin would fail that check against the
 * class pipecat's own code throws. It is a peer dependency precisely so there
 * is exactly one of it in the tree.
 *
 * **Mirrored structurally** — `MediaManagerSurface`. The abstract
 * `MediaManager` class that `SmallWebRTCTransport` accepts is *not exported*
 * by `@pipecat-ai/small-webrtc-transport`; only `WavMediaManager` and
 * `DailyMediaManager` are. There is nothing to extend and nothing to name, so
 * the manager implements the shape and `createVoqalizeTransport()` performs
 * the one cast the missing export forces (see `src/transport.ts`).
 *
 * Verified against `@pipecat-ai/client-js@1.13.0` and
 * `@pipecat-ai/small-webrtc-transport@1.10.6` on 2026-09-07.
 */

import type {
  DeviceArray,
  DeviceErrorDetails,
  DeviceErrorType,
  Participant,
  RTVIEventCallbacks,
  Tracks,
} from "@pipecat-ai/client-js";
import { DeviceError } from "@pipecat-ai/client-js";

export { DeviceError };
export type { DeviceArray, DeviceErrorDetails, DeviceErrorType, Participant, Tracks };

/**
 * The media subset of pipecat's `RTVIEventCallbacks` — the callbacks a media
 * manager is the one to fire. Derived from the real type rather than restated,
 * so a rename upstream is a compile error here rather than a silent no-op.
 */
export type MediaEventCallbacks = Partial<
  Pick<
    RTVIEventCallbacks,
    | "onAvailableCamsUpdated"
    | "onAvailableMicsUpdated"
    | "onAvailableSpeakersUpdated"
    | "onCamUpdated"
    | "onMicUpdated"
    | "onSpeakerUpdated"
    | "onDeviceError"
    | "onTrackStarted"
    | "onTrackStopped"
    | "onScreenTrackStarted"
    | "onScreenTrackStopped"
    | "onScreenShareError"
    | "onLocalAudioLevel"
  >
>;

/**
 * The fields of `PipecatClientOptions` a media manager reads.
 *
 * Narrowed on purpose: the manager is handed the whole options object by the
 * transport, and stating what it actually looks at is the honest signature.
 * TypeScript's bivariant method parameters make the wider real type assignable.
 */
export interface MediaClientOptions {
  callbacks?: MediaEventCallbacks;
  enableMic?: boolean;
  enableCam?: boolean;
  enableScreenShare?: boolean;
}

/**
 * The abstract `MediaManager`'s public surface, minus the `protected` fields
 * that make the real class impossible to satisfy structurally.
 *
 * NOTE the return types. The stock 1.10.6 `.d.ts` declares `updateMic`,
 * `enableMic` and friends as plain `void`, not `void | Promise<void>` — which
 * means **the transport never awaits a device switch**. Returning a promise
 * from a `void`-declared method is still assignable, so the async
 * implementation satisfies the declaration; what it does not get is
 * back-pressure. That is why every mutation in `VoqalizeMediaManager` goes
 * through one internal queue instead of relying on the caller to serialize.
 */
export interface MediaManagerSurface {
  setUserAudioCallback(userAudioCallback: (data: ArrayBuffer) => void): void;
  setClientOptions(options: MediaClientOptions, override?: boolean): void;

  initialize(): Promise<void>;
  connect(): Promise<void>;
  disconnect(): Promise<void>;

  userStartedSpeaking(): Promise<unknown>;
  bufferBotAudio(data: ArrayBuffer | Int16Array, id?: string): Int16Array | undefined;

  getAllMics(): Promise<MediaDeviceInfo[]>;
  getAllCams(): Promise<MediaDeviceInfo[]>;
  getAllSpeakers(): Promise<MediaDeviceInfo[]>;

  updateMic(micId: string): void;
  updateCam(camId: string): void;
  updateSpeaker(speakerId: string): void;

  get selectedMic(): MediaDeviceInfo | Record<string, never>;
  get selectedCam(): MediaDeviceInfo | Record<string, never>;
  get selectedSpeaker(): MediaDeviceInfo | Record<string, never>;

  enableMic(enable: boolean): void;
  enableCam(enable: boolean): void;
  enableScreenShare(enable: boolean): void;

  get isCamEnabled(): boolean;
  get isMicEnabled(): boolean;
  get isSharingScreen(): boolean;

  get supportsScreenShare(): boolean;

  tracks(): Tracks;
}
