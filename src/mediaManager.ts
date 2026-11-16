/**
 * VoqalizeMediaManager — microphone, camera and screen share (SPEC.md phases 1–2).
 *
 * A `MediaManager` for pipecat's `SmallWebRTCTransport` that owns browser
 * capture and nothing else: no room engine and no remotely-loaded code. The
 * abstract base is not exported by `@pipecat-ai/small-webrtc-transport`
 * (SPEC.md § Ground truth), so this is a standalone class that satisfies the
 * base's *public* surface structurally — `MediaManagerSurface` in
 * `pipecatTypes.ts` — and a phase-4 factory casts once.
 *
 * The design decisions this file implements, all from SPEC.md:
 *  1. Publish `track.clone()`; the manager owns the capture track. `enabled`
 *     is mirrored onto the clone. `connect()` mints a fresh clone per peer
 *     connection.
 *  2. Every mutation is serialized through one promise queue — with
 *     `getDisplayMedia`'s *permission request* the sole exception, because
 *     queueing it would push it outside the caller's user-activation window
 *     and the browser would refuse the prompt.
 *  3. One `getUserMedia` call when several kinds are wanted.
 *  5. `devicechange` is debounced.
 *  6. `contentHint`: `"speech"` mic, `"motion"` camera, `"detail"` screen.
 *  7. No Web Audio in the capture path. The capture track and the clone the
 *     peer connection is given never touch an `AudioContext`. The local level
 *     pipecat's `onLocalAudioLevel` expects — Daily's manager emits it, and
 *     avatars read it to listen — is measured on a separate branch: the meter
 *     clones the capture track and analyses only that clone, never connected to
 *     a destination (`localAudioLevel.ts`).
 *  8. Screen share is tuned for legibility, not motion (see `ENCODING_POLICY`).
 *  9. Screen *video* only — `getDisplayMedia({ video, audio: false })`.
 * 10. Camera and screen share can be live at the same time.
 *
 * Three capture slots, and the difference between them is the whole of the
 * phase-2 design: `audio` and `video` come from `getUserMedia`, name a device,
 * and are *recoverable* — an `ended` we did not cause means the device went
 * away and we ask for it again. `screenVideo` comes from `getDisplayMedia`,
 * names nothing, and is not recoverable: an `ended` we did not cause is the
 * user clicking the browser's own "Stop sharing", and re-prompting them for it
 * would be the worst thing this class could do.
 */

import {
  DeviceError,
  type DeviceArray,
  type DeviceErrorDetails,
  type DeviceErrorType,
  type MediaClientOptions,
  type MediaEventCallbacks,
  type MediaManagerSurface,
  type Participant,
  type Tracks,
} from "./pipecatTypes";
import {
  isLive,
  resolveDevice,
  syntheticDevice,
  type InputKind,
  type MediaDevicesLike,
  type OutputElementLike,
  type StreamLike,
  type GestureSource,
  type TrackLike,
  type VisibilitySource,
} from "./mediaPlatform";
import {
  browserAudioContextFactory,
  LocalAudioLevelMeter,
  type AudioContextFactory,
} from "./localAudioLevel";
import {
  browserFramePolicy,
  CallHealthStore,
  classifyCaptureError,
  describeDevice,
  fixesFor,
  INITIAL_CONNECTION,
  isInAppBrowser,
  rawError,
  traitsOf,
  type CallHealth,
  type CallHealthListener,
  type FramePolicy,
  type CaptureHealth,
  type Cause,
  type ConnectionHealth,
  type Device,
  type PermissionReading,
  type Problem,
  type Recovery,
  SYSTEM_DENIAL,
  type ScreenHealth,
  type ScreenPickerHints,
  type Signal,
  type SpeakerHealth,
} from "./callHealth";
import {
  PlayoutGuard,
  type PlayoutGuardOptions,
  type PlayoutRecoveryReason,
  type PlayoutStatsSource,
} from "./playoutGuard";

export type LocalTrackType = "audio" | "video" | "screenVideo" | "screenAudio";

/** The three slots this manager actually owns. `screenAudio` is deliberately not one (decision 9). */
export type SlotKey = "audio" | "video" | "screenVideo";

/**
 * The per-kind sender settings phase 2b applies to `RTCRtpSender.setParameters`.
 *
 * They live here, as data, because the *policy* is a media-capture concern and
 * the *application* needs a peer connection this phase does not have (SPEC.md
 * phase 2b). Exposing them lets 2b assert it applied exactly what the manager
 * intended rather than re-deriving the numbers and drifting from them.
 */
export interface EncodingPolicy {
  contentHint: string;
  degradationPreference: RTCDegradationPreference;
  maxFramerate: number;
  maxBitrate: number;
}

/**
 * Decision 8, in numbers.
 *
 * **Screen — 1920×1080 at 5 fps, 1.5 Mbps, `maintain-resolution`.** The content
 * is an application UI: mostly static, mostly text, and the failure that
 * matters is a caller who cannot read a field label. 1.5 Mbps over 5 fps is
 * 300 kbit per frame; across 1920×1080 that is ~0.145 bits per pixel, roughly
 * double the ~0.07 bpp where VP8/H.264 begins to smear small type, and the
 * static-frame case spends far less than the budget because only changed
 * macroblocks are coded. 5 fps is chosen against the actual motion in the
 * content — a cursor, a scroll, a page transition — not against video. Paired
 * with `maintain-resolution`, a scroll that blows the budget drops frames
 * instead of dropping to 960×540, which is the trade SPEC.md decision 8 makes
 * explicitly: "a blurry screen is a broken feature here, a slow one is not."
 *
 * **Camera — 30 fps, 600 kbps, `maintain-framerate`.** The exact opposite bias.
 * A talking head is motion; a smaller, smooth face beats a sharp, stuttering
 * one, and 640×360-class video at 600 kbps is the well-trodden operating point.
 *
 * **Mic — 32 kbps mono Opus**, matching what the voice runtime negotiates.
 * `maxFramerate` is meaningless for audio and is recorded as 0 rather than
 * omitted, so every entry has the same shape for 2b to iterate.
 *
 * Sum of the two video lanes: 2.1 Mbps. That is the uplink budget being split
 * deliberately (decision 10) rather than left to two encoders competing.
 */
export const ENCODING_POLICY: Readonly<Record<SlotKey, EncodingPolicy>> = {
  audio: {
    contentHint: "speech",
    degradationPreference: "maintain-framerate",
    maxFramerate: 0,
    maxBitrate: 32_000,
  },
  video: {
    contentHint: "motion",
    degradationPreference: "maintain-framerate",
    maxFramerate: 30,
    maxBitrate: 600_000,
  },
  screenVideo: {
    contentHint: "detail",
    degradationPreference: "maintain-resolution",
    maxFramerate: 5,
    maxBitrate: 1_500_000,
  },
};

/**
 * What the camera is asked for, on top of the device id.
 *
 * 640×360 at 30 fps is the operating point `ENCODING_POLICY.video`'s 600 kbps
 * is chosen for. Constraining at *capture* rather than only at the sender
 * means the browser never encodes and downscales frames nobody will see, which
 * on a laptop is measurable battery. Every field is an `ideal`: a camera that
 * cannot do 360p should hand us what it has, not fail the call.
 */
export const CAMERA_CONSTRAINTS: MediaTrackConstraints = {
  width: { ideal: 640 },
  height: { ideal: 360 },
  frameRate: { ideal: ENCODING_POLICY.video.maxFramerate },
};

/**
 * What `getDisplayMedia` is asked for. Never an `exact`: a display is whatever
 * size it is, and an over-constrained request is an `OverconstrainedError` on a
 * screen the user cannot resize. The size is a `max`, not an `ideal`: an ideal
 * of 1080p made engines upscale a smaller window to it, encoding pixels that
 * carry nothing, while a max lets a 4K monitor come down to what the sender's
 * ceiling (`ENCODING_POLICY`) will send anyway.
 */
export const SCREEN_CONSTRAINTS: MediaTrackConstraints = {
  width: { max: 1920 },
  height: { max: 1080 },
  frameRate: { ideal: ENCODING_POLICY.screenVideo.maxFramerate },
};

export interface LocalTrackChangedEvent {
  type: LocalTrackType;
  /** The published clone, which is what the peer connection carries. */
  track: TrackLike | null;
  previousTrack: TrackLike | null;
}

export type LocalTrackChangedHandler = (event: LocalTrackChangedEvent) => void | Promise<void>;

/**
 * Construction-time configuration. Internal: the public constructor takes
 * none. The lab and the tests use it to inject a fake platform and test-scale
 * timings; nothing here is a promise to an application.
 *
 * @internal
 */
export interface VoqalizeMediaManagerOptions {
  /** Defaults to `navigator.mediaDevices`. Required in node. */
  mediaDevices?: MediaDevicesLike;
  /** Defaults to `document`. The muted-recovery gate reads this. */
  visibility?: VisibilitySource;
  audioConstraints?: MediaTrackConstraints;
  /** Release the microphone device when the mic is disabled. Default false. */
  releaseMicOnDisable?: boolean;
  /**
   * Release the camera device when the camera is disabled. Default **true**.
   * Unlike the mic, a held-but-disabled camera leaves the hardware indicator
   * lit, and a user who sees the light after turning their camera off is right
   * to distrust us.
   */
  releaseCamOnDisable?: boolean;
  /** Re-acquire a capture track that stays muted this long. Default 5000 ms. */
  mutedRecoveryMs?: number;
  /**
   * How often to check that the published clones are still alive. Default
   * 500 ms; `0` disables the watchdog entirely.
   *
   * A poll, reluctantly, because the platform offers nothing else. See
   * `checkPublishedTracks()` — `MediaStreamTrack.stop()` fires **no** event,
   * so a clone the transport stopped is a track that is dead with no
   * notification anywhere. The tick is three `readyState` reads.
   */
  publishWatchdogMs?: number;
  /** Coalescing window for `devicechange` bursts. Default 250 ms. */
  deviceChangeDebounceMs?: number;
  /** Fall back to the default device when the selected one disappears. Default true. */
  fallbackToDefaultDevice?: boolean;
  /**
   * Where a user gesture is heard, so a refused `play()` is retried from
   * inside one. Defaults to `document`.
   */
  gestures?: GestureSource;
  /** Called when playback on the bound elements becomes refused, and again with `false` once it runs. */
  onPlaybackBlocked?: (blocked: boolean) => void;
  /** Called each time the playout guard re-attaches a bound element's source. */
  onPlaybackRecovered?: (reason: PlayoutRecoveryReason) => void;
  /** The guard's tuning, or `false` to turn it off. */
  playoutGuard?: false | Omit<PlayoutGuardOptions, "stats" | "makeStream" | "play" | "onRecovered">;
  /**
   * Builds the stream a recovered element is re-attached to. Defaults to
   * `new MediaStream(tracks)`; required only where there is no `MediaStream`.
   */
  makeStream?: (tracks: TrackLike[]) => StreamLike;
  /**
   * Builds the `AudioContext` the local level is measured in (decision 7).
   * Defaults to the browser's own; `null`, or an engine without one, emits no
   * `onLocalAudioLevel` at all.
   */
  createAudioContext?: AudioContextFactory | null;
  /** How often `onLocalAudioLevel` fires. Default 100 ms, Daily's interval. */
  localAudioLevelIntervalMs?: number;
  /**
   * Where permission states are read and watched, for `CallHealth`. Defaults
   * to `navigator.permissions`; `null` reads every permission as unknown.
   */
  permissions?: PermissionsLike | null;
  /** The user agent, read only to recognise in-app browsers. Defaults to `navigator.userAgent`. */
  userAgent?: string;
  /** Whether this frame's Permissions Policy allows a feature. Defaults to the document's, where the engine exposes it. */
  framePolicy?: FramePolicy | null;
  /** The signal rules' timings, for tests. The defaults are the product's. */
  healthTimings?: Partial<HealthTimings>;
}

/** The subset of `navigator.permissions` CallHealth reads. */
export interface PermissionsLike {
  query(descriptor: { name: string }): Promise<PermissionStatusLike>;
}

export interface PermissionStatusLike {
  readonly state: string;
  addEventListener?(type: "change", listener: () => void): void;
  removeEventListener?(type: "change", listener: () => void): void;
}

export interface HealthTimings {
  /** Silence this long from a device that just opened means a dead device. */
  silentAtJoinMs: number;
  /** Silence this long mid-call, from a device that was heard, means something changed. */
  degradedAfterMs: number;
  /**
   * Sound must last this long, with no gap over `heardGapMs`, before the mic
   * counts as heard. A single click or pop from a dying device is not a voice,
   * and once heard, a silence is only warned about instead of reopened.
   */
  heardAfterMs: number;
  /** The longest quiet gap inside a run of sound that still counts toward `heardAfterMs`. */
  heardGapMs: number;
  /** Reopens allowed for one run of interruptions before the device is reported failed. */
  interruptedReopens: number;
  /**
   * An interruption this long after the last one starts a new run, so a long
   * call's occasional interruptions never add up to a failure.
   */
  interruptionRunMs: number;
  /** How long a stalled playout shows as recovering. */
  speakerRecoveringMs: number;
}

/**
 * The defaults. Silence here is digital silence — a peak at or under
 * `SILENT_PEAK`, one least-significant bit of 16-bit audio — never a quiet
 * room, which always carries noise well above it. The floor and the windows
 * are provisional, set conservatively until field data (calls whose
 * microphone gave nothing) can tune them; a false "no signal" is worse than a late one.
 */
export const HEALTH_TIMINGS: HealthTimings = {
  silentAtJoinMs: 2500,
  degradedAfterMs: 6000,
  heardAfterMs: 300,
  heardGapMs: 1000,
  interruptedReopens: 3,
  interruptionRunMs: 60_000,
  speakerRecoveringMs: 1500,
};

/** One least-significant bit of 16-bit audio, as a float sample. */
export const SILENT_PEAK = 1 / 32768;

interface Slot {
  /** What the transport and the `replaceTrack` hook call this lane. */
  readonly key: SlotKey;
  /** The `MediaStreamTrack.kind` behind it — `screenVideo` is a video track. */
  readonly kind: InputKind;
  readonly deviceKind: MediaDeviceKind;
  readonly contentHint: string;
  /**
   * Whether an `ended` we did not cause should be answered by re-acquiring.
   * True for the two `getUserMedia` slots (a device came back, or another one
   * will do); false for screen share, where the same event means the user
   * pressed the browser's own Stop sharing button.
   */
  readonly recoverable: boolean;
  capture: TrackLike | null;
  published: TrackLike | null;
  deviceId: string;
  desired: boolean;
  mutedTimer: ReturnType<typeof setTimeout> | null;
  intentionalStops: WeakSet<object>;
  detach: (() => void) | null;
  /** What `CallHealth` says about this slot. */
  health: CaptureHealth;
  /** When the current run of silence began, or null while there is signal. */
  quietSince: number | null;
  /** The local reading the health was last built from. */
  local: Signal["local"];
  /** True once this capture has produced sustained signal; see `heardAfterMs`. */
  heard: boolean;
  /** Where the current run of sound began and when it was last seen, toward `heard`. */
  soundRun: { from: number; last: number } | null;
  /** True after the one reopen a silent device gets. */
  silentReopened: boolean;
  /** Reopens spent on the current run of interruptions. */
  interruptions: number;
  /** When the last interruption was reopened, to tell one run from the next. */
  interruptedAt: number;
  /** True once the first open's loopback rule has run. */
  loopbackChecked: boolean;
  /** The device and cause a recovery started from, to report once it is live. */
  recovery: Recovery | null;
  /** The recovery the current live capture came out of, shown on `live`. */
  recovered: Recovery | null;
  /** When the current capture opened. */
  openedAt: number;
  /** True while a `getUserMedia` for this slot is in flight. */
  acquiring: boolean;
}

const GESTURE_EVENTS = ["pointerdown", "keydown"] as const;

const LOCAL_PARTICIPANT: Participant = { id: "local", name: "", local: true };

export class VoqalizeMediaManager implements MediaManagerSurface {
  private readonly mediaDevices: MediaDevicesLike;
  private readonly visibility: VisibilitySource | undefined;
  private readonly audioConstraints: MediaTrackConstraints;
  private readonly releaseMicOnDisable: boolean;
  private readonly releaseCamOnDisable: boolean;
  private readonly mutedRecoveryMs: number;
  private readonly publishWatchdogMs: number;
  private publishWatchdog: ReturnType<typeof setInterval> | null = null;
  private readonly deviceChangeDebounceMs: number;
  private readonly fallbackToDefaultDevice: boolean;

  private options: MediaClientOptions | null = null;
  private callbacks: MediaEventCallbacks = {};
  private userAudioCallback: ((data: ArrayBuffer) => void) | null = null;
  private localTrackChangedHandler: LocalTrackChangedHandler | null = null;

  private micEnabled = true;
  private camEnabled = false;

  private initialized = false;
  private connected = false;
  private destroyed = false;
  private queueTail: Promise<unknown> = Promise.resolve();

  /** The `getUserMedia` slots — the only ones that name a device or can be re-acquired. */
  private readonly slots: Record<InputKind, Slot>;
  /** The `getDisplayMedia` slot. Kept apart from `slots` so no device-oriented loop can reach it. */
  private readonly screen: Slot;
  /**
   * The in-flight screen-share acquisition, install included.
   *
   * This single field is the fix for the confirmed bug in the prior attempt
   * (SPEC.md § Prior art): there, two concurrent `enableScreenShare(true)`
   * callers shared the `getDisplayMedia` promise but each queued its own
   * install, both passed an `isLive` guard taken before anything was
   * installed, and the second install saw a live track and stopped the stream
   * — the very stream the first had just published. Sharing the *whole*
   * operation, not just the prompt, means the second caller performs no
   * install at all and there is exactly one screen track to stop.
   */
  private screenRequest: Promise<"started" | "cancelled"> | null = null;

  private selectedMicInfo: MediaDeviceInfo | Record<string, never> = {};
  private selectedCamInfo: MediaDeviceInfo | Record<string, never> = {};
  private selectedSpeakerInfo: MediaDeviceInfo | Record<string, never> = {};
  private selectedSpeakerId = "default";
  private readonly outputElements = new Set<OutputElementLike>();
  /** Elements the browser has refused to play. Membership *is* the blocked state. */
  private readonly blockedElements = new Set<OutputElementLike>();
  private playbackBlockedReported = false;
  private readonly gestures: GestureSource | undefined;
  private gesturesArmed = false;
  /**
   * The retry, run synchronously inside the gesture's own event: awaiting
   * anything first would leave the activation window the browser grants it.
   * The level meter's `AudioContext` is held by the same autoplay policy, so it
   * is resumed from the same gesture.
   */
  private readonly onGesture = () => {
    void this.resumePlayback();
    this.levelMeter.resume();
  };
  /** Decision 7: the local level, measured on a clone of the capture track. */
  private readonly levelMeter: LocalAudioLevelMeter;
  private readonly onPlaybackBlockedCallback: ((blocked: boolean) => void) | undefined;
  private readonly onPlaybackRecoveredCallback:
    ((reason: PlayoutRecoveryReason) => void) | undefined;
  private readonly playoutGuardOptions: VoqalizeMediaManagerOptions["playoutGuard"];
  private readonly makeStream: ((tracks: TrackLike[]) => StreamLike) | undefined;
  private readonly guards = new Map<OutputElementLike, PlayoutGuard>();
  private statsSource: PlayoutStatsSource | null = null;

  private readonly healthStore: CallHealthStore;
  private readonly timings: HealthTimings;
  private readonly permissions: PermissionsLike | null;
  private readonly permissionReadings: Record<InputKind, PermissionReading> = {
    audio: "unknown",
    video: "unknown",
  };
  private readonly permissionUnwatch: Array<() => void> = [];
  private readonly userAgent: string | undefined;
  private readonly framePolicy: FramePolicy | null;
  private readonly supported: boolean;
  private serverSignal: Signal["server"] = "unmeasured";
  /** What the voice runtime sees of the camera: `caller-video`, or unmeasured when it has not said. */
  private camServer: Signal["server"] = "unmeasured";
  private speakerRecovered: { from: Device | null; cause: Cause } | null = null;
  /** The one pending re-judge of a silence window; see `armSilenceCheck`. */
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private speakerStalledUntil = 0;
  private speakerTimer: ReturnType<typeof setTimeout> | null = null;

  private deviceChangeTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly onDeviceChange = () => this.scheduleDeviceChange();
  private readonly onVisibilityChange = () => {
    if (this.visibility?.visibilityState !== "visible") return;
    // Device slots only: a muted screen capture is not a device that needs
    // waking, and there is no way to re-acquire it without a fresh prompt.
    for (const slot of Object.values(this.slots)) {
      if (slot.capture?.muted) this.scheduleMutedRecovery(slot, slot.capture, 0);
    }
  };

  constructor();
  /** @internal */
  constructor(options: VoqalizeMediaManagerOptions);
  constructor(options: VoqalizeMediaManagerOptions = {}) {
    const mediaDevices =
      options.mediaDevices ??
      (globalThis as { navigator?: { mediaDevices?: MediaDevicesLike } }).navigator?.mediaDevices;
    // No longer a throw: a page without capture is a page whose mic health
    // says `failed · not-supported`, which a UI can explain. The stand-in
    // rejects every request the way an engine without the API would.
    this.supported = !!mediaDevices;
    this.mediaDevices = mediaDevices ?? unsupportedMediaDevices();
    this.visibility =
      options.visibility ??
      (typeof document !== "undefined" ? (document as VisibilitySource) : undefined);
    this.audioConstraints = { ...(options.audioConstraints ?? {}) };
    this.releaseMicOnDisable = options.releaseMicOnDisable ?? false;
    this.releaseCamOnDisable = options.releaseCamOnDisable ?? true;
    this.mutedRecoveryMs = options.mutedRecoveryMs ?? 5000;
    this.publishWatchdogMs = options.publishWatchdogMs ?? 500;
    this.deviceChangeDebounceMs = options.deviceChangeDebounceMs ?? 250;
    this.fallbackToDefaultDevice = options.fallbackToDefaultDevice ?? true;
    this.gestures =
      options.gestures ??
      (typeof document !== "undefined" ? (document as GestureSource) : undefined);
    this.onPlaybackBlockedCallback = options.onPlaybackBlocked;
    this.onPlaybackRecoveredCallback = options.onPlaybackRecovered;
    this.playoutGuardOptions = options.playoutGuard;
    this.makeStream =
      options.makeStream ??
      (typeof MediaStream === "function"
        ? (tracks) => new MediaStream(tracks as MediaStreamTrack[]) as StreamLike
        : undefined);

    this.levelMeter = new LocalAudioLevelMeter({
      createContext:
        options.createAudioContext === undefined
          ? browserAudioContextFactory()
          : options.createAudioContext,
      makeStream: this.makeStream,
      intervalMs: options.localAudioLevelIntervalMs,
      onLevel: (level) => this.callbacks.onLocalAudioLevel?.(level),
      onPeak: (peak, precise) => this.observeMicPeak(peak, precise),
      onNeedsGesture: () => {
        this.syncGestures();
        this.evaluateMic();
      },
    });

    this.timings = { ...HEALTH_TIMINGS, ...(options.healthTimings ?? {}) };
    const nav = (
      globalThis as { navigator?: { permissions?: PermissionsLike; userAgent?: string } }
    ).navigator;
    this.permissions =
      options.permissions === undefined ? (nav?.permissions ?? null) : options.permissions;
    this.userAgent = options.userAgent ?? nav?.userAgent;
    this.framePolicy =
      options.framePolicy === undefined ? browserFramePolicy() : options.framePolicy;

    this.slots = {
      audio: newSlot("audio", "audio", "audioinput", true, true),
      video: newSlot("video", "video", "videoinput", true, false),
    };
    this.screen = newSlot("screenVideo", "video", "videoinput", false, false);

    this.healthStore = new CallHealthStore({
      mic: { state: "off" },
      cam: { state: "off" },
      speaker: { state: "idle", device: null },
      screen: this.mediaDevices.getDisplayMedia ? { state: "off" } : { state: "not-supported" },
      connection: INITIAL_CONNECTION,
    });
  }

  /** Every slot, in transceiver order: 0 audio, 1 camera, 2 screen (SPEC.md § Ground truth). */
  private allSlots(): Slot[] {
    return [this.slots.audio, this.slots.video, this.screen];
  }

  // ---------------------------------------------------------------- options

  setUserAudioCallback(userAudioCallback: (data: ArrayBuffer) => void): void {
    // Inert for SmallWebRTC: user audio leaves over the peer connection, never
    // through a PCM callback. Stored so the surface is honest, never called.
    this.userAudioCallback = userAudioCallback;
  }

  setClientOptions(options: MediaClientOptions, override = false): void {
    if (this.options && !override) return;
    this.options = options;
    this.callbacks = options.callbacks ?? {};
    this.micEnabled = options.enableMic ?? true;
    this.camEnabled = options.enableCam ?? false;
    this.slots.audio.desired = this.micEnabled;
    this.slots.video.desired = this.camEnabled;
    // `enableScreenShare` in the client options is deliberately NOT honoured
    // here. Screen capture needs a user gesture, and `setClientOptions` is
    // called from a constructor — starting one from here would either be
    // refused by the browser or, worse, prompt the user out of nowhere.
  }

  /** @internal `attachTrackChangedHandler()` subscribes through this. */
  setLocalTrackChangedHandler(handler: LocalTrackChangedHandler | null): void {
    this.localTrackChangedHandler = handler;
  }

  // -------------------------------------------------------------- lifecycle

  async initialize(): Promise<void> {
    if (this.destroyed) throw new Error("VoqalizeMediaManager has been destroyed");
    if (!this.initialized) {
      this.mediaDevices.addEventListener?.("devicechange", this.onDeviceChange);
      this.visibility?.addEventListener("visibilitychange", this.onVisibilityChange);
      this.watchPermissions();
      this.initialized = true;
    }
    await this.enqueue(async () => {
      await this.ensureDesired();
      await this.publishDeviceLists();
    });
  }

  async connect(): Promise<void> {
    if (!this.initialized) await this.initialize();
    this.connected = true;
    await this.enqueue(async () => {
      await this.ensureDesired();
      // Decision 1: a new clone per peer connection. The transport's
      // closePeerConnection() stops sender tracks, so a clone must never be
      // shared across two peer connections. Screen share is included: a
      // reconnect must not silently drop a share the user started.
      for (const slot of this.allSlots()) {
        if (isLive(slot.capture)) await this.republish(slot);
      }
    });
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    await this.enqueue(async () => {
      // The call is over, so the share is over. `desired` is cleared for the
      // screen slot only — the two device slots keep theirs, because
      // `initialize()` after a reconnect is supposed to bring the mic back.
      this.screen.desired = false;
      for (const slot of this.allSlots()) await this.release(slot);
    });
  }

  /**
   * Release every device and listener for good. Internal: pipecat's lifecycle
   * is `disconnect()`, and a manager that is dropped is collected.
   *
   * @internal
   */
  async destroy(): Promise<void> {
    if (this.destroyed) return;
    await this.disconnect();
    this.mediaDevices.removeEventListener?.("devicechange", this.onDeviceChange);
    this.visibility?.removeEventListener("visibilitychange", this.onVisibilityChange);
    if (this.deviceChangeTimer) clearTimeout(this.deviceChangeTimer);
    this.deviceChangeTimer = null;
    for (const slot of this.allSlots()) this.clearMutedTimer(slot);
    this.stopPublishWatchdog();
    for (const guard of this.guards.values()) guard.stop();
    this.guards.clear();
    this.blockedElements.clear();
    this.levelMeter.stop();
    for (const unwatch of this.permissionUnwatch.splice(0)) unwatch();
    if (this.speakerTimer) clearTimeout(this.speakerTimer);
    this.speakerTimer = null;
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = null;
    this.healthStore.clear();
    this.armGestures(false);
    this.statsSource = null;
    this.outputElements.clear();
    this.destroyed = true;
    this.initialized = false;
  }

  // ----------------------------------------------------- inert for this transport

  async userStartedSpeaking(): Promise<unknown> {
    // Bot audio arrives as a remote WebRTC track; there is no local player to
    // interrupt. Present because the interface requires it.
    return undefined;
  }

  bufferBotAudio(_data: ArrayBuffer | Int16Array, _id?: string): Int16Array | undefined {
    // Same reason. Never called by SmallWebRTCTransport.
    return undefined;
  }

  // ----------------------------------------------------------------- devices

  async getAllMics(): Promise<MediaDeviceInfo[]> {
    return this.devicesOfKind("audioinput");
  }

  async getAllCams(): Promise<MediaDeviceInfo[]> {
    return this.devicesOfKind("videoinput");
  }

  async getAllSpeakers(): Promise<MediaDeviceInfo[]> {
    return this.devicesOfKind("audiooutput");
  }

  async updateMic(micId: string): Promise<void> {
    await this.enqueue(() => this.selectInput(this.slots.audio, micId || "default"));
  }

  async updateCam(camId: string): Promise<void> {
    await this.enqueue(() => this.selectInput(this.slots.video, camId || "default"));
  }

  async updateSpeaker(speakerId: string): Promise<void> {
    await this.enqueue(async () => {
      const requested = speakerId || "default";
      const speakers = await this.getAllSpeakers();
      const found = resolveDevice(speakers, requested);
      if (requested !== "default" && !found) {
        throw this.reportError(
          new DOMException(`Audio output device '${requested}' was not found`, "NotFoundError"),
          ["speaker"],
        );
      }
      this.selectedSpeakerId = requested;
      this.selectedSpeakerInfo = found ?? syntheticDevice("audiooutput", requested);
      this.speakerRecovered = null;
      await this.applySinkToAll(requested);
      this.refreshSpeaker();
      if ("deviceId" in this.selectedSpeakerInfo) {
        this.callbacks.onSpeakerUpdated?.(this.selectedSpeakerInfo);
      }
    });
  }

  get selectedMic(): MediaDeviceInfo | Record<string, never> {
    return this.selectedMicInfo;
  }

  get selectedCam(): MediaDeviceInfo | Record<string, never> {
    return this.selectedCamInfo;
  }

  get selectedSpeaker(): MediaDeviceInfo | Record<string, never> {
    return this.selectedSpeakerInfo;
  }

  /**
   * Hand the manager the element the agent plays on. Returns the unbind.
   *
   * SmallWebRTCTransport owns no playback element, so this is where the
   * manager's output work happens: the element follows `updateSpeaker()`; a
   * `play()` the browser refuses is retried on the user's next tap or key;
   * and an element that stops playing the agent's track while it is arriving
   * is re-attached (`playoutGuard.ts`). The app still sets `srcObject`.
   */
  bindOutputElement(element: OutputElementLike): () => void {
    this.outputElements.add(element);
    this.guard(element);
    // Binding is synchronous to the caller but routing and playback are not, so
    // this promise has nobody to reject to. It must be caught here: an
    // unhandled rejection is an uncaught error in the host page, and a
    // *binding* call that can crash the app over speaker routing is the wrong
    // trade — the element still plays, just on the default device. Reported on
    // the device-error channel so it is visible rather than silent.
    void this.applySink(element, this.selectedSpeakerId)
      .catch((error: unknown) => {
        this.reportError(error, ["speaker"]);
      })
      .then(() => this.ensurePlaying(element))
      .then(() => this.refreshSpeaker());
    this.refreshSpeaker();
    return () => {
      this.outputElements.delete(element);
      this.guards.get(element)?.stop();
      this.guards.delete(element);
      // An element that leaves while blocked must not keep the retry armed.
      if (this.blockedElements.delete(element)) this.publishPlaybackBlocked();
      this.refreshSpeaker();
    };
  }

  /**
   * @internal
   * Lend the guard the peer connection's stats. `createVoqalizeTransport()`
   * does this; an app wiring the manager by hand calls
   * `attachTrackChangedHandler()`, which does it too. Without it the guard
   * still answers the element's `error`, a second later than it could.
   */
  setStatsSource(source: PlayoutStatsSource | null): void {
    this.statsSource = source;
  }

  private guard(element: OutputElementLike): void {
    if (this.playoutGuardOptions === false || !this.makeStream || this.guards.has(element)) return;
    const makeStream = this.makeStream;
    this.guards.set(
      element,
      new PlayoutGuard(element, {
        ...this.playoutGuardOptions,
        stats: () => this.statsSource,
        makeStream,
        play: (el) => void this.ensurePlaying(el),
        onRecovered: (reason) => {
          this.speakerStalled();
          this.onPlaybackRecoveredCallback?.(reason);
        },
      }),
    );
  }

  /**
   * @internal
   * True while the browser is refusing to play at least one bound element.
   *
   * Autoplay is the failure where every other number looks healthy — frames
   * encode, packets arrive, `getStats()` is green — and the person on the call
   * hears silence. Nothing else in the stack reports it, so this does.
   */
  get playbackBlocked(): boolean {
    return this.blockedElements.size > 0;
  }

  /**
   * @internal
   * Retry playback on every element the browser refused. Returns true when
   * they are all playing. The manager calls this from the next user gesture
   * on the page (`armGestures`), so no app has to.
   *
   * It must run synchronously inside the gesture, with nothing awaited before
   * it. This is the same constraint `getDisplayMedia` has and it is why, like
   * that call, it is deliberately *not* put on the mutation queue: queueing
   * would push the `play()` outside the activation window the browser grants
   * the gesture, and the retry would be refused for exactly the reason it is
   * being retried.
   */
  async resumePlayback(): Promise<boolean> {
    const blocked = [...this.blockedElements];
    await Promise.all(blocked.map((element) => this.ensurePlaying(element)));
    return !this.playbackBlocked;
  }

  /**
   * Attempt playback, and classify a refusal rather than swallowing it.
   *
   * - `NotAllowedError` is the autoplay policy. It is not an error the app can
   *   fix and not a device failure — it needs a gesture — so the element is
   *   retried on the next one, and the device-error channel stays clean.
   * - `AbortError` is a `play()` interrupted by a new `load()`/`srcObject`,
   *   which is routine when a track is swapped mid-call. Ignored on purpose.
   * - Anything else is a real playback fault and is reported as a speaker
   *   device error.
   */
  private async ensurePlaying(element: OutputElementLike): Promise<void> {
    if (typeof element.play !== "function") return;
    try {
      await element.play();
      if (this.blockedElements.delete(element)) this.publishPlaybackBlocked();
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      if (name === "AbortError") return;
      if (name === "NotAllowedError" || name === "SecurityError") {
        const wasBlocked = this.blockedElements.has(element);
        this.blockedElements.add(element);
        if (!wasBlocked) this.publishPlaybackBlocked();
        return;
      }
      this.reportError(error, ["speaker"]);
    }
  }

  /** Edge-triggered, and keeps the gesture retry armed exactly while something is blocked. */
  private publishPlaybackBlocked(): void {
    const blocked = this.playbackBlocked;
    this.syncGestures();
    this.refreshSpeaker();
    if (blocked === this.playbackBlockedReported) return;
    this.playbackBlockedReported = blocked;
    this.onPlaybackBlockedCallback?.(blocked);
  }

  /** Armed while anything needs a gesture: a refused element, or a held level meter. */
  private syncGestures(): void {
    this.armGestures(
      !this.destroyed && (this.playbackBlocked || this.levelMeter.waitingForGesture),
    );
  }

  /**
   * Listen for the gestures that grant playback (`pointerdown` and `keydown`,
   * the activation-triggering events every engine shares) in the capture
   * phase, so an app that stops propagation does not swallow the retry.
   */
  private armGestures(arm: boolean): void {
    if (!this.gestures || arm === this.gesturesArmed) return;
    this.gesturesArmed = arm;
    for (const type of GESTURE_EVENTS) {
      if (arm) this.gestures.addEventListener(type, this.onGesture, true);
      else this.gestures.removeEventListener(type, this.onGesture, true);
    }
  }

  // ----------------------------------------------------------------- capture

  async enableMic(enable: boolean): Promise<void> {
    this.micEnabled = enable;
    await this.setDesired(this.slots.audio, enable, this.releaseMicOnDisable);
  }

  async enableCam(enable: boolean): Promise<void> {
    this.camEnabled = enable;
    await this.setDesired(this.slots.video, enable, this.releaseCamOnDisable);
  }

  /**
   * One body for both device slots. The only difference between mic and camera
   * is what a *disable* means: a held-but-disabled mic re-enables instantly and
   * costs nothing visible, while a held-but-disabled camera leaves the hardware
   * indicator lit — a user who turned their camera off and still sees the light
   * is right to conclude we are lying to them. Hence `releaseCamOnDisable`
   * defaults true and `releaseMicOnDisable` defaults false.
   */
  private async setDesired(slot: Slot, enable: boolean, releaseOnDisable: boolean): Promise<void> {
    slot.desired = enable;
    await this.enqueue(async () => {
      if (enable) {
        if (!isLive(slot.capture)) {
          try {
            // A fresh acquire publishes a clone and announces it itself; do
            // not announce it twice.
            await this.acquire([slot]);
          } catch {
            // Already reported as a DeviceError.
          }
          return;
        }
        const wasEnabled = slot.published?.enabled ?? false;
        this.setSlotEnabled(slot, true);
        if (!wasEnabled) this.resumeCaptureHealth(slot);
        if (!wasEnabled && slot.published) this.announceStarted(slot, slot.published);
      } else if (slot.capture) {
        if (releaseOnDisable) {
          await this.release(slot);
        } else {
          const published = slot.published;
          const wasEnabled = published?.enabled ?? false;
          this.setSlotEnabled(slot, false);
          this.settleCaptureHealth(slot);
          if (wasEnabled && published) this.announceStopped(slot, published);
        }
      } else if (slot.health.state !== "off") {
        this.setCaptureHealth(slot, { state: "off" });
      }
    });
  }

  /**
   * Decision 2's one exception. The `getDisplayMedia` **prompt** is issued
   * un-queued, synchronously inside this call, so it stays within the user
   * activation the caller's click granted — put it behind the mutation queue
   * and a browser refuses it with `NotAllowedError` because the activation has
   * expired. Only the **install** is queued.
   *
   * Concurrent callers share the whole operation, not just the prompt. See
   * `screenRequest` for why that distinction is the bug this replaces.
   */
  enableScreenShare(enable: true, hints?: ScreenPickerHints): Promise<"started" | "cancelled">;
  enableScreenShare(enable: false): Promise<void>;
  enableScreenShare(
    enable: boolean,
    hints?: ScreenPickerHints,
  ): Promise<"started" | "cancelled" | void>;
  enableScreenShare(
    enable: boolean,
    hints?: ScreenPickerHints,
  ): Promise<"started" | "cancelled" | void> {
    if (!enable) {
      this.screen.desired = false;
      return this.enqueue(() => this.release(this.screen));
    }
    if (hints?.displaySurface === "monitor" && hints.monitorTypeSurfaces === "exclude") {
      // Rejected here rather than by the engine, which would throw a TypeError
      // on some versions and silently show an empty picker on others.
      return Promise.reject(
        new TypeError(
          'displaySurface "monitor" cannot be combined with monitorTypeSurfaces "exclude"',
        ),
      );
    }
    if (this.screenRequest) return this.screenRequest;
    if (isLive(this.screen.capture)) return Promise.resolve("started");

    this.screen.desired = true;
    const request = this.startScreenShare(hints);
    this.screenRequest = request;
    // `finally` rather than a detached `catch`: the caller still sees the
    // rejection, and the slot is already clear by the time they do — so a
    // refusal the user answers by clicking again prompts, rather than joining
    // a request that is already over.
    return request.finally(() => {
      if (this.screenRequest === request) this.screenRequest = null;
    });
  }

  private async startScreenShare(hints?: ScreenPickerHints): Promise<"started" | "cancelled"> {
    const getDisplayMedia = this.mediaDevices.getDisplayMedia?.bind(this.mediaDevices);
    if (!getDisplayMedia) {
      // Decision 4: `supportsScreenShare` stays true so the m-line count never
      // varies by engine; this is where an engine that cannot honour it says so.
      this.screen.desired = false;
      throw this.reportScreenError(
        new DOMException("Screen sharing is not supported by this browser", "NotSupportedError"),
      );
    }

    this.setScreenHealth({ state: "asking" });
    let stream;
    try {
      // Decision 9: video only. Screen audio would need a fourth transceiver
      // and a member pipecat's interface does not have, and it puts system
      // audio into the AEC's reference path.
      stream = await getDisplayMedia(displayMediaOptions(hints));
    } catch (error) {
      this.screen.desired = false;
      const raw = rawError(error);
      const pageBlocked = this.framePolicy ? !this.framePolicy("display-capture") : false;
      const systemDenied = SYSTEM_DENIAL.test(raw.message);
      if (raw.name === "NotAllowedError" && !pageBlocked && !systemDenied) {
        // The person closed the picker. Not an error, so no error callbacks:
        // the call resolves "cancelled" and the screen is simply off.
        this.setScreenHealth({ state: "off" });
        return "cancelled";
      }
      const problem: Problem = pageBlocked
        ? { code: "blocked", by: "page" }
        : systemDenied
          ? { code: "blocked", by: "os" }
          : raw.name === "OverconstrainedError" || raw.name === "InvalidAccessError"
            ? // Our size bounds, not a missing device: this browser cannot capture
              // as asked. Safari's InvalidAccessError is a call made outside a
              // user gesture, which it refuses: nothing the person can fix.
              { code: "not-supported" }
            : classifyCaptureError(error, "cam", this.captureEnvironment("video", "unknown"))
                .problem;
      this.setScreenHealth({
        state: "failed",
        problem,
        fixes: fixesFor(problem, "screen"),
        error: raw,
      });
      throw this.reportScreenError(error);
    }

    let started = false;
    await this.enqueue(async () => {
      const track = stream.getVideoTracks()[0];
      // `enableScreenShare(false)` may have arrived while the picker was open.
      // Honouring it here is the difference between "the user changed their
      // mind" and "a share they cancelled is now live".
      if (!track || !this.screen.desired) {
        for (const other of stream.getTracks()) safeStop(other);
        if (!track) {
          throw this.reportScreenError(
            new DOMException("Screen capture returned no video track", "NotFoundError"),
          );
        }
        return;
      }
      // Defensive: an engine that hands back audio despite `audio: false` must
      // not leave a live system-audio track running.
      for (const other of stream.getTracks()) if (other !== track) safeStop(other);
      await this.install(this.screen, track);
      started = true;
      const surface = (track.getSettings() as { displaySurface?: string }).displaySurface;
      this.setScreenHealth({
        state: "live",
        surface:
          surface === "monitor" || surface === "window" || surface === "browser"
            ? surface
            : "unknown",
      });
    }).catch((error: unknown) => {
      if (this.healthStore.snapshot.screen.state !== "failed")
        this.setScreenHealth({ state: "off" });
      throw error;
    });
    if (!started && this.healthStore.snapshot.screen.state === "asking") {
      this.setScreenHealth({ state: "off" });
    }
    return started ? "started" : "cancelled";
  }

  get isMicEnabled(): boolean {
    return this.micEnabled;
  }

  get isCamEnabled(): boolean {
    return this.camEnabled && isLive(this.slots.video.capture);
  }

  /**
   * Live capture, not intent. A user who pressed the browser's own "Stop
   * sharing" never touched our API, and a manager that still claimed to be
   * sharing would leave the console's button lit over a dead transceiver.
   */
  get isSharingScreen(): boolean {
    return isLive(this.screen.capture);
  }

  /**
   * Constant `true` (SPEC.md decision 4): the transceiver count must not vary
   * with browser support, or the SDP m-line shape changes underneath the voice runtime.
   * `enableScreenShare` throws where it cannot be honoured.
   */
  get supportsScreenShare(): boolean {
    return true;
  }

  /** The published clones — what the peer connection carries, never the capture tracks. */
  tracks(): Tracks {
    const local: Tracks["local"] = {};
    if (this.slots.audio.published) local.audio = asTrack(this.slots.audio.published);
    if (this.slots.video.published) local.video = asTrack(this.slots.video.published);
    // `screenAudio` is never populated — decision 9.
    if (this.screen.published) local.screenVideo = asTrack(this.screen.published);
    return { local };
  }

  /**
   * @internal
   * The sender settings phase 2b is to apply (SPEC.md decision 8), as data.
   *
   * This phase has no peer connection, so nothing here is applied to an
   * `RTCRtpSender`. Publishing it as a value rather than leaving 2b to
   * re-derive the numbers is what lets 2b assert it applied the manager's
   * intent instead of its own.
   */
  encodingPolicy(): Readonly<Record<SlotKey, EncodingPolicy>> {
    return ENCODING_POLICY;
  }

  /**
   * @internal
   * The device id the manager is currently *asking* for, as opposed to the one
   * it got. Not part of the pipecat surface; it exists because "we stopped
   * asking for the mic you unplugged" is a real behaviour with no other
   * observable, on an engine that enumerates only one mic.
   */
  get requestedMicId(): string {
    return this.slots.audio.deviceId;
  }

  /** @internal The camera twin of `requestedMicId`. */
  get requestedCamId(): string {
    return this.slots.video.deviceId;
  }

  /** @internal The capture tracks the manager owns, for tests and diagnostics. */
  captureTracks(): {
    audio: TrackLike | null;
    video: TrackLike | null;
    screenVideo: TrackLike | null;
  } {
    return {
      audio: this.slots.audio.capture,
      video: this.slots.video.capture,
      screenVideo: this.screen.capture,
    };
  }

  // ------------------------------------------------------------------ queue

  /**
   * Decision 2: one queue, every mutation through it. A rejected operation
   * must not poison the tail, so the tail swallows the result and the caller
   * still sees the rejection.
   */
  private enqueue<T>(operation: () => Promise<T> | T): Promise<T> {
    const run = this.queueTail.then(operation, operation);
    this.queueTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  // ------------------------------------------------------------ acquisition

  private async ensureDesired(): Promise<void> {
    const needed = Object.values(this.slots).filter((s) => s.desired && !isLive(s.capture));
    if (needed.length === 0) return;
    try {
      await this.acquire(needed);
    } catch {
      // A DeviceError was already reported. Initialization stays usable.
    }
  }

  /**
   * Decision 3: ONE `getUserMedia` for every kind being acquired. WebKit stops
   * an earlier track when a second gUM targets the same device group, so two
   * calls is a bug even when it looks like it works.
   */
  private async acquire(slots: Slot[]): Promise<void> {
    if (slots.length === 0) return;
    const constraints: MediaStreamConstraints = { audio: false, video: false };
    for (const slot of slots) {
      constraints[slot.kind] = buildTrackConstraints(
        slot.kind,
        slot.deviceId,
        slot.kind === "audio" ? this.audioConstraints : CAMERA_CONSTRAINTS,
      );
    }

    const devices: DeviceArray = slots.map((s) => (s.kind === "audio" ? "mic" : "cam"));
    for (const slot of slots) {
      const health = slot.health;
      slot.silentReopened =
        health.state === "recovering" && health.cause === "no-signal" ? slot.silentReopened : false;
      if (health.state !== "recovering") slot.recovery = null;
      slot.acquiring = true;
      if (!slot.desired || health.state === "recovering") continue;
      const permission = await this.readPermission(slot.kind);
      this.setCaptureHealth(
        slot,
        permission === "prompt"
          ? { state: "asking" }
          : { state: "starting", device: this.deviceOf(slot) },
      );
    }
    let stream;
    try {
      stream = await this.mediaDevices.getUserMedia(constraints);
    } catch (error) {
      for (const slot of slots) slot.acquiring = false;
      if (slots.length > 1 && !isDenial(error)) {
        // Split retry: one bad device must not take the other kind down with
        // it. A denial is never split — a second prompt is not a retry, it is
        // nagging, and the answer would be the same.
        let failure: unknown = null;
        const started: Slot[] = [];
        for (const slot of slots) {
          try {
            await this.acquire([slot]);
            started.push(slot);
          } catch (each) {
            failure ??= each;
          }
        }
        if (started.length === 0) throw failure;
        // Decision 3 again: on WebKit the later call can stop a track the
        // earlier one opened, when both kinds come from one device group (a
        // webcam with a mic). If a kind that started has ended since, open
        // every kind that started in one call, as the first attempt meant to.
        if (started.length > 1 && started.some((s) => !isLive(s.capture))) {
          await this.acquire(started);
        }
        return;
      }
      for (const slot of slots) await this.failCapture(slot, error);
      throw this.reportError(error, devices);
    }

    const claimed: TrackLike[] = [];
    try {
      for (const slot of slots) {
        const track =
          slot.kind === "audio" ? stream.getAudioTracks()[0] : stream.getVideoTracks()[0];
        if (!track) {
          throw new DOMException(`getUserMedia returned no ${slot.kind} track`, "NotFoundError");
        }
        claimed.push(track);
      }
    } catch (error) {
      for (const track of stream.getTracks()) safeStop(track);
      for (const slot of slots) {
        slot.acquiring = false;
        await this.failCapture(slot, error);
      }
      throw this.reportError(error, devices);
    }

    for (const [index, slot] of slots.entries()) {
      const track = claimed[index];
      try {
        if (track) await this.install(slot, track);
      } finally {
        slot.acquiring = false;
      }
    }
    await this.refreshSelectedDevices(slots);
    for (const slot of slots) this.settleCaptureHealth(slot, true);
    const audio = slots.find((slot) => slot.kind === "audio");
    if (audio) await this.avoidLoopbackOnFirstOpen(audio);
    // An open microphone is what some engines weigh when they decide autoplay:
    // WebKit plays an element it refused once capture is live, with no gesture.
    // Chrome does not, so the gesture retry stays armed either way.
    // [The measurement](../docs/FINDINGS.md#a-page-load-mid-call-plays-without-a-tap-when-the-mic-is-open)
    if (this.playbackBlocked && slots.some((slot) => slot.kind === "audio")) {
      void this.resumePlayback();
    }
  }

  /** Install a freshly-acquired capture track and publish a clone of it. */
  private async install(slot: Slot, next: TrackLike): Promise<void> {
    const previousCapture = slot.capture;
    if (previousCapture === next) return;

    next.contentHint = slot.contentHint; // decision 6
    next.enabled = slot.desired;
    this.attachLifecycle(slot, next);
    slot.capture = next;
    this.clearMutedTimer(slot);

    try {
      await this.republish(slot);
    } catch (error) {
      slot.capture = previousCapture;
      this.stopIntentionally(slot, next);
      throw error;
    }

    if (previousCapture) this.stopIntentionally(slot, previousCapture);
    this.syncLevelMeter(slot);
  }

  /**
   * Decision 1: publish `capture.clone()`. The peer connection gets the clone,
   * the manager keeps the capture track, and a `closePeerConnection()` that
   * stops sender tracks can no longer stop the live mic.
   *
   * Decision 1 is necessary and, on its own, **not sufficient** — see
   * `checkPublishedTracks()`. Publishing a clone saves the microphone; it does
   * not save the call, because one clone is one track object and a reconnect
   * hands it to the new peer connection before stopping it on the old one.
   */
  private async republish(slot: Slot): Promise<void> {
    const previous = slot.published;
    const capture = slot.capture;
    const next = capture ? capture.clone() : null;
    if (next) {
      next.contentHint = slot.contentHint;
      next.enabled = slot.desired;
    }
    slot.published = next;

    try {
      await this.localTrackChangedHandler?.({
        type: slot.key,
        track: next,
        previousTrack: previous,
      });
    } catch (error) {
      slot.published = previous;
      if (next) safeStop(next);
      throw error;
    }

    if (previous) {
      this.announceStopped(slot, previous);
      safeStop(previous);
    }
    if (next && next.enabled) {
      this.announceStarted(slot, next);
    }
    this.syncPublishWatchdog();
  }

  // ------------------------------------------------- the published-clone watchdog

  /**
   * **The published clone died but the capture track is alive.** Re-clone and
   * re-publish.
   *
   * This is the second half of decision 1, and it is not optional. Read
   * `SmallWebRTCTransport.attemptReconnection(true)` in order:
   *
   *   1. `startNewPeerConnection()` → `addUserMedia()` reads
   *      `mediaManager.tracks().local` and `replaceTrack`s what it finds onto
   *      the **new** senders. What it finds is the clone.
   *   2. `closePeerConnection(oldPC)` → `sender.track.stop()` on every sender
   *      of the **old** peer connection. Same clone. One track object, two
   *      peer connections, and it is now `ended` on both.
   *
   * The result, measured in chromium on 2026-09-07 through
   * `tests/network.spec.ts`: `connectionState: "connected"`,
   * `iceConnectionState: "connected"`, three m-lines, the capture microphone
   * still `live` — and `packetsSent: 0`, forever. Every number a dashboard
   * would show is green and the call is silent. Publishing a clone saves the
   * *microphone*; only this saves the *call*.
   *
   * Why a poll and not a listener: `MediaStreamTrack.stop()` fires **no**
   * `ended` event — that is the specified behaviour and it is what the rest of
   * this file relies on to tell "we stopped it" from "it died"
   * (`intentionalStops`). So a clone stopped by someone else is a track that
   * became dead with no notification on any engine. There is nothing to listen
   * to. The tick reads three `readyState` properties and does nothing else.
   */
  private checkPublishedTracks(): void {
    if (this.destroyed) return;
    for (const slot of this.allSlots()) {
      const published = slot.published;
      if (!published || published.readyState !== "ended") continue;
      if (!isLive(slot.capture)) continue; // the capture side owns that recovery
      void this.enqueue(async () => {
        // Re-checked inside the queue: a switch or a release may have landed
        // between the tick and our turn, and either one already replaced this.
        if (slot.published !== published || !isLive(slot.capture)) return;
        await this.republish(slot);
      }).catch(() => undefined);
    }
  }

  /** Run the watchdog exactly while there is something published to watch. */
  private syncPublishWatchdog(): void {
    if (this.publishWatchdogMs <= 0) return;
    const wanted = !this.destroyed && this.allSlots().some((slot) => !!slot.published);
    if (wanted && !this.publishWatchdog) {
      this.publishWatchdog = setInterval(() => this.checkPublishedTracks(), this.publishWatchdogMs);
    } else if (!wanted) {
      this.stopPublishWatchdog();
    }
  }

  private stopPublishWatchdog(): void {
    if (this.publishWatchdog === null) return;
    clearInterval(this.publishWatchdog);
    this.publishWatchdog = null;
  }

  /** Release a slot entirely: unpublish, stop the clone, stop the capture track. */
  private async release(slot: Slot): Promise<void> {
    const capture = slot.capture;
    const published = slot.published;
    if (!capture && !published) {
      if (slot !== this.screen && slot.health.state !== "off" && slot.health.state !== "failed") {
        this.setCaptureHealth(slot, { state: "off" });
      }
      return;
    }
    slot.capture = null;
    slot.published = null;
    this.clearMutedTimer(slot);
    this.forgetCamServer(slot);
    if (slot === this.screen) {
      this.setScreenHealth({ state: "off", ended: "app" });
    } else {
      this.setCaptureHealth(slot, { state: "off" });
    }
    slot.detach?.();
    slot.detach = null;

    await this.localTrackChangedHandler?.({
      type: slot.key,
      track: null,
      previousTrack: published,
    });
    if (published) {
      this.announceStopped(slot, published);
      safeStop(published);
    }
    if (capture) this.stopIntentionally(slot, capture);
    this.syncPublishWatchdog();
    this.syncLevelMeter(slot);
  }

  private setSlotEnabled(slot: Slot, enabled: boolean): void {
    if (slot.capture) slot.capture.enabled = enabled;
    if (slot.published) slot.published.enabled = enabled; // decision 1: mirror onto the clone
    this.syncLevelMeter(slot);
  }

  // ------------------------------------------------------------- call health

  /**
   * Subscribe to `CallHealth`. The listener is called at once with the current
   * snapshot, then on every change; snapshots are frozen and only issued when
   * something in them changed. Returns the unsubscribe. Works before
   * `initialize()` and before `connect()`: health is about the devices first.
   */
  onCallHealthChanged(listener: CallHealthListener): () => void {
    return this.healthStore.subscribe(listener);
  }

  /**
   * @internal The current snapshot, for this package's lab. Not public: the
   * owner ruled out a status property — a page subscribes.
   */
  get callHealth(): CallHealth {
    return this.healthStore.snapshot;
  }

  /** @internal The transport's half: the connection's state and grades. */
  _setConnectionHealth(patch: Partial<ConnectionHealth>): void {
    const before = this.uplinkStarved();
    const next = { ...this.healthStore.snapshot.connection, ...patch };
    // A new state without a reason has none; only `disconnected` ever has one.
    if (next.state !== "disconnected" || ("state" in patch && !("reason" in patch)))
      delete next.reason;
    this.healthStore.update({ connection: next });
    // The camera's "none" is read against the uplink; see evaluateCam.
    if (this.uplinkStarved() !== before) this.evaluateCam();
  }

  private uplinkStarved(): boolean {
    const uplink = this.healthStore.snapshot.connection.uplink;
    return uplink === "poor" || uplink === "bad";
  }

  /** @internal For the unreachable bound: a permission prompt is open. */
  _captureAsking(): boolean {
    const { mic, cam } = this.healthStore.snapshot;
    return mic.state === "asking" || cam.state === "asking";
  }

  /**
   * @internal What the voice runtime hears of the mic (`caller-audio`) or sees of the
   * camera (`caller-video`), or unmeasured when it says nothing.
   */
  _setServerSignal(server: Signal["server"], device: "mic" | "cam" = "mic"): void {
    if (device === "cam") {
      // A verdict in flight as the camera was muted or switched off is about a
      // picture that is gone: the next one starts afresh.
      const cam = this.slots.video;
      if (!isLive(cam.capture) || !cam.capture.enabled || !cam.desired) server = "unmeasured";
      if (server === this.camServer) return;
      this.camServer = server;
      this.evaluateCam();
      return;
    }
    if (server === this.serverSignal) return;
    this.serverSignal = server;
    if (server === "sound") this.slots.audio.heard = true;
    this.evaluateMic();
    // The camera's "none" is read against the mic's; see evaluateCam.
    this.evaluateCam();
  }

  private serverOf(slot: Slot): Signal["server"] {
    return slot.kind === "audio" ? this.serverSignal : this.camServer;
  }

  /**
   * The camera was switched off: the voice runtime stops judging it, and judges afresh
   * once it is back on, so its last verdict is no longer this camera's.
   */
  private forgetCamServer(slot: Slot): void {
    if (slot.kind === "video" && slot !== this.screen) this.camServer = "unmeasured";
  }

  private setCaptureHealth(slot: Slot, health: CaptureHealth): void {
    if (slot === this.screen) return;
    slot.health = health;
    this.healthStore.update(slot.kind === "audio" ? { mic: health } : { cam: health });
  }

  private setScreenHealth(health: ScreenHealth): void {
    this.healthStore.update({ screen: health });
  }

  private deviceOf(slot: Slot, track: TrackLike | null = slot.capture): Device {
    let deviceId = "";
    let label = "";
    if (track) {
      try {
        deviceId = track.getSettings().deviceId ?? "";
      } catch {
        // A track that cannot describe itself.
      }
      label = track.label ?? "";
    }
    const selected = slot.kind === "audio" ? this.selectedMicInfo : this.selectedCamInfo;
    if ("deviceId" in selected) {
      if (!deviceId) deviceId = selected.deviceId;
      if (!label && selected.deviceId === deviceId) label = selected.label;
    }
    return describeDevice(deviceId || slot.deviceId, label, slot.kind === "audio");
  }

  private async readPermission(kind: InputKind): Promise<PermissionReading> {
    const permissions = this.permissions;
    if (!permissions) return "unknown";
    try {
      const status = await permissions.query({ name: kind === "audio" ? "microphone" : "camera" });
      const reading = asReading(status.state);
      this.permissionReadings[kind] = reading;
      return reading;
    } catch {
      // Firefox before 131 knows no "camera"/"microphone"; some webviews have no API.
      return this.permissionReadings[kind];
    }
  }

  /**
   * Watch both permissions for the rest of the manager's life. A permission
   * granted in the browser's site settings while the slot is failed is a
   * recovery: open the device again without a click.
   */
  private watchPermissions(): void {
    const permissions = this.permissions;
    if (!permissions) return;
    for (const kind of ["audio", "video"] as const) {
      void permissions
        .query({ name: kind === "audio" ? "microphone" : "camera" })
        .then((status) => {
          if (this.destroyed) return;
          this.permissionReadings[kind] = asReading(status.state);
          if (typeof status.addEventListener !== "function") return;
          const onChange = () => this.permissionChanged(kind, asReading(status.state));
          status.addEventListener("change", onChange);
          this.permissionUnwatch.push(() => status.removeEventListener?.("change", onChange));
        })
        .catch(() => undefined);
    }
  }

  private permissionChanged(kind: InputKind, reading: PermissionReading): void {
    this.permissionReadings[kind] = reading;
    const slot = this.slots[kind];
    const health = slot.health;
    if (reading !== "granted" || health.state !== "failed" || !slot.desired) return;
    if (health.problem.code !== "blocked" && health.problem.code !== "prompt-dismissed") return;
    const device = this.deviceOf(slot);
    slot.recovery = { from: null, cause: "permission-granted" };
    this.setCaptureHealth(slot, { state: "recovering", device, cause: "permission-granted" });
    void this.enqueue(async () => {
      if (!slot.desired || this.destroyed) return;
      try {
        await this.acquire([slot]);
      } catch {
        // Already reported as a DeviceError.
      }
    });
  }

  private captureEnvironment(kind: InputKind, permission: PermissionReading) {
    return {
      permission,
      framePolicyBlocked: this.framePolicy
        ? !this.framePolicy(kind === "audio" ? "microphone" : "camera")
        : false,
      inAppBrowser: isInAppBrowser(this.userAgent),
    };
  }

  private async failCapture(slot: Slot, error: unknown): Promise<void> {
    if (!this.supported) {
      const problem: Problem = { code: "not-supported" };
      this.setCaptureHealth(slot, {
        state: "failed",
        device: null,
        problem,
        fixes: fixesFor(problem, slot.kind === "audio" ? "mic" : "cam"),
        error: rawError(error),
      });
      return;
    }
    const permission = await this.readPermission(slot.kind);
    const classified = classifyCaptureError(
      error,
      slot.kind === "audio" ? "mic" : "cam",
      this.captureEnvironment(slot.kind, permission),
    );
    slot.recovery = null;
    this.setCaptureHealth(slot, {
      state: "failed",
      device: slot.deviceId === "default" ? null : this.deviceOf(slot, null),
      problem: classified.problem,
      fixes: classified.fixes,
      error: classified.error,
    });
  }

  /**
   * Bring a slot's health in line with its capture. `fresh` is a capture that
   * just opened: its signal history starts over, and its first reading decides
   * between live and the silent-device rules.
   */
  private settleCaptureHealth(slot: Slot, fresh = false): void {
    if (slot === this.screen) return;
    const capture = slot.capture;
    if (!isLive(capture)) {
      if (!slot.desired && slot.health.state !== "failed")
        this.setCaptureHealth(slot, { state: "off" });
      return;
    }
    if (!capture.enabled || !slot.desired) {
      this.forgetCamServer(slot);
      this.setCaptureHealth(slot, { state: "muted", device: this.deviceOf(slot) });
      return;
    }
    if (fresh) {
      slot.quietSince = null;
      slot.local = "unmeasured";
      slot.heard = false;
      slot.soundRun = null;
      slot.openedAt = Date.now();
      slot.recovered = null;
    }
    if (slot.kind === "video") {
      this.evaluateCam();
      return;
    }
    if (fresh && slot.health.state !== "recovering") {
      this.setCaptureHealth(slot, { state: "starting", device: this.deviceOf(slot) });
    }
    this.evaluateMic();
  }

  /** Unmute: the same capture comes back, and the silence clock restarts. */
  private resumeCaptureHealth(slot: Slot): void {
    slot.quietSince = null;
    if (slot.health.state === "muted") {
      this.setCaptureHealth(slot, {
        state: "live",
        device: slot.health.device,
        signal: { local: slot.local, server: this.serverOf(slot) },
      });
    }
    this.settleCaptureHealth(slot);
  }

  private observeMicPeak(peak: number, precise: boolean): void {
    const slot = this.slots.audio;
    const capture = slot.capture;
    if (!isLive(capture) || !capture.enabled) return;
    if (peak > SILENT_PEAK) {
      const now = Date.now();
      slot.local = "sound";
      slot.quietSince = null;
      const run = slot.soundRun;
      slot.soundRun =
        run && now - run.last <= this.timings.heardGapMs
          ? { from: run.from, last: now }
          : { from: now, last: now };
      if (now - slot.soundRun.from >= this.timings.heardAfterMs) {
        slot.heard = true;
        slot.interruptions = 0;
      }
    } else if (precise) {
      // Byte-depth analysers cannot tell digital silence from a quiet room,
      // so only a float reading starts the silence clock.
      slot.quietSince ??= Date.now();
    } else {
      return;
    }
    this.evaluateMic();
  }

  /** The mic's signal rules; see `HealthTimings`. Idempotent: call it whenever an input changed. */
  private evaluateMic(): void {
    const slot = this.slots.audio;
    const capture = slot.capture;
    const health = slot.health;
    if (!isLive(capture) || !capture.enabled || !slot.desired || slot.acquiring) return;
    if (health.state === "recovering" && health.cause !== "no-signal" && !slot.heard) {
      // Still opening after a device-lost or interruption: the first reading decides.
      if (!this.levelMeter.measuring) this.goLive(slot);
      else this.judgeSilence(slot);
      return;
    }
    if (health.state === "failed" && health.problem.code !== "no-signal") return;
    const measuring = this.levelMeter.measuring;
    if (!measuring) {
      slot.local = "unmeasured";
      slot.quietSince = null;
    }
    this.judgeSilence(slot);
  }

  private judgeSilence(slot: Slot): void {
    if (this.deviceOf(slot).traits.includes("virtual")) {
      // A noise-gated virtual mic (Krisp, NVIDIA Broadcast) sends exact zeros
      // whenever nobody speaks, so its silence says nothing about the device.
      this.goLive(slot);
      return;
    }
    const now = Date.now();
    const quietFor = slot.quietSince === null ? 0 : now - slot.quietSince;
    const sinceOpen = now - slot.openedAt;
    // The voice runtime's verdict stands in only where this page cannot measure. Only
    // "silent" counts: "none" (no packets) is also what a network drop looks
    // like, and the connection's grades say that. Where this page measures,
    // its own reading wins — the voice runtime's floor is provisional until it is set from
    // hardware data, and a quiet room under noise suppression must not read as
    // a broken mic. (Sound here with "silent" at the voice runtime would mean our publish
    // path is broken; that warning waits for the floors to agree.)
    const serverSilent =
      slot.local === "unmeasured" &&
      this.serverSignal === "silent" &&
      sinceOpen >= this.timings.silentAtJoinMs;

    if (!slot.heard) {
      if ((slot.quietSince !== null && quietFor >= this.timings.silentAtJoinMs) || serverSilent) {
        if (slot.quietSince !== null) slot.local = "silent";
        this.silentAtJoin(slot);
        return;
      }
      // A failed mic leaves only on a sustained sound (`heard`), or on the voice runtime
      // hearing it where this page cannot: one click from a dead mic is not a voice.
      if (slot.health.state === "failed" && slot.local !== "unmeasured") return;
      if (slot.health.state === "failed" && this.serverSignal !== "sound") return;
      // Nothing decided yet: starting stays starting while the meter listens;
      // with nothing to listen with, the device is live and unmeasured.
      if (slot.health.state === "starting" || slot.health.state === "recovering") {
        if (this.levelMeter.measuring) {
          this.armSilenceCheck(slot, this.timings.silentAtJoinMs - quietFor);
          return;
        }
      }
      this.goLive(slot);
      return;
    }

    if ((slot.quietSince !== null && quietFor >= this.timings.degradedAfterMs) || serverSilent) {
      if (slot.quietSince !== null) slot.local = "silent";
      const problem: Problem = { code: "no-signal" };
      this.setCaptureHealth(slot, {
        state: "degraded",
        device: this.deviceOf(slot),
        signal: { local: slot.local, server: this.serverSignal },
        problem,
        fixes: fixesFor(problem, "mic"),
      });
      return;
    }
    this.goLive(slot);
  }

  /** Re-judge when a silence window would close, in case no tick lands then. */
  private armSilenceCheck(slot: Slot, inMs: number): void {
    if (slot.quietSince === null || this.silenceTimer) return;
    this.silenceTimer = setTimeout(
      () => {
        this.silenceTimer = null;
        this.evaluateMic();
      },
      Math.max(0, inMs) + 1,
    );
  }

  /** A device that opened and has never made a sound: reopen it once, then say so. */
  private silentAtJoin(slot: Slot): void {
    const device = this.deviceOf(slot);
    if (!slot.silentReopened) {
      slot.silentReopened = true;
      slot.recovery = { from: device, cause: "no-signal" };
      this.setCaptureHealth(slot, { state: "recovering", device, cause: "no-signal" });
      void this.enqueue(async () => {
        if (!slot.desired || this.destroyed) return;
        try {
          await this.acquire([slot]);
        } catch {
          // Already reported as a DeviceError.
        }
      });
      return;
    }
    if (slot.health.state === "failed") return;
    const problem: Problem = { code: "no-signal" };
    this.setCaptureHealth(slot, {
      state: "failed",
      device,
      problem,
      fixes: fixesFor(problem, slot.kind === "audio" ? "mic" : "cam"),
    });
  }

  private goLive(slot: Slot): void {
    if (slot.recovery && slot.health.state === "recovering") {
      slot.recovered = slot.recovery;
      slot.recovery = null;
    }
    const health: CaptureHealth = {
      state: "live",
      device: this.deviceOf(slot),
      signal: {
        local: slot.local,
        server: this.serverOf(slot),
      },
    };
    if (slot.recovered) health.recovered = slot.recovered;
    this.setCaptureHealth(slot, health);
  }

  /**
   * The camera's rules. The page does not look at its own picture: the voice runtime
   * decodes what reaches it and says (`caller-video`), and until it has, the
   * camera is live and unmeasured.
   *
   * - Black from the start is a failure: a closed shutter, a covered lens, a
   *   virtual camera whose app is not running (its fixes say so). Black after
   *   a picture is degraded. A camera another app holds never gets here: it
   *   fails to open (`already-in-use`).
   * - No frames reaching the voice runtime is degraded, but only while the voice runtime still receives
   *   the mic and the uplink grades better than poor: a congested uplink drops
   *   video before audio, and with neither the network dropped. The connection
   *   says so in both cases.
   */
  private evaluateCam(): void {
    const slot = this.slots.video;
    const capture = slot.capture;
    if (!isLive(capture) || !capture.enabled || !slot.desired || slot.acquiring) return;
    const server = this.camServer;
    if (server === "sound") slot.heard = true;
    const problem: Problem = { code: "no-signal" };
    if (server === "silent" && !slot.heard) {
      if (slot.health.state !== "failed") {
        this.setCaptureHealth(slot, {
          state: "failed",
          device: this.deviceOf(slot),
          problem,
          fixes: fixesFor(problem, "cam", this.deviceOf(slot).traits),
        });
      }
      return;
    }
    if (server === "silent") {
      this.setCaptureHealth(slot, {
        state: "degraded",
        device: this.deviceOf(slot),
        signal: { local: slot.local, server },
        problem,
        fixes: fixesFor(problem, "cam", this.deviceOf(slot).traits),
      });
      return;
    }
    if (server === "none" && this.serverSignal !== "none" && !this.uplinkStarved()) {
      // The picture is not black, it is missing: a shutter has nothing to do
      // with it. A camera that stopped sending frames is the likely cause.
      this.setCaptureHealth(slot, {
        state: "degraded",
        device: this.deviceOf(slot),
        signal: { local: slot.local, server },
        problem,
        fixes: ["choose-another-device"],
      });
      return;
    }
    this.goLive(slot);
  }

  /**
   * The first time the mic opens on the system default, a default that is a
   * loopback (Stereo Mix, a virtual cable) captures the speakers, not the
   * person: move to the communications device, or the first real mic, once.
   * An explicit choice is never second-guessed.
   */
  private async avoidLoopbackOnFirstOpen(slot: Slot): Promise<void> {
    if (slot.loopbackChecked) return;
    slot.loopbackChecked = true;
    if (slot.deviceId !== "default" || !isLive(slot.capture)) return;
    if (!this.deviceOf(slot).traits.includes("loopback")) return;
    const inputs = await this.devicesOfKind("audioinput").catch(() => [] as MediaDeviceInfo[]);
    const real = inputs.filter(
      (d) => d.deviceId && d.deviceId !== "default" && !traitsOf(d.label).includes("loopback"),
    );
    const communications = inputs.find(
      (d) => d.deviceId === "communications" && !traitsOf(d.label).includes("loopback"),
    );
    const pick = communications ?? real.find((d) => d.deviceId !== "communications");
    if (!pick || this.destroyed || !slot.desired) return;
    slot.deviceId = pick.deviceId;
    try {
      await this.acquire([slot]);
    } catch {
      // Already reported as a DeviceError.
    }
  }

  private refreshSpeaker(): void {
    const info = this.selectedSpeakerInfo;
    const device = "deviceId" in info ? describeDevice(info.deviceId, info.label) : null;
    let health: SpeakerHealth;
    if (this.blockedElements.size > 0) {
      health = { state: "blocked" };
    } else if (this.outputElements.size === 0) {
      health = { state: "idle", device };
    } else if (Date.now() < this.speakerStalledUntil) {
      health = { state: "recovering", device, cause: "stalled" };
    } else {
      health = { state: "playing", device, signal: "unmeasured" };
      if (this.speakerRecovered) health.recovered = this.speakerRecovered;
    }
    this.healthStore.update({ speaker: health });
  }

  /** The playout guard just restarted a stalled element: show it briefly. */
  private speakerStalled(): void {
    this.speakerStalledUntil = Date.now() + this.timings.speakerRecoveringMs;
    this.refreshSpeaker();
    if (this.speakerTimer) clearTimeout(this.speakerTimer);
    this.speakerTimer = setTimeout(() => {
      this.speakerTimer = null;
      this.refreshSpeaker();
    }, this.timings.speakerRecoveringMs + 1);
  }

  /**
   * Point the level meter at the microphone it should measure: the capture
   * track while it is live and enabled, otherwise nothing. Called after every
   * change to the audio slot, so a device switch moves the meter onto the new
   * track and a mute stops it.
   *
   * A disabled microphone is not measured at all, which is Daily's behaviour
   * too — its observer stops when the track is disabled and emits no final
   * zero. It is also the only honest one: the meter's branch is a clone, which
   * `enabled = false` on the capture track does not silence, and a user who
   * muted must not be listened to by anything.
   */
  private syncLevelMeter(slot: Slot): void {
    if (slot !== this.slots.audio) return;
    const capture = slot.capture;
    this.levelMeter.measure(!this.destroyed && isLive(capture) && capture.enabled ? capture : null);
  }

  private async selectInput(slot: Slot, deviceId: string): Promise<void> {
    const previous = slot.deviceId;
    slot.deviceId = deviceId;
    slot.loopbackChecked = true;
    try {
      if (slot.desired || isLive(slot.capture)) {
        await this.acquire([slot]);
      } else {
        await this.refreshSelectedDevices([slot]);
      }
    } catch (error) {
      // A failed switch keeps the device we were already on, and the live
      // track we already had. Losing the mic because a picker offered a stale
      // id is the failure mode this exists to prevent.
      slot.deviceId = previous;
      throw error;
    }
  }

  // --------------------------------------------------------------- recovery

  private attachLifecycle(slot: Slot, track: TrackLike): void {
    slot.detach?.();

    const onEnded = () => this.handleEnded(slot, track);
    const onMute = () => {
      if (slot.capture !== track) return;
      this.scheduleMutedRecovery(slot, track);
      if (
        slot.recoverable &&
        slot.desired &&
        this.visibility &&
        this.visibility.visibilityState !== "visible"
      ) {
        // A phone took the device (a call, Siri, another app). Nothing to do
        // until the page is back in front; say so rather than "silent".
        const device = this.deviceOf(slot);
        slot.recovery = { from: device, cause: "interrupted" };
        this.setCaptureHealth(slot, { state: "recovering", device, cause: "interrupted" });
      }
    };
    const onUnmute = () => {
      if (slot.capture !== track) return;
      this.clearMutedTimer(slot);
      const health = slot.health;
      if (health.state === "failed" && health.problem.code === "interrupted") {
        // Whatever held the device let it go: the same capture is back.
        const device = this.deviceOf(slot);
        slot.interruptions = 0;
        slot.recovery = { from: device, cause: "interrupted" };
        this.setCaptureHealth(slot, { state: "recovering", device, cause: "interrupted" });
        this.settleCaptureHealth(slot, false);
        return;
      }
      if (health.state === "recovering" && health.cause === "interrupted") {
        this.settleCaptureHealth(slot, false);
      }
    };

    track.addEventListener("ended", onEnded);
    track.addEventListener("mute", onMute);
    track.addEventListener("unmute", onUnmute);
    slot.detach = () => {
      track.removeEventListener("ended", onEnded);
      track.removeEventListener("mute", onMute);
      track.removeEventListener("unmute", onUnmute);
    };
  }

  /**
   * An `ended` we did not cause. A stop we initiated is a silent local
   * transition on every engine (proven in tier 2, and mirrored by the fake),
   * so anything that reaches here with the track still installed is the device
   * going away underneath us.
   */
  private handleEnded(slot: Slot, track: TrackLike): void {
    if (slot.intentionalStops.has(track) || slot.capture !== track) return;
    void this.enqueue(async () => {
      if (slot.capture !== track) return;
      const published = slot.published;
      slot.capture = null;
      slot.published = null;
      this.clearMutedTimer(slot);
      this.syncPublishWatchdog();
      this.syncLevelMeter(slot);
      slot.detach?.();
      slot.detach = null;
      await this.localTrackChangedHandler?.({
        type: slot.key,
        track: null,
        previousTrack: published,
      });
      if (published) {
        this.announceStopped(slot, published);
        safeStop(published);
      }
      if (!slot.recoverable) {
        // The user pressed the browser's own "Stop sharing". There is nothing
        // to recover — a re-acquire here would put a picker on screen nobody
        // asked for. Stop wanting it, and say so: `ended: "user"`.
        slot.desired = false;
        this.setScreenHealth({ state: "off", ended: "user" });
        return;
      }
      if (!slot.desired || !this.initialized || this.destroyed) {
        this.setCaptureHealth(slot, { state: "off" });
        return;
      }
      if ((await this.readPermission(slot.kind)) === "denied") {
        // The permission was taken back mid-call; asking again cannot work.
        const problem: Problem = { code: "blocked", by: "user" };
        this.setCaptureHealth(slot, {
          state: "failed",
          device: this.deviceOf(slot),
          problem,
          fixes: fixesFor(problem, slot.kind === "audio" ? "mic" : "cam"),
        });
        return;
      }
      const lost = this.deviceOf(slot, track);
      slot.recovery = { from: lost, cause: "device-lost" };
      this.setCaptureHealth(slot, { state: "recovering", device: lost, cause: "device-lost" });

      if (this.fallbackToDefaultDevice && slot.deviceId !== "default") {
        const devices = await this.devicesOfKind(slot.deviceKind).catch(() => []);
        if (!isPlaceholderList(devices) && !devices.some((d) => d.deviceId === slot.deviceId)) {
          slot.deviceId = "default";
        }
      }
      try {
        await this.acquire([slot]);
      } catch {
        // Already reported as a DeviceError.
      }
    });
  }

  private scheduleMutedRecovery(slot: Slot, track: TrackLike, delay = this.mutedRecoveryMs): void {
    this.clearMutedTimer(slot);
    // A screen capture has no re-acquire path: `getDisplayMedia` would prompt.
    if (!slot.desired || !slot.recoverable) return;
    slot.mutedTimer = setTimeout(
      () => {
        slot.mutedTimer = null;
        void this.enqueue(async () => {
          if (slot.capture !== track || !track.muted || track.readyState !== "live") return;
          if (!slot.desired || this.destroyed) return;
          // The gate: a backgrounded tab mutes capture on purpose on some
          // engines. Re-acquiring there fights the browser and can pop a
          // permission prompt the user cannot see. The visibilitychange handler
          // re-schedules this the moment the tab comes back.
          if (this.visibility && this.visibility.visibilityState !== "visible") return;
          const now = Date.now();
          if (now - slot.interruptedAt >= this.timings.interruptionRunMs) slot.interruptions = 0;
          slot.interruptedAt = now;
          slot.interruptions += 1;
          const device = this.deviceOf(slot);
          if (slot.interruptions > this.timings.interruptedReopens) {
            // Reopening keeps handing back a muted device: something else holds
            // it. Stop churning and ask the person.
            const problem: Problem = { code: "interrupted" };
            this.setCaptureHealth(slot, {
              state: "failed",
              device,
              problem,
              fixes: fixesFor(problem, slot.kind === "audio" ? "mic" : "cam"),
            });
            return;
          }
          slot.recovery = { from: device, cause: "interrupted" };
          this.setCaptureHealth(slot, { state: "recovering", device, cause: "interrupted" });
          try {
            await this.acquire([slot]);
          } catch {
            // Already reported as a DeviceError.
          }
        });
      },
      Math.max(0, delay),
    );
  }

  private clearMutedTimer(slot: Slot): void {
    if (slot.mutedTimer) clearTimeout(slot.mutedTimer);
    slot.mutedTimer = null;
  }

  private stopIntentionally(slot: Slot, track: TrackLike): void {
    slot.intentionalStops.add(track);
    safeStop(track);
  }

  // ---------------------------------------------------------- device change

  /**
   * Decision 5: coalesce. Chrome fires `devicechange` before
   * `enumerateDevices()` settles, and an undebounced handler reads a
   * transiently short list, decides the selected mic is gone, and drops it
   * mid-call.
   */
  private scheduleDeviceChange(): void {
    if (this.deviceChangeTimer) clearTimeout(this.deviceChangeTimer);
    this.deviceChangeTimer = setTimeout(() => {
      this.deviceChangeTimer = null;
      void this.enqueue(() => this.handleDeviceChange());
    }, this.deviceChangeDebounceMs);
  }

  private async handleDeviceChange(): Promise<void> {
    if (this.destroyed) return;
    const devices = await this.mediaDevices.enumerateDevices().catch(() => [] as MediaDeviceInfo[]);
    this.emitDeviceLists(devices);

    for (const slot of Object.values(this.slots)) {
      const candidates = devices.filter((d) => d.kind === slot.deviceKind);
      const found = resolveDevice(candidates, slot.deviceId);
      const vanished = slot.deviceId !== "default" && !found && !isPlaceholderList(candidates);

      if (vanished && this.fallbackToDefaultDevice) {
        // Stop asking for a device that is not there. Re-acquiring only makes
        // sense if something is left to acquire — on an engine that enumerates
        // exactly one mic, unplugging it leaves an empty list, and a
        // getUserMedia issued into that is a guaranteed failure that would
        // report a device error the user can do nothing about.
        slot.deviceId = "default";
        if (slot.desired && candidates.length > 0 && !this.destroyed) {
          if (isLive(slot.capture)) {
            const lost = this.deviceOf(slot);
            slot.recovery = { from: lost, cause: "device-lost" };
            this.setCaptureHealth(slot, {
              state: "recovering",
              device: lost,
              cause: "device-lost",
            });
          }
          try {
            await this.acquire([slot]);
          } catch {
            // Already reported as a DeviceError.
          }
        } else {
          this.setSelectedInfo(slot, resolveDevice(candidates, "default"));
        }
      } else {
        this.setSelectedInfo(slot, this.resolveFor(slot, candidates));
      }
    }

    await this.reconcileSpeaker(devices.filter((d) => d.kind === "audiooutput"));
  }

  /**
   * The output side of a `devicechange`, and the mirror of what the loop above
   * does for the two input slots.
   *
   * This used to only refresh the *default* — `if (selectedSpeakerId ===
   * "default")` — which meant an explicitly chosen speaker that was unplugged
   * was never noticed: the bound elements kept a `sinkId` naming a device that
   * no longer existed, `selectedSpeaker` went on reporting it, and no callback
   * fired. Measured 2026-09-07 on the fake platform, then fixed here.
   *
   * `isPlaceholderList` matters as much as it does for inputs: before a
   * permission grant every engine returns entries with empty ids, and reading
   * that as "your headset is gone" would re-route a working call.
   */
  private async reconcileSpeaker(candidates: readonly MediaDeviceInfo[]): Promise<void> {
    const found = resolveDevice(candidates, this.selectedSpeakerId);
    const vanished =
      this.selectedSpeakerId !== "default" && !found && !isPlaceholderList(candidates);

    if (vanished && this.fallbackToDefaultDevice) {
      const from = "deviceId" in this.selectedSpeakerInfo ? this.selectedSpeakerInfo : null;
      this.speakerRecovered = {
        from: from ? describeDevice(from.deviceId, from.label) : null,
        cause: "device-lost",
      };
      this.selectedSpeakerId = "default";
      try {
        await this.applySinkToAll("default");
      } catch {
        // Already reported as a DeviceError by applySinkToAll.
      }
      this.announceSpeaker(
        resolveDevice(candidates, "default") ?? syntheticDevice("audiooutput", "default"),
      );
      return;
    }
    if (found) this.announceSpeaker(found);
  }

  private announceSpeaker(device: MediaDeviceInfo): void {
    if (sameDevice(this.selectedSpeakerInfo, device)) {
      this.refreshSpeaker();
      return;
    }
    this.selectedSpeakerInfo = device;
    this.refreshSpeaker();
    this.callbacks.onSpeakerUpdated?.(device);
  }

  private async publishDeviceLists(): Promise<void> {
    const devices = await this.mediaDevices.enumerateDevices().catch(() => [] as MediaDeviceInfo[]);
    this.emitDeviceLists(devices);
    for (const slot of Object.values(this.slots)) {
      this.setSelectedInfo(
        slot,
        this.resolveFor(
          slot,
          devices.filter((d) => d.kind === slot.deviceKind),
        ),
      );
    }
    const speaker = resolveDevice(
      devices.filter((d) => d.kind === "audiooutput"),
      this.selectedSpeakerId,
    );
    if (speaker) this.selectedSpeakerInfo = speaker;
  }

  private emitDeviceLists(devices: readonly MediaDeviceInfo[]): void {
    this.callbacks.onAvailableMicsUpdated?.(devices.filter((d) => d.kind === "audioinput"));
    this.callbacks.onAvailableCamsUpdated?.(devices.filter((d) => d.kind === "videoinput"));
    this.callbacks.onAvailableSpeakersUpdated?.(devices.filter((d) => d.kind === "audiooutput"));
  }

  private async refreshSelectedDevices(slots: Slot[]): Promise<void> {
    const devices = await this.mediaDevices.enumerateDevices().catch(() => [] as MediaDeviceInfo[]);
    for (const slot of slots) {
      this.setSelectedInfo(
        slot,
        this.resolveFor(
          slot,
          devices.filter((d) => d.kind === slot.deviceKind),
        ),
      );
    }
  }

  /**
   * What the manager believes is selected. The live track's own
   * `getSettings().deviceId` wins when it resolves — it is the browser's
   * answer, not ours — then the requested id, then a synthetic record so a
   * caller reading `selectedMic` after a successful switch is never handed
   * `{}`. Labels are never used to identify a device: they are empty before a
   * permission grant on every engine.
   */
  private resolveFor(slot: Slot, candidates: MediaDeviceInfo[]): MediaDeviceInfo | undefined {
    const settingsId = slot.capture ? slot.capture.getSettings().deviceId : undefined;
    const resolved =
      (settingsId ? resolveDevice(candidates, settingsId) : undefined) ??
      resolveDevice(candidates, slot.deviceId);
    if (resolved) return resolved;
    const id = settingsId || slot.deviceId;
    if (!slot.capture && slot.deviceId === "default") return undefined;
    return syntheticDevice(slot.deviceKind, id);
  }

  private setSelectedInfo(slot: Slot, device: MediaDeviceInfo | undefined): void {
    if (!device) return;
    // Keyed on `key`, not `kind`: the screen slot's `kind` is also "video" and
    // it names no device at all. It never reaches here — every caller iterates
    // `this.slots` — and this guard is what keeps that true if one ever does.
    if (slot.key === "screenVideo") return;
    const isMic = slot.key === "audio";
    const current = isMic ? this.selectedMicInfo : this.selectedCamInfo;
    const changed = !sameDevice(current, device);
    if (isMic) this.selectedMicInfo = device;
    else this.selectedCamInfo = device;
    if (!changed) return;
    if (isMic) this.callbacks.onMicUpdated?.(device);
    else this.callbacks.onCamUpdated?.(device);
  }

  private async devicesOfKind(kind: MediaDeviceKind): Promise<MediaDeviceInfo[]> {
    const devices = await this.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === kind);
  }

  // ---------------------------------------------------------------- speaker

  private async applySinkToAll(sinkId: string): Promise<void> {
    const elements = [...this.outputElements];
    const results = await Promise.allSettled(
      elements.map((element) => this.applySink(element, sinkId)),
    );
    // Re-assert playback after a route change. Every engine measured keeps
    // playing across `setSinkId`, but the cost of asking is one resolved
    // promise and the cost of being wrong is a silent call.
    await Promise.all(elements.map((element) => this.ensurePlaying(element)));
    const failure = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failure) throw this.reportError(failure.reason, ["speaker"]);
  }

  private async applySink(element: OutputElementLike, sinkId: string): Promise<void> {
    // Absent `setSinkId` is a browser fact, not an error: the selection is
    // still recorded, playback just stays on the system default.
    if (typeof element.setSinkId !== "function") return;
    // `"default"` is doing two jobs, and which one it is depends on the
    // engine. On Chromium it is a real enumerated device — the "follow the
    // system default" pseudo-device — and passing it through is right. On
    // Firefox it is not a device id at all: that engine names its outputs with
    // opaque hashed ids and exposes none whatsoever until a microphone has
    // been granted, so nothing is ever called `default` and
    // `setSinkId("default")` rejects with NotFoundError. Because
    // `bindOutputElement` is fire-and-forget, that rejection surfaced as an
    // uncaught error in the host page.
    //
    // So try the id as given, and fall back to the spec's own value for
    // "route to the user-agent default" — the empty string, which all three
    // engines accept. The fallback is only ever taken for our own sentinel: a
    // device the caller actually named must still fail loudly, or
    // `updateSpeaker` would silently ignore a bad selection.
    try {
      await element.setSinkId(sinkId);
    } catch (error) {
      if (sinkId !== "default") throw error;
      await element.setSinkId("");
    }
  }

  // ----------------------------------------------------------------- errors

  private reportError(error: unknown, devices: DeviceArray): DeviceError {
    const normalized = normalizeDeviceError(error, devices);
    this.callbacks.onDeviceError?.(normalized);
    return normalized;
  }

  /**
   * A screen-share failure is reported on *both* lanes, deliberately.
   * `onScreenShareError` is the callback pipecat gives a screen share, and it
   * takes a string; `onDeviceError` is where a typed `DeviceErrorType` lives,
   * and an app that maps `permissions` to "you dismissed the prompt" should get
   * the same answer whether the user denied a camera or a display.
   * `devices: ["cam"]` is the closest true thing pipecat's `DeviceArray` can
   * say about a display — it has no member for one.
   */
  private reportScreenError(error: unknown): DeviceError {
    const normalized = normalizeDeviceError(error, ["cam"]);
    this.callbacks.onScreenShareError?.(normalized.message);
    this.callbacks.onDeviceError?.(normalized);
    return normalized;
  }

  /**
   * Screen tracks are announced on the screen callbacks, device tracks on the
   * track callbacks. An app listening to `onTrackStarted` to show a camera
   * preview must not be handed a display capture to render as the user's face.
   */
  private announceStarted(slot: Slot, track: TrackLike): void {
    if (slot.key === "screenVideo") {
      this.callbacks.onScreenTrackStarted?.(asTrack(track), LOCAL_PARTICIPANT);
    } else {
      this.callbacks.onTrackStarted?.(asTrack(track), LOCAL_PARTICIPANT);
    }
  }

  private announceStopped(slot: Slot, track: TrackLike): void {
    if (slot.key === "screenVideo") {
      this.callbacks.onScreenTrackStopped?.(asTrack(track), LOCAL_PARTICIPANT);
    } else {
      this.callbacks.onTrackStopped?.(asTrack(track), LOCAL_PARTICIPANT);
    }
  }
}

function asReading(state: string): PermissionReading {
  return state === "granted" || state === "denied" || state === "prompt" ? state : "unknown";
}

function isDenial(error: unknown): boolean {
  const name = rawError(error).name;
  return name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError";
}

function displayMediaOptions(hints?: ScreenPickerHints): DisplayMediaStreamOptions {
  const video: MediaTrackConstraints = { ...SCREEN_CONSTRAINTS };
  const options: DisplayMediaStreamOptions & Record<string, unknown> = { video, audio: false };
  if (!hints) return options;
  if (hints.displaySurface) video.displaySurface = hints.displaySurface;
  if (hints.selfBrowserSurface) options.selfBrowserSurface = hints.selfBrowserSurface;
  if (hints.surfaceSwitching) options.surfaceSwitching = hints.surfaceSwitching;
  if (hints.monitorTypeSurfaces) options.monitorTypeSurfaces = hints.monitorTypeSurfaces;
  return options;
}

/** What the manager talks to on a page with no `navigator.mediaDevices`. */
function unsupportedMediaDevices(): MediaDevicesLike {
  const unsupported = () =>
    new TypeError("navigator.mediaDevices is unavailable. Capture needs a secure browser context.");
  return {
    enumerateDevices: () => Promise.resolve([]),
    getUserMedia: () => Promise.reject(unsupported()),
  };
}

function newSlot(
  key: SlotKey,
  kind: InputKind,
  deviceKind: MediaDeviceKind,
  recoverable: boolean,
  desired: boolean,
): Slot {
  return {
    key,
    kind,
    deviceKind,
    contentHint: ENCODING_POLICY[key].contentHint,
    recoverable,
    capture: null,
    published: null,
    deviceId: "default",
    desired,
    mutedTimer: null,
    intentionalStops: new WeakSet(),
    detach: null,
    health: { state: "off" },
    quietSince: null,
    local: "unmeasured",
    heard: false,
    soundRun: null,
    silentReopened: false,
    interruptions: 0,
    interruptedAt: 0,
    loopbackChecked: false,
    recovery: null,
    recovered: null,
    openedAt: 0,
    acquiring: false,
  };
}

function buildTrackConstraints(
  kind: InputKind,
  deviceId: string,
  extra: MediaTrackConstraints,
): MediaTrackConstraints {
  const constraints: MediaTrackConstraints = { ...extra };
  // `default` is a device id on chromium and a request for "whatever the OS
  // picks" everywhere else, so it goes in as an ideal, never as `exact` — an
  // exact match on an id an engine does not mint fails the whole call.
  constraints.deviceId = deviceId && deviceId !== "default" ? { exact: deviceId } : "default";
  if (kind === "audio") {
    constraints.echoCancellation ??= true;
    constraints.noiseSuppression ??= true;
    constraints.autoGainControl ??= true;
  }
  return constraints;
}

/**
 * A list of placeholder entries says nothing about what is plugged in. Before a
 * permission grant every engine returns entries with an empty `deviceId`
 * (WebKit does it for `videoinput` even after an audio grant), and reading that
 * as "your device is gone" drops a working mic. An *empty* list is different —
 * that is a real answer, and it means there is nothing to fall back to.
 */
function isPlaceholderList(devices: readonly MediaDeviceInfo[]): boolean {
  return devices.length > 0 && devices.every((d) => d.deviceId === "");
}

function sameDevice(a: MediaDeviceInfo | Record<string, never>, b: MediaDeviceInfo): boolean {
  return "deviceId" in a && a.deviceId === b.deviceId && a.label === b.label;
}

function safeStop(track: TrackLike): void {
  try {
    track.stop();
  } catch {
    // Best-effort teardown.
  }
}

/** The manager works in `TrackLike`; the pipecat surface is typed in `MediaStreamTrack`. One cast, here. */
function asTrack(track: TrackLike): MediaStreamTrack {
  return track as unknown as MediaStreamTrack;
}

/** DOM exception name → pipecat `DeviceErrorType`. Mined from the prior attempt; the one part of it that was right. */
export function normalizeDeviceError(error: unknown, devices: DeviceArray): DeviceError {
  if (error instanceof DeviceError) return error;
  const source = error instanceof Error ? error : new Error(String(error));
  let type: DeviceErrorType;
  switch (source.name) {
    case "NotAllowedError":
    case "SecurityError":
      type = "permissions";
      break;
    case "NotFoundError":
    case "DevicesNotFoundError":
      type = "not-found";
      break;
    case "NotReadableError":
    case "TrackStartError":
      type = "in-use";
      break;
    case "OverconstrainedError":
    case "ConstraintNotSatisfiedError":
      type = "constraints";
      break;
    case "TypeError":
      type = "undefined-mediadevices";
      break;
    default:
      type = "unknown";
  }
  const details: DeviceErrorDetails = { sourceError: source };
  const constraint = (error as { constraint?: unknown } | null)?.constraint;
  if (typeof constraint === "string") details.constraint = constraint;
  return new DeviceError(devices, type, source.message, details);
}
