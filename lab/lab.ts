/**
 * The lab: one `VoqalizeMediaManager` over one `LabPlatform`, wrapped in the
 * data-only `LabApi` both tiers drive.
 *
 * This file runs unchanged in node (tier 1) and inside the page (tier 2). It
 * is the piece that makes "the same test bodies, two harnesses" literal rather
 * than aspirational.
 */

import {
  LabError,
  type PcShapeSnapshot,
  type DeviceErrorSnapshot,
  type DeviceSnapshot,
  type EncodingPolicySnapshot,
  type EventLog,
  type LabApi,
  type LabMethod,
  type LabResetOptions,
  type LabResult,
  type NetOpenOptions,
  type TrackSnapshot,
  type TracksSnapshot,
} from "./labApi";
import type { LabCapabilities, LabPlatform } from "./labPlatform";
import {
  LANE_ORDER,
  LoopbackCall,
  type AppliedParameters,
  type Lane,
  type LaneStats,
} from "./loopback";
import { RelayHandle } from "./relayClient";
import type { RelayDirection, RelayStats } from "./relayTypes";
import { LabTransport, type LaneNumbers, type TransportSnapshot } from "./labTransport";
import type { OutputElementLike, ScriptKind, TrackLike } from "../src/mediaPlatform";
import { DeviceError } from "../src/pipecatTypes";
import { ENCODING_POLICY, VoqalizeMediaManager } from "../src/mediaManager";

/** The originating DOM exception's name, where the manager kept one. */
function sourceName(error: DeviceError): string {
  const source = error.details?.["sourceError"];
  return source instanceof Error ? source.name : error.name;
}

function snapshotTrack(track: TrackLike | null | undefined): TrackSnapshot | null {
  if (!track) return null;
  return {
    id: track.id,
    kind: track.kind,
    label: track.label,
    deviceId: String(track.getSettings().deviceId ?? ""),
    enabled: track.enabled,
    readyState: track.readyState,
    muted: track.muted,
    contentHint: track.contentHint,
  };
}

function snapshotDevice(device: MediaDeviceInfo): DeviceSnapshot {
  return {
    deviceId: device.deviceId,
    kind: device.kind,
    label: device.label,
    groupId: device.groupId,
  };
}

export class Lab implements LabApi {
  private platform: LabPlatform | null = null;
  private manager: VoqalizeMediaManager | null = null;
  private readonly log: EventLog = [];
  private readonly errors: DeviceErrorSnapshot[] = [];
  private readonly changes: string[] = [];
  private readonly elements: OutputElementLike[] = [];
  private readonly unbinds: Array<() => void> = [];
  private readonly playback: string[] = [];
  /**
   * Phase 2b. Null until `pcOpen()`, and null in tier 1 forever — node has no
   * `RTCPeerConnection`, which is why every case that touches it declares
   * `tiers: ["browser"]`.
   */
  private loopback: LoopbackCall | null = null;
  /**
   * Phase 4. The relayed transport and the relay it runs over — scenarios 6
   * and 7. Browser tier only, and additionally dev-server-only: the relay is
   * two UDP sockets inside Vite (`relay/udpRelay.ts`).
   */
  private transport: LabTransport | null = null;
  private relay: RelayHandle | null = null;

  constructor(private readonly makePlatform: () => LabPlatform) {}

  async reset(options: LabResetOptions = {}): Promise<void> {
    if (this.manager) await this.manager.destroy().catch(() => undefined);
    this.loopback?.close();
    this.loopback = null;
    if (this.transport) await this.transport.close().catch(() => undefined);
    this.transport = null;
    if (this.relay) await this.relay.close().catch(() => undefined);
    this.relay = null;
    this.platform?.dispose();
    this.log.length = 0;
    this.errors.length = 0;
    this.changes.length = 0;
    this.elements.length = 0;
    this.unbinds.length = 0;
    this.playback.length = 0;

    const platform = this.makePlatform();
    const manager = new VoqalizeMediaManager({
      mediaDevices: platform.mediaDevices,
      visibility: platform.visibility,
      // Test-scale timings. The bodies wait real time in both tiers — no fake
      // clock, because a fake clock is exactly the thing tier 2 cannot have.
      mutedRecoveryMs: options.mutedRecoveryMs ?? 60,
      deviceChangeDebounceMs: options.deviceChangeDebounceMs ?? 40,
      ...(options.releaseMicOnDisable === undefined
        ? {}
        : { releaseMicOnDisable: options.releaseMicOnDisable }),
      ...(options.releaseCamOnDisable === undefined
        ? {}
        : { releaseCamOnDisable: options.releaseCamOnDisable }),
      ...(options.fallbackToDefaultDevice === undefined
        ? {}
        : { fallbackToDefaultDevice: options.fallbackToDefaultDevice }),
      onPlaybackBlocked: (blocked) => this.playback.push(blocked ? "blocked" : "playing"),
    });

    manager.setClientOptions({
      enableMic: options.enableMic ?? true,
      enableCam: options.enableCam ?? false,
      callbacks: {
        onTrackStarted: (track) => this.log.push(`onTrackStarted:${track.kind}`),
        onTrackStopped: (track) => this.log.push(`onTrackStopped:${track.kind}`),
        // A screen track is `kind === "video"` too, so the callback name is
        // the only thing separating a display from a camera here — which is
        // exactly the distinction the cases assert.
        onScreenTrackStarted: (track) => this.log.push(`onScreenTrackStarted:${track.kind}`),
        onScreenTrackStopped: (track) => this.log.push(`onScreenTrackStopped:${track.kind}`),
        onScreenShareError: () => this.log.push("onScreenShareError"),
        onMicUpdated: (mic) => this.log.push(`onMicUpdated:${mic.deviceId}`),
        onCamUpdated: (cam) => this.log.push(`onCamUpdated:${cam.deviceId}`),
        onSpeakerUpdated: (speaker) => this.log.push(`onSpeakerUpdated:${speaker.deviceId}`),
        onAvailableMicsUpdated: (mics) => this.log.push(`onAvailableMicsUpdated:${mics.length}`),
        onAvailableCamsUpdated: (cams) => this.log.push(`onAvailableCamsUpdated:${cams.length}`),
        onAvailableSpeakersUpdated: (s) => this.log.push(`onAvailableSpeakersUpdated:${s.length}`),
        onDeviceError: (error) => {
          this.log.push(`onDeviceError:${error.type}`);
          this.errors.push({
            // The DOM exception name, not "DeviceError" — which name a browser
            // used is the whole content of the mapping, and it is the only
            // thing that tells `permissions` from `in-use` after the fact.
            name: sourceName(error),
            type: error.type,
            message: error.message,
            devices: [...error.devices],
          });
        },
      },
    });
    manager.setLocalTrackChangedHandler(async (event) => {
      this.changes.push(`${event.type}:${event.track ? event.track.id : "null"}`);
      // This *is* the replaceTrack hook (SPEC.md § Ground truth: the transport
      // never registers it for an injected manager, so every later device
      // switch silently stops reaching the peer connection). The manager
      // awaits this handler before stopping the previous clone, so the swap
      // completes while the old track is still live — no gap on the wire.
      if (event.type === "screenAudio") return; // never populated, decision 9
      // Both peer-connection surfaces get the same hook. The transport
      // re-reads `tracks().local` wholesale rather than taking the one track
      // in the event, which is what `SmallWebRTCTransport.addUserMedia()` does
      // and therefore what has to be proven.
      if (this.transport) await this.transport.republish();
      if (!this.loopback) return;
      await this.loopback.publish(event.type, event.track);
    });

    this.platform = platform;
    this.manager = manager;
  }

  private get p(): LabPlatform {
    if (!this.platform) throw new Error("Lab.reset() has not been called");
    return this.platform;
  }

  private get m(): VoqalizeMediaManager {
    if (!this.manager) throw new Error("Lab.reset() has not been called");
    return this.manager;
  }

  capabilities(): Promise<LabCapabilities> {
    return this.p.capabilities();
  }

  // -- manager surface -------------------------------------------------------

  initialize(): Promise<void> {
    return this.m.initialize();
  }
  connect(): Promise<void> {
    return this.m.connect();
  }
  disconnect(): Promise<void> {
    return this.m.disconnect();
  }
  async enableMic(enable: boolean): Promise<void> {
    await this.m.enableMic(enable);
  }
  async isMicEnabled(): Promise<boolean> {
    return this.m.isMicEnabled;
  }
  async isCamEnabled(): Promise<boolean> {
    return this.m.isCamEnabled;
  }
  async isSharingScreen(): Promise<boolean> {
    return this.m.isSharingScreen;
  }
  async supportsScreenShare(): Promise<boolean> {
    return this.m.supportsScreenShare;
  }
  async enableCam(enable: boolean): Promise<void> {
    await this.m.enableCam(enable);
  }
  async enableScreenShare(enable: boolean): Promise<void> {
    await this.m.enableScreenShare(enable);
  }
  async updateCam(deviceId: string): Promise<void> {
    await this.m.updateCam(deviceId);
  }
  async getAllMics(): Promise<DeviceSnapshot[]> {
    return (await this.m.getAllMics()).map(snapshotDevice);
  }
  async getAllCams(): Promise<DeviceSnapshot[]> {
    return (await this.m.getAllCams()).map(snapshotDevice);
  }
  async getAllSpeakers(): Promise<DeviceSnapshot[]> {
    return (await this.m.getAllSpeakers()).map(snapshotDevice);
  }
  async updateMic(deviceId: string): Promise<void> {
    await this.m.updateMic(deviceId);
  }
  async updateSpeaker(deviceId: string): Promise<void> {
    await this.m.updateSpeaker(deviceId);
  }
  async selectedMic(): Promise<DeviceSnapshot | null> {
    const mic = this.m.selectedMic;
    return "deviceId" in mic ? snapshotDevice(mic as MediaDeviceInfo) : null;
  }
  async selectedCam(): Promise<DeviceSnapshot | null> {
    const cam = this.m.selectedCam;
    return "deviceId" in cam ? snapshotDevice(cam as MediaDeviceInfo) : null;
  }
  async selectedSpeaker(): Promise<DeviceSnapshot | null> {
    const speaker = this.m.selectedSpeaker;
    return "deviceId" in speaker ? snapshotDevice(speaker as MediaDeviceInfo) : null;
  }
  async requestedMicId(): Promise<string> {
    return this.m.requestedMicId;
  }
  async requestedCamId(): Promise<string> {
    return this.m.requestedCamId;
  }
  async encodingPolicy(): Promise<Record<string, EncodingPolicySnapshot>> {
    // Copied field by field rather than handed over by reference: the same
    // call has to survive `structuredClone` across the tier-2 page boundary.
    const out: Record<string, EncodingPolicySnapshot> = {};
    for (const [key, policy] of Object.entries(this.m.encodingPolicy())) {
      out[key] = {
        contentHint: policy.contentHint,
        degradationPreference: policy.degradationPreference,
        maxFramerate: policy.maxFramerate,
        maxBitrate: policy.maxBitrate,
      };
    }
    return out;
  }
  async tracks(): Promise<TracksSnapshot> {
    const local = this.m.tracks().local;
    return {
      audio: snapshotTrack(local.audio as unknown as TrackLike | undefined),
      video: snapshotTrack(local.video as unknown as TrackLike | undefined),
      screenVideo: snapshotTrack(local.screenVideo as unknown as TrackLike | undefined),
    };
  }
  async stopPublishedTrack(lane: Lane): Promise<boolean> {
    const track = this.m.tracks().local[lane] as unknown as TrackLike | undefined;
    if (!track || track.readyState !== "live") return false;
    track.stop();
    return true;
  }
  async captureTracks(): Promise<TracksSnapshot> {
    const capture = this.m.captureTracks();
    return {
      audio: snapshotTrack(capture.audio),
      video: snapshotTrack(capture.video),
      screenVideo: snapshotTrack(capture.screenVideo),
    };
  }
  async bufferBotAudio(): Promise<boolean> {
    return this.m.bufferBotAudio(new ArrayBuffer(8)) === undefined;
  }
  async userStartedSpeaking(): Promise<boolean> {
    return (await this.m.userStartedSpeaking()) === undefined;
  }

  // -- observation -----------------------------------------------------------

  async events(): Promise<EventLog> {
    return [...this.log];
  }
  async clearEvents(): Promise<void> {
    this.log.length = 0;
    this.changes.length = 0;
  }
  async deviceErrors(): Promise<DeviceErrorSnapshot[]> {
    return [...this.errors];
  }
  async gumCalls() {
    return this.p.gumCalls();
  }
  async displayCalls() {
    return this.p.displayCalls();
  }
  async enumerateCount(): Promise<number> {
    return this.p.enumerateCount();
  }
  async resetCounters(): Promise<void> {
    this.p.resetCounters();
  }
  async trackChanges(): Promise<string[]> {
    return [...this.changes];
  }

  // -- phase 2b: the loopback peer connection ---------------------------------

  private get pc(): LoopbackCall {
    if (!this.loopback) throw new Error("Lab.pcOpen() has not been called");
    return this.loopback;
  }

  async pcOpen(): Promise<void> {
    this.loopback?.close();
    const loopback = new LoopbackCall();
    this.loopback = loopback;
    // Seed with whatever is already published. `pcOpen()` after `connect()` is
    // the normal order, and the hook only fires on *changes*.
    const local = this.m.tracks().local;
    for (const lane of LANE_ORDER) {
      if (local[lane]) await loopback.publish(lane, local[lane]);
    }
    await loopback.negotiate();
    await loopback.waitUntilConnected();
    // Decision 8 is applied once the senders exist; Firefox reports an empty
    // encoding list before that and refuses a setParameters that changes its
    // length.
    for (const lane of LANE_ORDER) await loopback.applyEncoding(lane, ENCODING_POLICY[lane]);
  }

  async pcClose(): Promise<void> {
    this.loopback?.close();
    this.loopback = null;
    if (this.transport) await this.transport.close().catch(() => undefined);
    this.transport = null;
    if (this.relay) await this.relay.close().catch(() => undefined);
    this.relay = null;
  }

  async pcNegotiate(): Promise<void> {
    await this.pc.negotiate();
  }

  async pcMLineCount(): Promise<number> {
    return this.pc.mLineCount();
  }

  async pcShape(): Promise<PcShapeSnapshot> {
    const pc = this.pc;
    return {
      mLineCount: pc.mLineCount(),
      renegotiationsNeeded: pc.renegotiationCount(),
      transceivers: pc.transceiverShape(),
      connection: pc.connectionStates(),
    };
  }

  async pcStats(): Promise<Record<Lane, LaneStats>> {
    return this.pc.stats();
  }

  async pcApplyEncoding(): Promise<AppliedParameters[]> {
    const pc = this.pc;
    const out: AppliedParameters[] = [];
    for (const lane of LANE_ORDER) out.push(await pc.applyEncoding(lane, ENCODING_POLICY[lane]));
    return out;
  }

  async pcStopSenderTracks(): Promise<void> {
    this.pc.stopSenderTracks();
  }

  async pcSenderTrackIds(): Promise<Record<Lane, string | null>> {
    const pc = this.pc;
    const out = {} as Record<Lane, string | null>;
    for (const lane of LANE_ORDER) out[lane] = pc.senderTrackId(lane);
    return out;
  }

  async pcRemoteTrackLanes(): Promise<Lane[]> {
    return LANE_ORDER.filter((lane) => this.pc.remoteTracks.has(lane));
  }

  // -- phase 4: the relayed transport -----------------------------------------

  private get net(): LabTransport {
    if (!this.transport) throw new Error("Lab.netOpen() has not been called");
    return this.transport;
  }

  private get rly(): RelayHandle {
    if (!this.relay) throw new Error("Lab.netOpen() has not been called");
    return this.relay;
  }

  async netOpen(options: NetOpenOptions = {}): Promise<void> {
    if (this.transport) await this.transport.close();
    if (this.relay) await this.relay.close().catch(() => undefined);
    const relay = await RelayHandle.open();
    this.relay = relay;
    const transport = new LabTransport({
      relay,
      // Read fresh on every rebuild, exactly as pipecat's `addUserMedia()`
      // does — which is what makes the published-clone lifetime observable.
      tracks: () => this.m.tracks().local,
      ...(options.disconnectedGraceMs === undefined
        ? {}
        : { disconnectedGraceMs: options.disconnectedGraceMs }),
      ...(options.maxReconnectionAttempts === undefined
        ? {}
        : { maxReconnectionAttempts: options.maxReconnectionAttempts }),
      ...(options.preferIceRestart === undefined
        ? {}
        : { preferIceRestart: options.preferIceRestart }),
    });
    this.transport = transport;
    await transport.connect();
    await transport.waitUntilConnected();
  }

  async netClose(): Promise<void> {
    if (this.transport) await this.transport.close();
    this.transport = null;
    if (this.relay) await this.relay.close().catch(() => undefined);
    this.relay = null;
  }

  async netSnapshot(): Promise<TransportSnapshot> {
    return this.net.snapshot();
  }

  netLanes(): Promise<LaneNumbers[]> {
    return this.net.laneNumbers();
  }

  netRelayStats(): Promise<RelayStats> {
    return this.rly.stats();
  }

  async netBlackhole(direction: RelayDirection = "both"): Promise<void> {
    await this.rly.blackhole(direction);
  }

  async netResume(): Promise<void> {
    await this.rly.resume();
  }

  async netRebind(): Promise<void> {
    await this.rly.rebind();
  }

  async netLoss(rate: number): Promise<void> {
    await this.rly.loss(rate);
  }

  async netWaitConnected(timeoutMs?: number): Promise<void> {
    await this.net.waitUntilConnected(timeoutMs);
  }

  netWaitBroken(timeoutMs?: number): Promise<string> {
    return this.net.waitUntilBroken(timeoutMs);
  }

  async netWaitGeneration(index: number, timeoutMs?: number): Promise<void> {
    await this.net.waitForGeneration(index, timeoutMs);
  }

  async netRepublish(): Promise<void> {
    await this.net.republish();
  }

  // -- platform scripting ----------------------------------------------------

  async hideDevice(deviceId: string): Promise<void> {
    this.p.hideDevice(deviceId);
  }
  async unhideAll(): Promise<void> {
    this.p.unhideAll();
  }
  async dispatchDeviceChange(): Promise<void> {
    this.p.dispatchDeviceChange();
  }
  async failNextGetUserMedia(name: string, message: string): Promise<void> {
    this.p.failNextGetUserMedia(name, message);
  }
  async failNextGetDisplayMedia(name: string, message: string): Promise<void> {
    this.p.failNextGetDisplayMedia(name, message);
  }
  async vanishDeviceDuringNextAcquire(deviceId: string): Promise<boolean> {
    return this.p.vanishDeviceDuringNextAcquire(deviceId);
  }
  async simulateEnded(kind: ScriptKind): Promise<boolean> {
    return this.p.simulateEnded(kind);
  }
  async simulateMute(kind: ScriptKind): Promise<boolean> {
    return this.p.simulateMute(kind);
  }
  async simulateUnmute(kind: ScriptKind): Promise<boolean> {
    return this.p.simulateUnmute(kind);
  }
  async setVisibility(state: "visible" | "hidden"): Promise<void> {
    this.p.visibility.setVisibility(state);
  }

  // -- speaker routing -------------------------------------------------------

  async bindOutputElement(): Promise<void> {
    const element = this.p.createOutputElement();
    this.elements.push(element);
    this.unbinds.push(this.m.bindOutputElement(element));
  }
  async boundSinkIds(): Promise<string[]> {
    return this.elements.map((element) => element.sinkId ?? "");
  }
  async unbindLastOutputElement(): Promise<void> {
    const unbind = this.unbinds.pop();
    this.elements.pop();
    unbind?.();
  }

  // -- playback --------------------------------------------------------------

  async blockAutoplay(blocked: boolean): Promise<void> {
    this.p.blockAutoplay(blocked);
  }
  async playbackBlocked(): Promise<boolean> {
    return this.m.playbackBlocked;
  }
  async resumePlayback(): Promise<boolean> {
    return this.m.resumePlayback();
  }
  async playAttempts(): Promise<number[]> {
    return this.p.playAttempts();
  }
  async playbackEvents(): Promise<string[]> {
    return [...this.playback];
  }

  async burst(ops: Array<[LabMethod, unknown[]]>): Promise<string[]> {
    // Deliberately no `await` in the loop: the point is that all of these are
    // in flight at once, which is the only way the mutation queue is
    // observable at all.
    const running = ops.map(([method, args]) => this.call(method, args));
    const settled = await Promise.all(running);
    return settled.map((result) => (result.ok ? "fulfilled" : "rejected"));
  }

  /**
   * The single entry point tier 2 calls through `page.evaluate`. Errors travel
   * as data rather than as thrown exceptions, because a thrown exception loses
   * its `name` — and `name` is what the error-mapping cases assert on.
   */
  async call(method: LabMethod, args: unknown[]): Promise<LabResult> {
    try {
      const fn = (this as unknown as Record<string, (...a: unknown[]) => unknown>)[method];
      if (typeof fn !== "function") throw new Error(`Unknown lab method: ${String(method)}`);
      const value = await fn.apply(this, args);
      return { ok: true, value: value === undefined ? null : value };
    } catch (raw) {
      const error = raw instanceof Error ? raw : new Error(String(raw));
      const payload: { name: string; message: string; type?: string; devices?: string[] } = {
        name: error.name,
        message: error.message,
      };
      if (error instanceof DeviceError) {
        payload.name = sourceName(error);
        payload.type = error.type;
        payload.devices = [...error.devices];
      }
      return { ok: false, error: payload };
    }
  }
}

/** Turn a `Lab` into a `LabApi` whose rejections carry `name`/`type` — the shape tier 2's proxy also produces. */
export function localLabApi(lab: Lab): LabApi {
  const wrap =
    (method: LabMethod) =>
    async (...args: unknown[]) => {
      const result = await lab.call(method, args);
      if (result.ok) return result.value;
      throw new LabError(result.error);
    };
  const api = {} as Record<string, unknown>;
  for (const method of LAB_METHODS) api[method] = wrap(method);
  return api as unknown as LabApi;
}

/** Every `LabApi` member, listed once. The `satisfies` keeps it honest against the interface. */
export const LAB_METHODS = [
  "reset",
  "capabilities",
  "initialize",
  "connect",
  "disconnect",
  "enableMic",
  "isMicEnabled",
  "isCamEnabled",
  "isSharingScreen",
  "supportsScreenShare",
  "enableCam",
  "enableScreenShare",
  "updateCam",
  "getAllMics",
  "getAllCams",
  "getAllSpeakers",
  "updateMic",
  "updateSpeaker",
  "selectedMic",
  "selectedCam",
  "selectedSpeaker",
  "requestedMicId",
  "requestedCamId",
  "encodingPolicy",
  "tracks",
  "captureTracks",
  "bufferBotAudio",
  "userStartedSpeaking",
  "events",
  "clearEvents",
  "deviceErrors",
  "gumCalls",
  "displayCalls",
  "enumerateCount",
  "resetCounters",
  "trackChanges",
  "pcOpen",
  "pcClose",
  "pcNegotiate",
  "pcMLineCount",
  "pcShape",
  "pcStats",
  "pcApplyEncoding",
  "pcStopSenderTracks",
  "pcSenderTrackIds",
  "pcRemoteTrackLanes",
  "netOpen",
  "netClose",
  "netSnapshot",
  "netLanes",
  "netRelayStats",
  "netBlackhole",
  "netResume",
  "netRebind",
  "netLoss",
  "netWaitConnected",
  "netWaitBroken",
  "netWaitGeneration",
  "netRepublish",
  "hideDevice",
  "unhideAll",
  "dispatchDeviceChange",
  "failNextGetUserMedia",
  "failNextGetDisplayMedia",
  "vanishDeviceDuringNextAcquire",
  "stopPublishedTrack",
  "simulateEnded",
  "simulateMute",
  "simulateUnmute",
  "setVisibility",
  "bindOutputElement",
  "boundSinkIds",
  "unbindLastOutputElement",
  "blockAutoplay",
  "playbackBlocked",
  "resumePlayback",
  "playAttempts",
  "playbackEvents",
  "burst",
] as const satisfies readonly LabMethod[];
