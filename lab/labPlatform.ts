/**
 * The scripting surface a contract body drives, and its tier-1 implementation.
 *
 * SPEC.md's load-bearing idea is that tier 1 and tier 2 run *the same test
 * bodies*. That only works if a body never names `FakeMediaDevices` or
 * `navigator.mediaDevices` — it names `LabPlatform`, and the two tiers hand it
 * different implementations:
 *
 *   tier 1  FakeLabPlatform      — `FakeMediaDevices`, node, fully scriptable
 *   tier 2  RealLabPlatform      — real `navigator.mediaDevices`, wrapped just
 *                                  thinly enough to inject the faults a real
 *                                  browser will not produce on demand
 *
 * Anything one tier cannot do returns `false` from its control method, and the
 * case that needs it declares the tier it runs in rather than the assertion
 * being watered down (SPEC.md: "a tier-1 pass that fails tier 2 is a bug in
 * our model of the browser").
 */

import {
  FakeMediaDevices,
  deviceInfo,
  type RecordedDisplayCall,
  type RecordedGumCall,
} from "./fakeMediaDevices";
import type {
  MediaDevicesLike,
  OutputElementLike,
  ScriptKind,
  VisibilitySource,
} from "../src/mediaPlatform";

/** What an engine can actually do. Measured, never assumed — cases branch on this and record it. */
export interface LabCapabilities {
  /** `MediaStreamTrack.contentHint` is implemented (assigning to it on an engine that lacks it silently no-ops). */
  contentHint: boolean;
  /** `HTMLMediaElement.setSinkId` exists. */
  setSinkId: boolean;
  /** More than one `audioinput` is enumerated, so a real device switch is testable. */
  multipleMics: boolean;
  /**
   * More than one `videoinput` is enumerated, so a camera switch is testable.
   * Measured 2026-09-07: only webkit has two. Firefox under
   * `media.navigator.streams.fake` and chromium under
   * `--use-fake-device-for-media-stream` each fake exactly one camera — so
   * unlike `multipleMics`, this skips on chromium too.
   */
  multipleCams: boolean;
  /** Any `audiooutput` is enumerated at all. */
  audiooutputEnumerated: boolean;
  /**
   * An `audiooutput` exists that a caller could actually *choose* — a real id
   * that is neither empty nor the `"default"` sentinel. Without one there is
   * no way to put the manager into the "an explicitly selected speaker
   * vanished" state, which is a different state from "the default changed".
   */
  selectableSpeaker: boolean;
  /** `getDisplayMedia` exists and can be driven headlessly without a user gesture. */
  screenShare: boolean;
  /** The platform can make a device disappear *while* `getUserMedia` is in flight. Tier 1 only. */
  vanishMidAcquire: boolean;
  /**
   * A `RTCPeerConnection` in this page can connect to another one in the same
   * page — i.e. the phase-2b loopback is possible at all.
   *
   * Node has none, so tier 1 is always false and every peer-connection case is
   * `tiers: ["browser"]` anyway. It is still *probed* rather than assumed, so a
   * host where a loopback genuinely cannot be built reports a named skip rather
   * than a silently green test — see `probeLoopbackSupport()` in
   * `src/loopback.ts`.
   *
   * It briefly read `false` on Firefox, and the cause was ours, not the
   * engine's: Vite bound the dev server to `[::1]` and Firefox gathers no ICE
   * candidates on an IPv6-loopback origin. `vite.config.ts` pins
   * `host: "127.0.0.1"` and all three engines now probe `true`. Do not
   * re-derive that as a browser limitation.
   */
  loopbackPeerConnection: boolean;
}

export interface MutableVisibility extends VisibilitySource {
  setVisibility(state: DocumentVisibilityState): void;
}

export interface LabPlatform {
  readonly mediaDevices: MediaDevicesLike;
  readonly visibility: MutableVisibility;
  capabilities(): Promise<LabCapabilities>;

  /** Make a device stop enumerating and stop being acquirable — the "unplugged" case. */
  hideDevice(deviceId: string): void;
  unhideAll(): void;
  dispatchDeviceChange(): void;

  failNextGetUserMedia(name: string, message: string): void;
  failNextGetDisplayMedia(name: string, message: string): void;
  /** Returns false where the platform cannot do it (every real browser). */
  vanishDeviceDuringNextAcquire(deviceId: string): boolean;

  /**
   * Drive the lifecycle of the newest live capture track of this kind. Returns
   * false if there is none. `simulateEnded("screen")` is how both tiers model
   * the browser's own "Stop sharing" chrome: the track really ends, and we
   * never called `stop()` on it.
   */
  simulateEnded(kind: ScriptKind): boolean;
  simulateMute(kind: ScriptKind): boolean;
  simulateUnmute(kind: ScriptKind): boolean;

  gumCalls(): RecordedGumCall[];
  displayCalls(): RecordedDisplayCall[];
  enumerateCount(): number;
  resetCounters(): void;

  createOutputElement(): OutputElementLike;
  /**
   * Arm the autoplay policy. Tier 1 refuses from the fake element's own
   * policy; tier 2 scripts a real `DOMException` on a real element, because no
   * engine offers a switch that makes it refuse on demand.
   */
  blockAutoplay(blocked: boolean): void;
  /** `play()` attempts per created element, in creation order. */
  playAttempts(): number[];
  dispose(): void;
}

/** A visibility source a test can drive. Tier 2 wraps the real document; tier 1 has no document at all. */
export class ScriptedVisibility extends EventTarget implements MutableVisibility {
  private state: DocumentVisibilityState = "visible";

  get visibilityState(): DocumentVisibilityState {
    return this.state;
  }

  setVisibility(state: DocumentVisibilityState): void {
    if (this.state === state) return;
    this.state = state;
    this.dispatchEvent(new Event("visibilitychange"));
  }

  override addEventListener(type: "visibilitychange", listener: () => void): void {
    super.addEventListener(type, listener);
  }

  override removeEventListener(type: "visibilitychange", listener: () => void): void {
    super.removeEventListener(type, listener);
  }
}

/**
 * The tier-1 device set. Shaped like chromium's (a `default` alias plus two
 * real mics, two cameras, one speaker) so a body written against it is not
 * secretly written against a device topology no browser has. The second camera
 * is what makes `updateCam` testable at tier 1 at all — of the three real
 * engines only webkit enumerates two (`multipleCams`).
 */
export const FAKE_DEVICES = [
  {
    deviceId: "default",
    kind: "audioinput" as MediaDeviceKind,
    label: "Fake Default Audio Input",
    groupId: "grp-a",
  },
  {
    deviceId: "mic-a",
    kind: "audioinput" as MediaDeviceKind,
    label: "Fake Audio Input 1",
    groupId: "grp-a",
  },
  {
    deviceId: "mic-b",
    kind: "audioinput" as MediaDeviceKind,
    label: "Fake Audio Input 2",
    groupId: "grp-b",
  },
  {
    deviceId: "default",
    kind: "audiooutput" as MediaDeviceKind,
    label: "Fake Default Audio Output",
    groupId: "grp-a",
  },
  {
    deviceId: "speaker-a",
    kind: "audiooutput" as MediaDeviceKind,
    label: "Fake Audio Output 1",
    groupId: "grp-b",
  },
  {
    deviceId: "cam-a",
    kind: "videoinput" as MediaDeviceKind,
    label: "Fake Video Input 1",
    groupId: "grp-c",
  },
  {
    deviceId: "cam-b",
    kind: "videoinput" as MediaDeviceKind,
    label: "Fake Video Input 2",
    groupId: "grp-d",
  },
];

/**
 * An output element with the two behaviours the manager actually depends on:
 * a sink it can be routed to, and a `play()` the policy can refuse.
 *
 * `blocked` is read through a getter on the platform rather than copied in, so
 * arming the policy affects elements bound before *and* after the call — which
 * is what a real autoplay policy does.
 */
class FakeOutputElement implements OutputElementLike {
  sinkId = "";
  paused = true;
  playAttempts = 0;

  constructor(private readonly blocked: () => boolean) {}

  async setSinkId(sinkId: string): Promise<void> {
    this.sinkId = sinkId;
  }

  async play(): Promise<void> {
    this.playAttempts += 1;
    if (this.blocked()) {
      throw new DOMException(
        "play() failed because the user didn't interact first",
        "NotAllowedError",
      );
    }
    this.paused = false;
  }
}

export class FakeLabPlatform implements LabPlatform {
  readonly devices = new FakeMediaDevices();
  readonly visibility = new ScriptedVisibility();
  private readonly elements: FakeOutputElement[] = [];
  private autoplayBlocked = false;

  constructor(seed = FAKE_DEVICES) {
    for (const device of seed) this.devices.addDevice({ ...device });
    this.devices.resetCounters();
  }

  get mediaDevices(): MediaDevicesLike {
    return this.devices;
  }

  async capabilities(): Promise<LabCapabilities> {
    return {
      contentHint: true,
      setSinkId: true,
      multipleMics: true,
      multipleCams: true,
      audiooutputEnumerated: true,
      selectableSpeaker: true,
      screenShare: true,
      vanishMidAcquire: true,
      // Node has no `RTCPeerConnection` and the fake platform does not pretend
      // to: the loopback is the one thing tier 1 genuinely cannot model.
      loopbackPeerConnection: false,
    };
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

  vanishDeviceDuringNextAcquire(deviceId: string): boolean {
    this.devices.vanishDeviceDuringNextAcquire(deviceId);
    return true;
  }

  simulateEnded(kind: ScriptKind): boolean {
    const track = this.devices.liveIssued(kind);
    if (!track) return false;
    track.simulateDeviceEnded();
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
    const element = new FakeOutputElement(() => this.autoplayBlocked);
    this.elements.push(element);
    return element;
  }

  blockAutoplay(blocked: boolean): void {
    this.autoplayBlocked = blocked;
  }

  playAttempts(): number[] {
    return this.elements.map((element) => element.playAttempts);
  }

  dispose(): void {
    for (const track of this.devices.issued) track.stop();
    for (const track of this.devices.issuedDisplay) track.stop();
  }
}

// `deviceInfo` is re-exported so a test that needs to build a MediaDeviceInfo
// literal (rather than go through the platform) has one honest way to do it.
export { deviceInfo };
