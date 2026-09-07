/**
 * The tier-1 fake MediaDevices platform.
 *
 * Grown from agent 1's skeleton into something scriptable, because that is
 * what tier 1 is for (SPEC.md § Test taxonomy): "a fake device platform we
 * control lets us provoke states real browsers won't produce on demand — a
 * track that mutes and never unmutes, a device that vanishes mid-acquire."
 *
 * Two rules govern every behaviour here:
 *
 *  1. **It must match what tier 2 measured on real engines.** `stop()` is a
 *     silent transition that fires no `ended`; a clone shares its source, so a
 *     device going away ends the clone too; an unknown `deviceId: {exact}`
 *     fails the whole `getUserMedia`. Where the fake and a real browser
 *     disagree, the fake is wrong.
 *  2. **The scripting surface is the same one the tier-2 platform exposes**
 *     (`LabPlatform` in `labPlatform.ts`), so one contract body drives both.
 */

import type { MediaDevicesLike, ScriptKind, StreamLike, TrackLike } from "../src/mediaPlatform";

export type FakeTrackKind = "audio" | "video";

export interface FakeDeviceDescriptor {
  deviceId: string;
  kind: MediaDeviceKind;
  label: string;
  groupId: string;
}

export function deviceInfo(descriptor: FakeDeviceDescriptor): MediaDeviceInfo {
  const info = { ...descriptor };
  return { ...info, toJSON: () => info } as MediaDeviceInfo;
}

/**
 * The capture source behind one or more tracks. Real browsers hand a `clone()`
 * a second track over the *same* source: `enabled` is per-track, but `muted`
 * and a device-initiated `ended` reach every track the source feeds. Modelling
 * that is what makes "publish a clone, keep the capture track" testable at
 * tier 1 at all.
 */
class FakeTrackSource {
  readonly tracks = new Set<FakeMediaStreamTrack>();
  constructor(
    readonly kind: FakeTrackKind,
    readonly deviceId: string,
    readonly groupId: string,
    readonly label: string,
  ) {}
}

/**
 * Structurally compatible with `MediaStreamTrack` for the subset the manager
 * touches — see `TrackLike`. Not a polyfill of the whole interface.
 */
export class FakeMediaStreamTrack extends EventTarget implements TrackLike {
  readonly kind: FakeTrackKind;
  readonly id: string;
  enabled = true;
  contentHint = "";
  readyState: MediaStreamTrackState = "live";
  muted = false;

  private readonly source: FakeTrackSource;

  /**
   * `(kind, label)` mints a track over a private source — the form the
   * skeleton's own tests use. `(kind, source)` puts a second track on an
   * existing source, which is what `clone()` and acquisition do.
   */
  constructor(kind: FakeTrackKind, labelOrSource: string | FakeTrackSource, id = randomId()) {
    super();
    this.source =
      labelOrSource instanceof FakeTrackSource
        ? labelOrSource
        : new FakeTrackSource(kind, `fake-${kind}`, `group-${kind}`, labelOrSource);
    this.kind = kind;
    this.id = id;
    this.source.tracks.add(this);
  }

  static fromSource(source: FakeTrackSource): FakeMediaStreamTrack {
    return new FakeMediaStreamTrack(source.kind, source);
  }

  get label(): string {
    return this.source.label;
  }

  get deviceId(): string {
    return this.source.deviceId;
  }

  getSettings(): MediaTrackSettings {
    return { deviceId: this.source.deviceId, groupId: this.source.groupId };
  }

  /** A clone is a second track over the same source, exactly as in a browser. */
  clone(): FakeMediaStreamTrack {
    const clone = FakeMediaStreamTrack.fromSource(this.source);
    clone.enabled = this.enabled;
    clone.contentHint = this.contentHint;
    clone.muted = this.muted;
    return clone;
  }

  /**
   * Local stop — what our own code calls to release a device on purpose. Real
   * browsers transition `readyState` to "ended" WITHOUT firing `ended` for a
   * locally-initiated stop (measured on chromium, firefox and webkit in
   * `harness.spec.ts`). That distinction is exactly what lets recovery tell
   * "we stopped this" apart from "the device vanished".
   */
  stop(): void {
    this.readyState = "ended";
    this.source.tracks.delete(this);
  }

  /** Device-initiated end — the counterpart real hardware produces, that stop() must not resemble. */
  simulateDeviceEnded(): void {
    for (const track of [...this.source.tracks]) {
      if (track.readyState === "ended") continue;
      track.readyState = "ended";
      track.dispatchEvent(new Event("ended"));
    }
  }

  simulateMute(): void {
    for (const track of this.source.tracks) {
      if (track.muted) continue;
      track.muted = true;
      track.dispatchEvent(new Event("mute"));
    }
  }

  simulateUnmute(): void {
    for (const track of this.source.tracks) {
      if (!track.muted) continue;
      track.muted = false;
      track.dispatchEvent(new Event("unmute"));
    }
  }
}

export class FakeMediaStream implements StreamLike {
  readonly id = randomId();
  private readonly tracks: FakeMediaStreamTrack[];

  constructor(tracks: FakeMediaStreamTrack[]) {
    this.tracks = tracks;
  }

  getTracks(): FakeMediaStreamTrack[] {
    return [...this.tracks];
  }

  getAudioTracks(): FakeMediaStreamTrack[] {
    return this.tracks.filter((t) => t.kind === "audio");
  }

  getVideoTracks(): FakeMediaStreamTrack[] {
    return this.tracks.filter((t) => t.kind === "video");
  }
}

/** What a `getUserMedia` call asked for, flattened so a test can assert on it across a page boundary. */
export interface RecordedGumCall {
  audio: boolean;
  video: boolean;
  audioDeviceId: string | null;
  audioDeviceIdExact: boolean;
  videoDeviceId: string | null;
  videoDeviceIdExact: boolean;
  echoCancellation: boolean | null;
}

/**
 * What a `getDisplayMedia` call asked for. Separate from `RecordedGumCall`
 * because the two are separate APIs and a case that counts screen-capture
 * prompts must not be confused by camera acquisition — and because SPEC.md
 * decision 9 (`audio: false`) is an assertion about *this* call's shape.
 */
export interface RecordedDisplayCall {
  video: boolean;
  audio: boolean;
  width: number | null;
  height: number | null;
  frameRate: number | null;
}

/**
 * The fake platform. Scriptable: a test registers devices, yanks one
 * mid-acquire, forces `getUserMedia` to reject with a chosen DOMException
 * name, or drives a track's `ended`/`mute` events — all things real browsers
 * under Playwright either cannot be made to do on demand, or would be flaky if
 * they could.
 */
export class FakeMediaDevices extends EventTarget implements MediaDevicesLike {
  // Keyed by kind + id: "default" is legitimately both an audioinput and an
  // audiooutput on chromium, and a map keyed by id alone loses one of them.
  private devices = new Map<string, FakeDeviceDescriptor>();
  private hidden = new Set<string>();
  private pendingRejection: DOMException | null = null;
  private pendingDisplayRejection: DOMException | null = null;
  private vanishOnNextAcquire: string | null = null;

  readonly gumCalls: RecordedGumCall[] = [];
  readonly displayCalls: RecordedDisplayCall[] = [];
  enumerateCount = 0;

  /** Tracks handed out by `getUserMedia`, newest last. Clones are not registered — the manager makes those. */
  readonly issued: FakeMediaStreamTrack[] = [];
  /** Tracks handed out by `getDisplayMedia`, kept apart because they have no device behind them. */
  readonly issuedDisplay: FakeMediaStreamTrack[] = [];

  addDevice(descriptor: FakeDeviceDescriptor): void {
    this.devices.set(`${descriptor.kind}:${descriptor.deviceId}`, descriptor);
    this.dispatchEvent(new Event("devicechange"));
  }

  removeDevice(deviceId: string): void {
    let removed = false;
    for (const [key, device] of [...this.devices]) {
      if (device.deviceId === deviceId) removed = this.devices.delete(key) || removed;
    }
    if (removed) this.dispatchEvent(new Event("devicechange"));
  }

  /** Hide a device from `enumerateDevices` and from acquisition without deleting it — the "unplugged" case. */
  hideDevice(deviceId: string): void {
    this.hidden.add(deviceId);
    this.dispatchEvent(new Event("devicechange"));
  }

  unhideAll(): void {
    this.hidden.clear();
    this.dispatchEvent(new Event("devicechange"));
  }

  dispatchDeviceChange(): void {
    this.dispatchEvent(new Event("devicechange"));
  }

  /** Makes the next `getUserMedia` reject once. */
  rejectNextWith(error: DOMException): void {
    this.pendingRejection = error;
  }

  failNextGetUserMedia(name: string, message: string): void {
    this.rejectNextWith(new DOMException(message, name));
  }

  /** Makes the next `getDisplayMedia` reject once — the user hitting Cancel on the picker. */
  failNextGetDisplayMedia(name: string, message: string): void {
    this.pendingDisplayRejection = new DOMException(message, name);
  }

  /**
   * Tier-1 only: the device disappears *while* `getUserMedia` is in flight, so
   * the call rejects after the manager has already committed to the switch. No
   * real browser can be driven into this on demand, and it is the case that
   * separates "the manager reports and rolls back" from "the manager leaves a
   * half-installed slot".
   */
  vanishDeviceDuringNextAcquire(deviceId: string): void {
    this.vanishOnNextAcquire = deviceId;
  }

  async enumerateDevices(): Promise<MediaDeviceInfo[]> {
    this.enumerateCount++;
    return this.visibleDevices().map(deviceInfo);
  }

  async getUserMedia(constraints: MediaStreamConstraints): Promise<FakeMediaStream> {
    const audio = normalizeKind(constraints.audio);
    const video = normalizeKind(constraints.video);
    this.gumCalls.push(describeGumCall(constraints));

    // Yield once so an in-flight acquire is genuinely asynchronous — the
    // manager's queue is only interesting if operations can interleave.
    await Promise.resolve();

    if (this.vanishOnNextAcquire) {
      const id = this.vanishOnNextAcquire;
      this.vanishOnNextAcquire = null;
      this.hidden.add(id);
      this.dispatchEvent(new Event("devicechange"));
    }

    if (this.pendingRejection) {
      const err = this.pendingRejection;
      this.pendingRejection = null;
      throw err;
    }

    const tracks: FakeMediaStreamTrack[] = [];
    if (audio) tracks.push(this.acquireTrack("audio", audio));
    if (video) tracks.push(this.acquireTrack("video", video));
    if (tracks.length === 0) {
      throw new DOMException("At least one of audio and video must be requested", "TypeError");
    }
    this.issued.push(...tracks);
    return new FakeMediaStream(tracks);
  }

  /**
   * The screen-capture half. Modelled on what all three engines actually do:
   * a single video track over a source with no `deviceId` a caller could ever
   * have asked for, which is why screen capture has no switch, no fallback and
   * no re-acquire. The deliberate microtask yield is what lets a case fire two
   * overlapping `enableScreenShare` calls and have them genuinely overlap.
   */
  async getDisplayMedia(constraints?: DisplayMediaStreamOptions): Promise<FakeMediaStream> {
    this.displayCalls.push(describeDisplayCall(constraints));
    await Promise.resolve();

    if (this.pendingDisplayRejection) {
      const error = this.pendingDisplayRejection;
      this.pendingDisplayRejection = null;
      throw error;
    }

    const track = FakeMediaStreamTrack.fromSource(
      new FakeTrackSource("video", "screen:0", "screen", "Fake Screen"),
    );
    this.issuedDisplay.push(track);
    return new FakeMediaStream([track]);
  }

  /** The newest live track of this kind that we handed out — the manager's capture track. */
  liveIssued(kind: ScriptKind): FakeMediaStreamTrack | null {
    const pool = kind === "screen" ? this.issuedDisplay : this.issued;
    const wanted: FakeTrackKind = kind === "audio" ? "audio" : "video";
    for (let i = pool.length - 1; i >= 0; i--) {
      const track = pool[i];
      if (track && track.kind === wanted && track.readyState === "live") return track;
    }
    return null;
  }

  resetCounters(): void {
    this.gumCalls.length = 0;
    this.displayCalls.length = 0;
    this.enumerateCount = 0;
  }

  private visibleDevices(): FakeDeviceDescriptor[] {
    return [...this.devices.values()].filter((d) => !this.hidden.has(d.deviceId));
  }

  private acquireTrack(
    kind: FakeTrackKind,
    want: { deviceId: string | null; exact: boolean },
  ): FakeMediaStreamTrack {
    const wantedKind = kind === "audio" ? "audioinput" : "videoinput";
    const candidates = this.visibleDevices().filter((d) => d.kind === wantedKind);
    const requested = want.deviceId;

    let device: FakeDeviceDescriptor | undefined;
    if (requested && requested !== "default") {
      device = candidates.find((d) => d.deviceId === requested);
      if (!device) {
        // Matches every engine measured: an unknown `deviceId: {exact}` fails
        // the whole call rather than falling back.
        throw new DOMException(
          `Requested device not found: ${requested}`,
          want.exact ? "OverconstrainedError" : "NotFoundError",
        );
      }
    } else {
      device = candidates.find((d) => d.deviceId === "default") ?? candidates[0];
    }
    if (!device) {
      throw new DOMException(`No ${wantedKind} device available`, "NotFoundError");
    }
    return FakeMediaStreamTrack.fromSource(
      new FakeTrackSource(kind, device.deviceId, device.groupId, device.label),
    );
  }
}

export function normalizeKind(
  value: boolean | MediaTrackConstraints | undefined,
): { deviceId: string | null; exact: boolean } | null {
  if (!value) return null;
  if (value === true) return { deviceId: null, exact: false };
  const raw = value.deviceId;
  if (typeof raw === "string") return { deviceId: raw, exact: false };
  if (Array.isArray(raw)) return { deviceId: raw[0] ?? null, exact: false };
  if (raw && typeof raw === "object") {
    const exact = (raw as ConstrainDOMStringParameters).exact;
    const ideal = (raw as ConstrainDOMStringParameters).ideal;
    const pick = (v: string | string[] | undefined): string | null =>
      typeof v === "string" ? v : Array.isArray(v) ? (v[0] ?? null) : null;
    const exactId = pick(exact);
    if (exactId) return { deviceId: exactId, exact: true };
    return { deviceId: pick(ideal), exact: false };
  }
  return { deviceId: null, exact: false };
}

function randomId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `id-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

/**
 * Reduce a `MediaStreamConstraints` to the flat, cloneable record both tiers
 * assert on. Lives here rather than in the fake platform's class because tier
 * 2's real-`navigator` wrapper records calls in exactly the same shape — a
 * body that reads `gumCalls()` must not be able to tell the tiers apart.
 */
export function describeGumCall(constraints: MediaStreamConstraints): RecordedGumCall {
  const audio = normalizeKind(constraints.audio);
  const video = normalizeKind(constraints.video);
  return {
    audio: !!audio,
    video: !!video,
    audioDeviceId: audio?.deviceId ?? null,
    audioDeviceIdExact: audio?.exact ?? false,
    videoDeviceId: video?.deviceId ?? null,
    videoDeviceIdExact: video?.exact ?? false,
    echoCancellation:
      typeof constraints.audio === "object" && constraints.audio !== null
        ? (((constraints.audio as MediaTrackConstraints).echoCancellation as boolean | undefined) ??
          null)
        : null,
  };
}

/**
 * The same reduction for `getDisplayMedia`. `audio` is recorded because SPEC.md
 * decision 9 is precisely a claim about it: screen *video* only, never screen
 * audio, so a regression that starts capturing tab audio is caught here rather
 * than in a stranger's AEC.
 */
export function describeDisplayCall(constraints?: DisplayMediaStreamOptions): RecordedDisplayCall {
  const video = constraints?.video;
  const spec =
    typeof video === "object" && video !== null ? (video as MediaTrackConstraints) : null;
  return {
    video: video === undefined ? true : !!video,
    audio: !!constraints?.audio,
    width: idealOf(spec?.width),
    height: idealOf(spec?.height),
    frameRate: idealOf(spec?.frameRate),
  };
}

function idealOf(value: ConstrainULong | ConstrainDouble | undefined): number | null {
  if (typeof value === "number") return value;
  if (value && typeof value === "object") {
    const range = value as { ideal?: number; max?: number; exact?: number };
    return range.ideal ?? range.exact ?? range.max ?? null;
  }
  return null;
}
