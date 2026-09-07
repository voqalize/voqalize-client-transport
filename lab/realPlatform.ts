/**
 * Tier 2's `LabPlatform`: real `navigator.mediaDevices`, wrapped only as
 * thinly as the faults require.
 *
 * The rule this file is written to: **acquisition stays real**. Every
 * `getUserMedia` reaches the engine, every device id and label is the engine's
 * own, `setSinkId` is the engine's own. What the wrapper adds is the three
 * things a real browser will not do on cue, and which SPEC.md's recovery
 * design exists for:
 *
 *   - a device that stops enumerating *and* stops being acquirable (unplug),
 *   - a capture track that goes `muted` and stays there,
 *   - a capture track that ends without us having stopped it.
 *
 * `simulateEnded` really stops the underlying track before dispatching, so
 * `readyState` is honest rather than a lie the manager could be caught out by
 * later. `simulateMute` is the one genuine fiction here — `muted` is
 * read-only and hardware-driven — and it is confined to the wrapper's own
 * getter, which is the narrowest place it can live.
 *
 * Anything the tier cannot do returns `false` and the case declares its tiers.
 */

import {
  describeDisplayCall,
  describeGumCall,
  normalizeKind,
  type RecordedDisplayCall,
  type RecordedGumCall,
} from "./fakeMediaDevices";
import {
  ScriptedVisibility,
  type LabCapabilities,
  type LabPlatform,
  type MutableVisibility,
} from "./labPlatform";
import { probeLoopbackSupport } from "./loopback";
import type {
  MediaDevicesLike,
  OutputElementLike,
  ScriptKind,
  StreamLike,
  TrackLike,
} from "../src/mediaPlatform";

const HINT_SUPPORTED =
  typeof MediaStreamTrack !== "undefined" && "contentHint" in MediaStreamTrack.prototype;

/**
 * Shared per-source state. A clone of a real track shares its source, so a
 * source-level mute reaches every clone — mirroring that here keeps the
 * wrapper from being *more* forgiving than the browser.
 */
class TrackSource {
  mutedOverride: boolean | null = null;
  readonly wrappers = new Set<ScriptableTrack>();
}

class ScriptableTrack implements TrackLike {
  private readonly listeners = new Map<string, Set<() => void>>();
  private localHint = "";

  constructor(
    readonly real: MediaStreamTrack,
    private readonly source: TrackSource,
  ) {
    source.wrappers.add(this);
    for (const type of ["ended", "mute", "unmute"] as const) {
      real.addEventListener(type, () => this.emit(type));
    }
  }

  get kind(): string {
    return this.real.kind;
  }
  get id(): string {
    return this.real.id;
  }
  get label(): string {
    return this.real.label;
  }
  get enabled(): boolean {
    return this.real.enabled;
  }
  set enabled(value: boolean) {
    this.real.enabled = value;
  }
  get contentHint(): string {
    return HINT_SUPPORTED ? (this.real.contentHint ?? "") : this.localHint;
  }
  set contentHint(value: string) {
    if (HINT_SUPPORTED) this.real.contentHint = value;
    else this.localHint = value;
  }
  get readyState(): MediaStreamTrackState {
    return this.real.readyState;
  }
  get muted(): boolean {
    return this.source.mutedOverride ?? this.real.muted;
  }

  stop(): void {
    this.real.stop();
    // Mirrors the fake: a stopped track leaves its source, so a later
    // device-ended does not try to end it a second time.
    this.source.wrappers.delete(this);
  }

  clone(): TrackLike {
    return new ScriptableTrack(this.real.clone(), this.source);
  }

  getSettings(): MediaTrackSettings {
    return this.real.getSettings();
  }

  addEventListener(type: string, listener: () => void, options?: { once?: boolean }): void {
    const wrapped = options?.once
      ? () => {
          this.removeEventListener(type, wrapped);
          listener();
        }
      : listener;
    // `once` has to survive removal by the *original* function reference, which
    // is what the manager holds. Store both directions.
    if (wrapped !== listener) onceMap.set(listener, wrapped);
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(wrapped);
  }

  removeEventListener(type: string, listener: () => void): void {
    const set = this.listeners.get(type);
    if (!set) return;
    set.delete(listener);
    const wrapped = onceMap.get(listener);
    if (wrapped) set.delete(wrapped);
  }

  private emit(type: string): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener();
  }

  /**
   * Really end every track over this source, then tell listeners — the
   * device-unplugged case. Ending the whole source (not just this wrapper) is
   * what a browser does and what the tier-1 fake models, so the published
   * clone dies with the capture track here too.
   */
  simulateEnded(): void {
    for (const wrapper of [...this.source.wrappers]) {
      if (wrapper.real.readyState === "ended") continue;
      wrapper.real.stop();
      wrapper.emit("ended");
    }
  }

  simulateMute(): void {
    this.source.mutedOverride = true;
    for (const wrapper of this.source.wrappers) wrapper.emit("mute");
  }

  simulateUnmute(): void {
    this.source.mutedOverride = false;
    for (const wrapper of this.source.wrappers) wrapper.emit("unmute");
  }
}

const onceMap = new WeakMap<() => void, () => void>();

class ScriptableStream implements StreamLike {
  constructor(private readonly all: ScriptableTrack[]) {}
  getTracks(): TrackLike[] {
    return [...this.all];
  }
  getAudioTracks(): TrackLike[] {
    return this.all.filter((t) => t.kind === "audio");
  }
  getVideoTracks(): TrackLike[] {
    return this.all.filter((t) => t.kind === "video");
  }
}

class ScriptableMediaDevices extends EventTarget implements MediaDevicesLike {
  private readonly hidden = new Set<string>();
  private pendingRejection: DOMException | null = null;
  private pendingDisplayRejection: DOMException | null = null;

  readonly gumCalls: RecordedGumCall[] = [];
  readonly displayCalls: RecordedDisplayCall[] = [];
  enumerateCount = 0;
  readonly issued: ScriptableTrack[] = [];
  readonly issuedDisplay: ScriptableTrack[] = [];

  constructor(private readonly real: MediaDevices) {
    super();
    real.addEventListener("devicechange", () => this.dispatchEvent(new Event("devicechange")));
  }

  async enumerateDevices(): Promise<MediaDeviceInfo[]> {
    this.enumerateCount++;
    const devices = await this.real.enumerateDevices();
    return devices.filter((device) => !this.hidden.has(device.deviceId));
  }

  async getUserMedia(constraints: MediaStreamConstraints): Promise<StreamLike> {
    this.gumCalls.push(describeGumCall(constraints));

    if (this.pendingRejection) {
      const error = this.pendingRejection;
      this.pendingRejection = null;
      throw error;
    }

    // A hidden device must fail acquisition the way a real unplug does, with
    // the same DOMException names every engine uses (measured in tier 1's
    // fake and asserted identically in both tiers).
    for (const want of [normalizeKind(constraints.audio), normalizeKind(constraints.video)]) {
      if (want?.deviceId && this.hidden.has(want.deviceId)) {
        throw new DOMException(
          `Requested device not found: ${want.deviceId}`,
          want.exact ? "OverconstrainedError" : "NotFoundError",
        );
      }
    }

    const stream = await this.real.getUserMedia(constraints);
    const wrapped = stream
      .getTracks()
      .map((track) => new ScriptableTrack(track, new TrackSource()));
    this.issued.push(...wrapped);
    return new ScriptableStream(wrapped);
  }

  /**
   * Real screen capture, wrapped exactly as thinly as `getUserMedia` is. The
   * one fault injected here is a rejection, because a real picker cannot be
   * cancelled from a test — no engine exposes the chooser to automation, and
   * chromium/firefox/webkit all auto-accept under this harness's flags. The
   * *acceptance* path is fully real on all three.
   */
  async getDisplayMedia(constraints?: DisplayMediaStreamOptions): Promise<StreamLike> {
    this.displayCalls.push(describeDisplayCall(constraints));

    if (this.pendingDisplayRejection) {
      const error = this.pendingDisplayRejection;
      this.pendingDisplayRejection = null;
      throw error;
    }

    const stream = await this.real.getDisplayMedia(constraints);
    const wrapped = stream
      .getTracks()
      .map((track) => new ScriptableTrack(track, new TrackSource()));
    this.issuedDisplay.push(...wrapped);
    return new ScriptableStream(wrapped);
  }

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

  failNextGetUserMedia(name: string, message: string): void {
    this.pendingRejection = new DOMException(message, name);
  }

  failNextGetDisplayMedia(name: string, message: string): void {
    this.pendingDisplayRejection = new DOMException(message, name);
  }

  liveIssued(kind: ScriptKind): ScriptableTrack | null {
    const pool = kind === "screen" ? this.issuedDisplay : this.issued;
    const wanted = kind === "audio" ? "audio" : "video";
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

  stopAll(): void {
    // A leaked screen capture is worse than a leaked mic: on chromium it keeps
    // a desktop-capture session alive for the rest of the worker's life.
    for (const track of [...this.issued, ...this.issuedDisplay]) {
      try {
        track.stop();
      } catch {
        /* already gone */
      }
    }
    this.issued.length = 0;
    this.issuedDisplay.length = 0;
  }
}

/** Measured once per page, not once per case: the probe below opens a real mic. */
let measuredCapabilities: LabCapabilities | null = null;

/**
 * A real `HTMLAudioElement` for routing, with a scripted `play()`.
 *
 * `sinkId` and `setSinkId` go straight through to the element, so every
 * routing assertion in tier 2 is measuring the real engine — that half is not
 * a fiction. `play()` is, and it has to be: no browser exposes a switch that
 * makes its autoplay policy refuse on demand, and chromium here is launched
 * with `--autoplay-policy=no-user-gesture-required` precisely so the *other*
 * tests can play media. What tier 2 therefore proves is that the manager's
 * classification and state machine behave identically in all three engines
 * against a real `DOMException` — not that the engines block when we say they
 * do. That second claim is not one an automated suite can make; it belongs to
 * the manual lab page, on a real iOS device.
 *
 * The fiction is confined to this class, in the same way `simulateMute`'s is.
 */
class ScriptedOutputElement implements OutputElementLike {
  playAttempts = 0;
  /**
   * Assigned in the constructor and only when the engine has it. Declaring it
   * unconditionally would be a lie the manager reads: it decides an engine
   * cannot route by `typeof element.setSinkId !== "function"`, and a wrapper
   * that always answers "function" would turn "this browser has no
   * setSinkId" — a fact — into a rejected promise, which is an error.
   */
  setSinkId?: (sinkId: string) => Promise<void>;

  constructor(
    private readonly element: HTMLAudioElement,
    private readonly blocked: () => boolean,
  ) {
    const real = element as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
    if (typeof real.setSinkId === "function") {
      this.setSinkId = (sinkId: string) => real.setSinkId!(sinkId);
    }
  }

  get sinkId(): string {
    return (this.element as HTMLAudioElement & { sinkId?: string }).sinkId ?? "";
  }

  get paused(): boolean {
    return this.element.paused;
  }

  async play(): Promise<void> {
    this.playAttempts += 1;
    if (this.blocked()) {
      throw new DOMException(
        "play() failed because the user didn't interact first",
        "NotAllowedError",
      );
    }
    // A source-less element resolves on some engines and rejects with
    // NotSupportedError on others, and neither answer is about autoplay. The
    // element is real; the *decision* is the harness's.
  }
}

export class RealLabPlatform implements LabPlatform {
  private readonly devices: ScriptableMediaDevices;
  readonly visibility: MutableVisibility = new ScriptedVisibility();
  private readonly elements: HTMLAudioElement[] = [];
  private readonly outputs: ScriptedOutputElement[] = [];
  private autoplayBlocked = false;

  constructor(real: MediaDevices = navigator.mediaDevices) {
    this.devices = new ScriptableMediaDevices(real);
  }

  get mediaDevices(): MediaDevicesLike {
    return this.devices;
  }

  /**
   * Measured, once, against the *real* device object so it never shows up in
   * the counters a body asserts on. The throwaway `getUserMedia` is not
   * optional: every engine returns placeholder `enumerateDevices` entries
   * (empty deviceId, empty label) until a capture permission has been granted,
   * so counting mics before the grant would under-report on all three.
   */
  async capabilities(): Promise<LabCapabilities> {
    if (measuredCapabilities) return measuredCapabilities;
    try {
      // Audio AND video, in one call: WebKit enumerates its `videoinput`
      // entries with an empty deviceId until a *camera* permission has been
      // exercised, so an audio-only probe would report `multipleCams: false`
      // there and skip camera switching on an engine that supports it. One
      // call rather than two, for the same reason decision 3 exists.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      for (const track of stream.getTracks()) track.stop();
    } catch {
      /* the capability probe is best-effort; the counts below just get worse */
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    measuredCapabilities = {
      contentHint: HINT_SUPPORTED,
      setSinkId: typeof HTMLMediaElement.prototype.setSinkId === "function",
      multipleMics: devices.filter((d) => d.kind === "audioinput" && d.deviceId !== "").length > 1,
      multipleCams: devices.filter((d) => d.kind === "videoinput" && d.deviceId !== "").length > 1,
      audiooutputEnumerated: devices.some((d) => d.kind === "audiooutput" && d.deviceId !== ""),
      selectableSpeaker: devices.some(
        (d) =>
          d.kind === "audiooutput" &&
          d.deviceId !== "" &&
          d.deviceId !== "default" &&
          d.deviceId !== "communications",
      ),
      screenShare: typeof navigator.mediaDevices.getDisplayMedia === "function",
      // No engine can be made to drop a device mid-`getUserMedia` on cue.
      vanishMidAcquire: false,
      // Measured, not assumed — and measured *here* so it is memoized with the
      // rest rather than re-negotiated once per case.
      loopbackPeerConnection: await probeLoopbackSupport(),
    };
    return measuredCapabilities;
  }

  hideDevice(deviceId: string): void {
    this.devices.hideDevice(deviceId);
  }
  unhideAll(): void {
    this.devices.unhideAll();
  }
  dispatchDeviceChange(): void {
    this.devices.dispatchDeviceChange();
  }
  failNextGetUserMedia(name: string, message: string): void {
    this.devices.failNextGetUserMedia(name, message);
  }
  failNextGetDisplayMedia(name: string, message: string): void {
    this.devices.failNextGetDisplayMedia(name, message);
  }
  vanishDeviceDuringNextAcquire(): boolean {
    return false;
  }

  simulateEnded(kind: ScriptKind): boolean {
    const track = this.devices.liveIssued(kind);
    if (!track) return false;
    track.simulateEnded();
    return true;
  }
  simulateMute(kind: ScriptKind): boolean {
    const track = this.devices.liveIssued(kind);
    if (!track) return false;
    track.simulateMute();
    return true;
  }
  simulateUnmute(kind: ScriptKind): boolean {
    const track = this.devices.liveIssued(kind);
    if (!track) return false;
    track.simulateUnmute();
    return true;
  }

  gumCalls(): RecordedGumCall[] {
    return [...this.devices.gumCalls];
  }
  displayCalls(): RecordedDisplayCall[] {
    return [...this.devices.displayCalls];
  }
  enumerateCount(): number {
    return this.devices.enumerateCount;
  }
  resetCounters(): void {
    this.devices.resetCounters();
  }

  createOutputElement(): OutputElementLike {
    const element = document.createElement("audio");
    this.elements.push(element);
    const scripted = new ScriptedOutputElement(element, () => this.autoplayBlocked);
    this.outputs.push(scripted);
    return scripted;
  }

  blockAutoplay(blocked: boolean): void {
    this.autoplayBlocked = blocked;
  }

  playAttempts(): number[] {
    return this.outputs.map((output) => output.playAttempts);
  }

  dispose(): void {
    this.devices.stopAll();
    for (const element of this.elements) element.remove();
    this.elements.length = 0;
    this.outputs.length = 0;
  }
}
