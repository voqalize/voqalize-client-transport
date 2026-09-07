/**
 * The structural media surface `VoqalizeMediaManager` is written against.
 *
 * The manager never names `navigator`, `MediaStream` or `MediaStreamTrack`
 * concretely. That is what lets one implementation — the same file, not a
 * parallel one — run over the tier-1 fake platform in node and over real
 * `navigator.mediaDevices` in chromium/firefox/webkit (SPEC.md § Test
 * taxonomy: "the same test bodies as tier 1").
 *
 * Every interface here is a strict subset of the real DOM type, so the real
 * types are assignable to them with no cast. `tests/platformAssignability.test.ts`
 * is the compile-time proof of that claim.
 */

/** The two kinds `getUserMedia` can be asked for. Screen capture is not one of them. */
export type InputKind = "audio" | "video";

/**
 * What a harness can drive the lifecycle of. `"screen"` is a third *scripting*
 * target rather than a third `InputKind`, because a screen track comes from
 * `getDisplayMedia` and has no device list, no `deviceId` to switch to and no
 * re-acquire path — the distinction the manager's recovery logic turns on.
 */
export type ScriptKind = InputKind | "screen";

/** The subset of `MediaStreamTrack` the manager touches. */
export interface TrackLike {
  readonly kind: string;
  readonly id: string;
  readonly label: string;
  enabled: boolean;
  contentHint: string;
  readonly readyState: MediaStreamTrackState;
  readonly muted: boolean;
  stop(): void;
  clone(): TrackLike;
  getSettings(): MediaTrackSettings;
  addEventListener(type: string, listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: string, listener: () => void): void;
}

/** The subset of `MediaStream` the manager touches. */
export interface StreamLike {
  getTracks(): TrackLike[];
  getAudioTracks(): TrackLike[];
  getVideoTracks(): TrackLike[];
}

/** The subset of `MediaDevices` the manager touches. */
export interface MediaDevicesLike {
  enumerateDevices(): Promise<MediaDeviceInfo[]>;
  getUserMedia(constraints: MediaStreamConstraints): Promise<StreamLike>;
  getDisplayMedia?(constraints?: DisplayMediaStreamOptions): Promise<StreamLike>;
  addEventListener?(type: "devicechange", listener: () => void): void;
  removeEventListener?(type: "devicechange", listener: () => void): void;
}

/**
 * The subset of `document` the muted-track recovery gate reads. Injected
 * rather than reached for so tier 1 (node, no document) and tier 2 (a real
 * document whose `visibilityState` Playwright cannot change) run the same
 * body — see SPEC.md design decisions, "mute recovery gated on visibility".
 */
export interface VisibilitySource {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

/**
 * The subset of `HTMLMediaElement` speaker routing touches. `setSinkId` is
 * optional because it is genuinely absent on some engines; the manager must
 * degrade rather than throw. What is actually true per engine is measured in
 * tier 2, not assumed here.
 */
export interface OutputElementLike {
  readonly sinkId?: string;
  setSinkId?(sinkId: string): Promise<void>;
  /**
   * Playback, which the manager *attempts* and never assumes. A real
   * `HTMLMediaElement` has both of these; a bare routing stub has neither, and
   * an element without `play` is simply left alone.
   *
   * This exists because autoplay is the one failure where every other number
   * looks healthy: frames encode, packets arrive, `getStats()` is green, and
   * the person on the call hears nothing. The browser answers by rejecting
   * `play()` with `NotAllowedError`, and something has to catch that and say
   * so.
   */
  play?(): Promise<void>;
  readonly paused?: boolean;
}

export function isLive(track: TrackLike | null | undefined): track is TrackLike {
  return !!track && track.readyState === "live";
}

/**
 * Resolve a requested device id against a list.
 *
 * Tolerates empty labels and empty device ids, both of which happen before a
 * permission grant on every engine (README's "labels caveat"), and neither of
 * which means the device is gone.
 */
export function resolveDevice(
  devices: readonly MediaDeviceInfo[],
  requestedId: string | undefined,
): MediaDeviceInfo | undefined {
  if (devices.length === 0) return undefined;
  if (!requestedId || requestedId === "default") {
    return devices.find((d) => d.deviceId === "default") ?? devices[0];
  }
  return devices.find((d) => d.deviceId === requestedId);
}

export function syntheticDevice(kind: MediaDeviceKind, deviceId: string): MediaDeviceInfo {
  const info = { deviceId, groupId: "", kind, label: "" };
  return { ...info, toJSON: () => info } as MediaDeviceInfo;
}
