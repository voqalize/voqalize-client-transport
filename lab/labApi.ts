/**
 * The command surface a contract body drives, and the only thing that crosses
 * the tier-2 page boundary.
 *
 * Every method is async, and every argument and result is structured-cloneable
 * — no `MediaStreamTrack`, no `MediaDeviceInfo`, no callbacks. That constraint
 * is not incidental: tracks are not cloneable across `page.evaluate` (agent 1's
 * explicit guidance), so the id-keyed, data-only shape is what lets tier 2 run
 * the same bodies tier 1 runs in-process.
 *
 * Tier 1 implements this directly over the manager. Tier 2 implements it as a
 * proxy that forwards each call into the page.
 */

import type { LabCapabilities } from "./labPlatform";
import type { RecordedDisplayCall, RecordedGumCall } from "./fakeMediaDevices";
import type { ScriptKind } from "../src/mediaPlatform";
import type { AppliedParameters, Lane, LaneStats } from "./loopback";
import type { RelayDirection, RelayStats } from "./relayTypes";
import type { LaneNumbers, TransportSnapshot } from "./labTransport";

export interface TrackSnapshot {
  id: string;
  kind: string;
  label: string;
  deviceId: string;
  enabled: boolean;
  readyState: MediaStreamTrackState;
  muted: boolean;
  contentHint: string;
}

export interface TracksSnapshot {
  audio: TrackSnapshot | null;
  video: TrackSnapshot | null;
  screenVideo: TrackSnapshot | null;
}

/** `ENCODING_POLICY`, flattened for the page boundary. Plain numbers and strings only. */
export interface EncodingPolicySnapshot {
  contentHint: string;
  degradationPreference: string;
  maxFramerate: number;
  maxBitrate: number;
}

/** The transceiver shape, m-line count and connection state, in one round trip. */
export interface PcShapeSnapshot {
  mLineCount: number;
  /** `negotiationneeded` firings after the first offer/answer settled. Decision 4 keeps this at 0. */
  renegotiationsNeeded: number;
  transceivers: Array<{
    index: number;
    lane: Lane | null;
    kind: string;
    direction: string;
    mid: string | null;
  }>;
  connection: { local: string; remote: string; iceLocal: string; iceRemote: string };
}

export interface DeviceSnapshot {
  deviceId: string;
  kind: string;
  label: string;
  groupId: string;
}

export interface DeviceErrorSnapshot {
  name: string;
  type: string;
  message: string;
  devices: string[];
}

export interface NetOpenOptions {
  /** pipecat waits 5 000 ms on `disconnected`. A test that wants an answer shortens it. */
  disconnectedGraceMs?: number;
  maxReconnectionAttempts?: number;
  /** Recover with `restartIce()` on the same peer connection instead of rebuilding. */
  preferIceRestart?: boolean;
}

export interface LabResetOptions {
  enableMic?: boolean;
  enableCam?: boolean;
  releaseMicOnDisable?: boolean;
  releaseCamOnDisable?: boolean;
  mutedRecoveryMs?: number;
  deviceChangeDebounceMs?: number;
  fallbackToDefaultDevice?: boolean;
}

/**
 * Ordered log of everything the manager announced. Strings, so a body can
 * assert on ordering with a plain array comparison across both tiers.
 * Format: `"<callback>:<detail>"`, e.g. `"onTrackStarted:audio"`.
 */
export type EventLog = string[];

export interface LabApi {
  /** Tear down any previous manager and platform and build a fresh pair. */
  reset(options?: LabResetOptions): Promise<void>;
  capabilities(): Promise<LabCapabilities>;

  // -- manager surface -----------------------------------------------------
  initialize(): Promise<void>;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  enableMic(enable: boolean): Promise<void>;
  isMicEnabled(): Promise<boolean>;
  isCamEnabled(): Promise<boolean>;
  isSharingScreen(): Promise<boolean>;
  supportsScreenShare(): Promise<boolean>;
  enableCam(enable: boolean): Promise<void>;
  enableScreenShare(enable: boolean): Promise<void>;
  updateCam(deviceId: string): Promise<void>;
  getAllMics(): Promise<DeviceSnapshot[]>;
  getAllCams(): Promise<DeviceSnapshot[]>;
  getAllSpeakers(): Promise<DeviceSnapshot[]>;
  updateMic(deviceId: string): Promise<void>;
  updateSpeaker(deviceId: string): Promise<void>;
  selectedMic(): Promise<DeviceSnapshot | null>;
  selectedCam(): Promise<DeviceSnapshot | null>;
  selectedSpeaker(): Promise<DeviceSnapshot | null>;
  requestedMicId(): Promise<string>;
  requestedCamId(): Promise<string>;
  encodingPolicy(): Promise<Record<string, EncodingPolicySnapshot>>;
  tracks(): Promise<TracksSnapshot>;
  captureTracks(): Promise<TracksSnapshot>;
  bufferBotAudio(): Promise<boolean>;
  userStartedSpeaking(): Promise<boolean>;

  // -- observation ---------------------------------------------------------
  events(): Promise<EventLog>;
  clearEvents(): Promise<void>;
  deviceErrors(): Promise<DeviceErrorSnapshot[]>;
  gumCalls(): Promise<RecordedGumCall[]>;
  displayCalls(): Promise<RecordedDisplayCall[]>;
  enumerateCount(): Promise<number>;
  resetCounters(): Promise<void>;
  /** Track-changed events seen by the phase-4 replaceTrack hook, as `"<type>:<id|null>"`. */
  trackChanges(): Promise<string[]>;

  // -- phase 2b: the loopback peer connection -------------------------------
  //
  // Two RTCPeerConnections in this page, wired to each other. Tier 1 has no
  // RTCPeerConnection at all, so every case that touches these is
  // `tiers: ["browser"]` — see `src/loopback.ts` for why the shape is what it
  // is (three sendonly transceivers created before the first offer).

  /**
   * Build the loopback, publish whatever the manager already holds, negotiate,
   * and wait for both ends to reach `connected`.
   */
  pcOpen(): Promise<void>;
  pcClose(): Promise<void>;
  /** A second offer/answer. Should never be needed for a mid-call screen share (decision 4). */
  pcNegotiate(): Promise<void>;
  /** `m=` sections in the offer this page sent. Decision 4 says 3, always. */
  pcMLineCount(): Promise<number>;
  pcShape(): Promise<PcShapeSnapshot>;
  pcStats(): Promise<Record<Lane, LaneStats>>;
  /** Apply `ENCODING_POLICY` to every sender and report what the engine kept. */
  pcApplyEncoding(): Promise<AppliedParameters[]>;
  /** What `SmallWebRTCTransport.closePeerConnection()` does to sender tracks. */
  pcStopSenderTracks(): Promise<void>;
  pcSenderTrackIds(): Promise<Record<Lane, string | null>>;
  /** Lanes whose decoded track arrived at the receiving peer. */
  pcRemoteTrackLanes(): Promise<Lane[]>;

  // -- platform scripting --------------------------------------------------
  hideDevice(deviceId: string): Promise<void>;
  unhideAll(): Promise<void>;
  dispatchDeviceChange(): Promise<void>;
  failNextGetUserMedia(name: string, message: string): Promise<void>;
  failNextGetDisplayMedia(name: string, message: string): Promise<void>;
  vanishDeviceDuringNextAcquire(deviceId: string): Promise<boolean>;
  /**
   * Stop the *published* clone of a lane, leaving the capture track alone —
   * what `SmallWebRTCTransport.closePeerConnection()` does to a sender's track
   * on every reconnect. Returns false if that lane publishes nothing.
   *
   * It is `stop()`, not an `ended` event, on purpose: `stop()` fires no event
   * anywhere, which is the whole reason the manager has to poll for this.
   */
  stopPublishedTrack(lane: Lane): Promise<boolean>;

  /**
   * `simulateEnded("screen")` is how both tiers model the browser's own "Stop
   * sharing" chrome: the track really ends and we never called `stop()`.
   */
  simulateEnded(kind: ScriptKind): Promise<boolean>;
  simulateMute(kind: ScriptKind): Promise<boolean>;
  simulateUnmute(kind: ScriptKind): Promise<boolean>;
  setVisibility(state: "visible" | "hidden"): Promise<void>;

  // -- speaker routing -----------------------------------------------------
  bindOutputElement(): Promise<void>;
  boundSinkIds(): Promise<string[]>;
  /** Drop the most recently bound element, as an app unmounting a player would. */
  unbindLastOutputElement(): Promise<void>;

  // -- playback ------------------------------------------------------------
  /**
   * Arm or clear the autoplay policy on every bound element, present and
   * future. In tier 1 this is the fake element's own policy; in tier 2 it is a
   * scripted rejection on a real element (see `realPlatform.ts` — the browser
   * will not block on demand, so the *refusal* is simulated and the manager's
   * reaction to it is not).
   */
  blockAutoplay(blocked: boolean): Promise<void>;
  playbackBlocked(): Promise<boolean>;
  resumePlayback(): Promise<boolean>;
  /** `play()` attempts per bound element, in bind order. */
  playAttempts(): Promise<number[]>;
  /** `"blocked"` / `"playing"` transitions announced on `onPlaybackBlocked`, in order. */
  playbackEvents(): Promise<string[]>;

  // -- phase 4: the relayed transport ---------------------------------------
  //
  // Scenarios 6 (the network path moves) and 7 (ICE wedges). Both need a
  // *middle* — see `src/relayTypes.ts` for why a same-page loopback cannot
  // produce either — so these methods drive one `LabTransport` over one
  // Node-side UDP relay. Browser tier only; node has no RTCPeerConnection.

  /**
   * Open a relay, build the transport over it, publish whatever the manager
   * holds, and wait for the call to connect.
   */
  netOpen(options?: NetOpenOptions): Promise<void>;
  netClose(): Promise<void>;
  netSnapshot(): Promise<TransportSnapshot>;
  /** Per-lane sender track identity and both ends' packet counters. */
  netLanes(): Promise<LaneNumbers[]>;
  netRelayStats(): Promise<RelayStats>;

  /** Scenario 7: the path stays and the packets stop. */
  netBlackhole(direction?: RelayDirection): Promise<void>;
  netResume(): Promise<void>;
  /** Scenario 6: the path moves — old ports closed, new ports open. */
  netRebind(): Promise<void>;
  netLoss(rate: number): Promise<void>;

  netWaitConnected(timeoutMs?: number): Promise<void>;
  /** Resolves on the first `disconnected`/`failed`, and returns which. */
  netWaitBroken(timeoutMs?: number): Promise<string>;
  /** Resolves once at least `index` peer connections have been built. */
  netWaitGeneration(index: number, timeoutMs?: number): Promise<void>;
  /** Re-publish the manager's current tracks onto the live senders. */
  netRepublish(): Promise<void>;

  /**
   * Fire several mutations without awaiting any of them, then settle.
   *
   * It exists because decision 2 (one queue, every mutation through it) can
   * only be observed by *overlapping* calls, and tier 2's transport is one
   * `page.evaluate` round trip per call — issuing them from node would
   * serialize them at the boundary and prove nothing. Running the burst inside
   * the page makes the overlap real in both tiers.
   *
   * Returns one `"fulfilled"`/`"rejected"` per op, in order.
   */
  burst(ops: Array<[LabMethod, unknown[]]>): Promise<string[]>;
}

export type LabMethod = keyof LabApi;

/**
 * Result envelope for the page boundary. An exception thrown inside
 * `page.evaluate` arrives in node with its `name` flattened into the message,
 * which loses exactly the field the error-mapping cases assert on — so errors
 * travel as data and the node-side driver rethrows them.
 */
export type LabResult =
  | { ok: true; value: unknown }
  | { ok: false; error: { name: string; message: string; type?: string; devices?: string[] } };

export class LabError extends Error {
  readonly errorName: string;
  readonly deviceErrorType: string | undefined;
  readonly devices: string[] | undefined;

  constructor(error: { name: string; message: string; type?: string; devices?: string[] }) {
    super(error.message);
    this.name = error.name;
    this.errorName = error.name;
    this.deviceErrorType = error.type;
    this.devices = error.devices;
  }
}
