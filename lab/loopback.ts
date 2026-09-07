/**
 * Two `RTCPeerConnection`s in one page, wired to each other. No signalling
 * server, no network hop, no pygato — SPEC.md § "Scope of this track" says the
 * peer connection this phase needs is made *in the page*.
 *
 * This is the first thing on the track that can produce a frame. Everything in
 * phases 1 and 2 is structural — track identity, lifecycle, counts, constraint
 * shapes — and a live track and an encoding track are different claims. What
 * proves the second one is `RTCOutboundRtpStreamStats.framesEncoded` going
 * above zero, which is what `stats()` below exists to read.
 *
 * Three things about the shape are deliberate:
 *
 * 1. **All three transceivers are created up front, `sendonly`, before the
 *    first offer.** Decision 4: `supportsScreenShare` is a constant `true` so
 *    the m-line count never varies by engine or by whether a share happens to
 *    be live. Lane 2 exists from the first offer with nothing in it.
 * 2. **Lane index is the contract.** `LANE_ORDER` is `0` audio, `1` video,
 *    `2` screenVideo, matching `getTransceivers()` order, which is m-line
 *    order, which is what pygato reads. Nothing here keys off a track id, a
 *    label or a device id — a screen track has no `deviceId` on firefox at all.
 * 3. **The peer connection only ever holds published clones.** The manager
 *    owns the capture track and hands the `onLocalTrackChanged` hook a clone
 *    (decision 1). `stopSenderTracks()` below reproduces what
 *    `SmallWebRTCTransport.closePeerConnection()` does to them, so a case can
 *    prove the capture track survives it.
 */

import type { EncodingPolicy, SlotKey } from "../src/mediaManager";

/** A lane is a slot with an m-line index. Same three keys, same order, every time. */
export type Lane = SlotKey;

/** m-line order, and therefore transceiver order. Decision 4 fixes it at three. */
export const LANE_ORDER: readonly Lane[] = ["audio", "video", "screenVideo"];

/** The `MediaStreamTrack.kind` behind each lane — lane 2 is a video track. */
const LANE_KIND: Readonly<Record<Lane, "audio" | "video">> = {
  audio: "audio",
  video: "video",
  screenVideo: "video",
};

/**
 * One lane's numbers, from both ends of the loopback. Plain data: this crosses
 * the tier-2 `page.evaluate` boundary and feeds the demo's stats table, so
 * every field is a number, a string or null.
 */
export interface LaneStats {
  lane: Lane;
  /** Present once the first answer is applied. Should equal the lane index as a string. */
  mid: string | null;
  direction: string;
  currentDirection: string | null;
  senderTrackId: string | null;
  senderTrackKind: string | null;
  senderTrackEnabled: boolean | null;
  senderTrackReadyState: string | null;

  // -- outbound (the sending peer) ------------------------------------------
  /** **The headline number.** Non-zero is the first proof a frame was ever encoded. */
  framesEncoded: number | null;
  framesSent: number | null;
  frameWidth: number | null;
  frameHeight: number | null;
  framesPerSecond: number | null;
  packetsSent: number;
  bytesSent: number;
  targetBitrate: number | null;
  qualityLimitationReason: string | null;
  /** The encoder that actually ran, as the browser names it (`video/VP8`, `audio/opus`). */
  codec: string | null;

  // -- inbound (the receiving peer) -----------------------------------------
  framesDecoded: number | null;
  framesReceived: number | null;
  inboundFrameWidth: number | null;
  inboundFrameHeight: number | null;
  packetsReceived: number;
  bytesReceived: number;
  /**
   * Receiver-side audio level, 0..1. Read from `getStats()` and never from Web
   * Audio: SPEC.md decision 7 keeps Web Audio out of the capture path, and a
   * meter built on an `AnalyserNode` would be measuring a different pipeline
   * than the one we ship.
   */
  audioLevel: number | null;
  /** Where `audioLevel` came from, so a null can be told from an unsupported field. */
  audioLevelSource: "inbound-rtp" | "synchronization-source" | "none";
}

/** What `setParameters` was asked for, and what the browser admits to afterwards. */
export interface AppliedParameters {
  lane: Lane;
  requested: EncodingPolicy;
  /** False when the lane has no sender at all (never, once negotiated). */
  hasSender: boolean;
  /** Non-null when `setParameters` itself rejected — that is a finding, not a crash. */
  error: string | null;
  /** How many encodings the sender reports. Zero before negotiation on some engines. */
  encodingCount: number;
  /** Read back through `getParameters()`. `null` means the engine dropped the field. */
  degradationPreference: string | null;
  maxFramerate: number | null;
  maxBitrate: number | null;
}

export interface LoopbackTrackEvent {
  lane: Lane;
  track: MediaStreamTrack;
}

export interface LoopbackOptions {
  /** Fires once per lane when the remote side receives its decoded track. */
  onRemoteTrack?: (event: LoopbackTrackEvent) => void;
}

function laneOf(index: number): Lane | null {
  return LANE_ORDER[index] ?? null;
}

/**
 * The real `MediaStreamTrack` behind whatever the manager handed us.
 *
 * The manager is written against `TrackLike` so one implementation runs in
 * node and in a browser (SPEC.md § Test taxonomy). Tier 2's platform wraps
 * every real track in a `ScriptableTrack` so a test can inject an `ended` no
 * browser will produce on demand; the demo page uses the raw
 * `navigator.mediaDevices` and hands over real tracks directly. A peer
 * connection only accepts the real thing, so unwrap here — once, in the one
 * place that talks to WebRTC — rather than leaking the harness's shape into
 * the manager.
 */
export function underlyingTrack(track: unknown): MediaStreamTrack | null {
  if (!track) return null;
  if (typeof MediaStreamTrack !== "undefined" && track instanceof MediaStreamTrack) return track;
  const real = (track as { real?: unknown }).real;
  return real instanceof MediaStreamTrack ? real : null;
}

/** `m=` section count in an SDP, which is the number the far end has to tolerate. */
export function countMLines(sdp: string | null | undefined): number {
  if (!sdp) return 0;
  return sdp.split("\n").filter((line) => line.startsWith("m=")).length;
}

export class LoopbackCall {
  readonly local: RTCPeerConnection;
  readonly remote: RTCPeerConnection;

  /** The decoded far-end track per lane, once it arrives. The demo renders these. */
  readonly remoteTracks = new Map<Lane, MediaStreamTrack>();

  /**
   * `negotiationneeded` firings on the sending peer *after* the first
   * offer/answer settled. Decision 4's whole payoff is that this stays at
   * zero when a screen share starts mid-call: the m-line already exists, so
   * `replaceTrack` needs no renegotiation.
   */
  private renegotiationsNeeded = 0;
  private negotiated = false;
  private closed = false;
  private readonly transceivers = new Map<Lane, RTCRtpTransceiver>();
  private readonly onRemoteTrack: LoopbackOptions["onRemoteTrack"];

  constructor(options: LoopbackOptions = {}) {
    this.onRemoteTrack = options.onRemoteTrack;
    // No ICE servers on purpose: both ends are this process, host candidates
    // are all that is needed, and a STUN lookup would make the suite depend on
    // the network. If an engine ever fails to connect here, that is the
    // finding — do not paper over it with a TURN server.
    this.local = new RTCPeerConnection({ iceServers: [] });
    this.remote = new RTCPeerConnection({ iceServers: [] });

    for (const lane of LANE_ORDER) {
      // Created before the first offer, in order, so lane index === m-line
      // index on every engine regardless of what is live.
      this.transceivers.set(
        lane,
        this.local.addTransceiver(LANE_KIND[lane], { direction: "sendonly" }),
      );
    }

    this.local.addEventListener("icecandidate", (event) => {
      const candidate = (event as RTCPeerConnectionIceEvent).candidate;
      if (candidate) void this.remote.addIceCandidate(candidate).catch(() => undefined);
    });
    this.remote.addEventListener("icecandidate", (event) => {
      const candidate = (event as RTCPeerConnectionIceEvent).candidate;
      if (candidate) void this.local.addIceCandidate(candidate).catch(() => undefined);
    });

    this.local.addEventListener("negotiationneeded", () => {
      if (this.negotiated) this.renegotiationsNeeded += 1;
    });

    this.remote.addEventListener("track", (event) => {
      const trackEvent = event as RTCTrackEvent;
      const index = this.remote.getTransceivers().indexOf(trackEvent.transceiver);
      const lane = laneOf(index);
      if (!lane) return;
      this.remoteTracks.set(lane, trackEvent.track);
      this.onRemoteTrack?.({ lane, track: trackEvent.track });
    });
  }

  /** One full offer/answer. Safe to call again — that is what a renegotiation is. */
  async negotiate(): Promise<void> {
    const offer = await this.local.createOffer();
    await this.local.setLocalDescription(offer);
    await this.remote.setRemoteDescription(offer);
    const answer = await this.remote.createAnswer();
    await this.remote.setLocalDescription(answer);
    await this.local.setRemoteDescription(answer);
    this.negotiated = true;
  }

  /** Resolves once both peers report `connected`. Rejects on `failed`, never hangs silently. */
  async waitUntilConnected(timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const a = this.local.connectionState;
      const b = this.remote.connectionState;
      if (a === "connected" && b === "connected") return;
      if (a === "failed" || b === "failed") {
        throw new Error(`loopback ICE failed (local=${a}, remote=${b})`);
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `loopback never connected within ${timeoutMs}ms (local=${a}, remote=${b}, ` +
            `iceLocal=${this.local.iceConnectionState}, iceRemote=${this.remote.iceConnectionState})`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  sender(lane: Lane): RTCRtpSender | null {
    return this.transceivers.get(lane)?.sender ?? null;
  }

  /**
   * The `onLocalTrackChanged` hook's other half. `replaceTrack` is the whole
   * point: a device switch reaches the peer connection without a
   * renegotiation, which is the bug SPEC.md § Ground truth describes when the
   * hook is not wired at all.
   */
  async publish(lane: Lane, track: unknown): Promise<void> {
    const sender = this.sender(lane);
    if (!sender) throw new Error(`no sender for lane ${lane}`);
    await sender.replaceTrack(underlyingTrack(track));
  }

  senderTrackId(lane: Lane): string | null {
    return this.sender(lane)?.track?.id ?? null;
  }

  /**
   * What `SmallWebRTCTransport.closePeerConnection()` does to sender tracks.
   *
   * Reproduced verbatim rather than described, because decision 1 exists
   * entirely to survive it: if the manager published capture tracks instead of
   * clones, this line would kill the live microphone, and a reconnect
   * (`attemptReconnection(true)` builds the new PC *before* closing the old
   * one) would take the call's audio with it.
   */
  stopSenderTracks(): void {
    for (const lane of LANE_ORDER) this.sender(lane)?.track?.stop();
  }

  /** Decision 8, applied. Reads back through `getParameters()` so a dropped field shows up as a `null`. */
  async applyEncoding(lane: Lane, policy: EncodingPolicy): Promise<AppliedParameters> {
    const sender = this.sender(lane);
    const result: AppliedParameters = {
      lane,
      requested: policy,
      hasSender: !!sender,
      error: null,
      encodingCount: 0,
      degradationPreference: null,
      maxFramerate: null,
      maxBitrate: null,
    };
    if (!sender) return result;

    const parameters = sender.getParameters();
    // Firefox hands back `encodings: []` before the first negotiation, and
    // setParameters refuses an encoding list whose length changed — so seed one
    // rather than push into an empty array.
    if (!parameters.encodings || parameters.encodings.length === 0) {
      parameters.encodings = [{}];
    }
    const encoding = parameters.encodings[0]!;
    encoding.maxBitrate = policy.maxBitrate;
    // `maxFramerate` is meaningless for audio, and ENCODING_POLICY records it
    // as 0 there rather than omitting it so every entry has one shape.
    if (policy.maxFramerate > 0) encoding.maxFramerate = policy.maxFramerate;
    // Top-level per the current spec. It moved there from the per-encoding
    // position, and engines disagree about which one they read — set the
    // spec-current place and let the read-back say what stuck.
    parameters.degradationPreference = policy.degradationPreference;

    try {
      await sender.setParameters(parameters);
    } catch (error) {
      result.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }

    const applied = sender.getParameters();
    result.encodingCount = applied.encodings?.length ?? 0;
    const first = applied.encodings?.[0];
    result.maxBitrate = first?.maxBitrate ?? null;
    result.maxFramerate = first?.maxFramerate ?? null;
    result.degradationPreference = applied.degradationPreference ?? null;
    return result;
  }

  /** m-lines in the offer this peer sent. Decision 4 says this is 3 and stays 3. */
  mLineCount(): number {
    return countMLines(this.local.localDescription?.sdp);
  }

  /** Transceiver directions, in m-line order, for a case that wants the shape rather than the numbers. */
  transceiverShape(): Array<{
    index: number;
    lane: Lane | null;
    kind: string;
    direction: string;
    mid: string | null;
  }> {
    return this.local.getTransceivers().map((transceiver, index) => ({
      index,
      lane: laneOf(index),
      // `receiver.track.kind` is the reliable one: `sender.track` is null on a
      // lane with nothing published, and a transceiver has no `kind` of its own.
      kind: transceiver.receiver.track.kind,
      direction: transceiver.direction,
      mid: transceiver.mid,
    }));
  }

  renegotiationCount(): number {
    return this.renegotiationsNeeded;
  }

  connectionStates(): { local: string; remote: string; iceLocal: string; iceRemote: string } {
    return {
      local: this.local.connectionState,
      remote: this.remote.connectionState,
      iceLocal: this.local.iceConnectionState,
      iceRemote: this.remote.iceConnectionState,
    };
  }

  /** Both ends of every lane, in one pass. */
  async stats(): Promise<Record<Lane, LaneStats>> {
    const out = {} as Record<Lane, LaneStats>;
    const remoteTransceivers = this.remote.getTransceivers();
    for (const [index, lane] of LANE_ORDER.entries()) {
      const transceiver = this.transceivers.get(lane)!;
      const receiver = remoteTransceivers[index]?.receiver ?? null;
      out[lane] = await this.laneStats(lane, transceiver, receiver);
    }
    return out;
  }

  private async laneStats(
    lane: Lane,
    transceiver: RTCRtpTransceiver,
    receiver: RTCRtpReceiver | null,
  ): Promise<LaneStats> {
    const track = transceiver.sender.track;
    const stats: LaneStats = {
      lane,
      mid: transceiver.mid,
      direction: transceiver.direction,
      currentDirection: transceiver.currentDirection,
      senderTrackId: track?.id ?? null,
      senderTrackKind: track?.kind ?? null,
      senderTrackEnabled: track ? track.enabled : null,
      senderTrackReadyState: track ? track.readyState : null,
      framesEncoded: null,
      framesSent: null,
      frameWidth: null,
      frameHeight: null,
      framesPerSecond: null,
      packetsSent: 0,
      bytesSent: 0,
      targetBitrate: null,
      qualityLimitationReason: null,
      codec: null,
      framesDecoded: null,
      framesReceived: null,
      inboundFrameWidth: null,
      inboundFrameHeight: null,
      packetsReceived: 0,
      bytesReceived: 0,
      audioLevel: null,
      audioLevelSource: "none",
    };

    // Per-sender / per-receiver getStats rather than the connection-wide report:
    // it needs no ssrc bookkeeping, and ssrc-to-lane mapping is exactly the kind
    // of guess this file exists to avoid.
    const outbound = await this.safeStats(transceiver.sender);
    if (outbound) {
      const codecs = new Map<string, string>();
      outbound.forEach((report) => {
        if (report.type === "codec") codecs.set(report.id, String(report.mimeType ?? ""));
      });
      outbound.forEach((report) => {
        if (report.type !== "outbound-rtp") return;
        stats.framesEncoded = numberOrNull(report.framesEncoded) ?? stats.framesEncoded;
        stats.framesSent = numberOrNull(report.framesSent) ?? stats.framesSent;
        stats.frameWidth = numberOrNull(report.frameWidth) ?? stats.frameWidth;
        stats.frameHeight = numberOrNull(report.frameHeight) ?? stats.frameHeight;
        stats.framesPerSecond = numberOrNull(report.framesPerSecond) ?? stats.framesPerSecond;
        stats.packetsSent = numberOrNull(report.packetsSent) ?? stats.packetsSent;
        stats.bytesSent = numberOrNull(report.bytesSent) ?? stats.bytesSent;
        stats.targetBitrate = numberOrNull(report.targetBitrate) ?? stats.targetBitrate;
        if (typeof report.qualityLimitationReason === "string") {
          stats.qualityLimitationReason = report.qualityLimitationReason;
        }
        const codecId = typeof report.codecId === "string" ? report.codecId : null;
        if (codecId && codecs.has(codecId)) stats.codec = codecs.get(codecId) ?? null;
      });
    }

    if (receiver) {
      const inbound = await this.safeStats(receiver);
      if (inbound) {
        inbound.forEach((report) => {
          if (report.type !== "inbound-rtp") return;
          stats.framesDecoded = numberOrNull(report.framesDecoded) ?? stats.framesDecoded;
          stats.framesReceived = numberOrNull(report.framesReceived) ?? stats.framesReceived;
          stats.inboundFrameWidth = numberOrNull(report.frameWidth) ?? stats.inboundFrameWidth;
          stats.inboundFrameHeight = numberOrNull(report.frameHeight) ?? stats.inboundFrameHeight;
          stats.packetsReceived = numberOrNull(report.packetsReceived) ?? stats.packetsReceived;
          stats.bytesReceived = numberOrNull(report.bytesReceived) ?? stats.bytesReceived;
          const level = numberOrNull(report.audioLevel);
          if (level !== null) {
            stats.audioLevel = level;
            stats.audioLevelSource = "inbound-rtp";
          }
        });
      }
      // A zero counts as missing here, not as silence. Measured 2026-09-07 in
      // real Chrome: `inbound-rtp.audioLevel` is a hard **0** on a lane whose
      // `getSynchronizationSources()[0].audioLevel` reads 0.126 at the same
      // instant, on the same receiver, with 200 packets received. A meter that
      // trusted the first number would sit dead in the browser most people
      // will open. WebKit populates `inbound-rtp` properly and never reaches
      // this branch. Reading the header extension the receiver already parsed
      // is still the *receiving* side and still not Web Audio (decision 7).
      if ((stats.audioLevel === null || stats.audioLevel === 0) && lane === "audio") {
        const sources = receiver.getSynchronizationSources?.() ?? [];
        const level = sources[0]?.audioLevel;
        if (typeof level === "number" && level > 0) {
          stats.audioLevel = level;
          stats.audioLevelSource = "synchronization-source";
        }
      }
    }

    return stats;
  }

  private async safeStats(endpoint: RTCRtpSender | RTCRtpReceiver): Promise<RTCStatsReport | null> {
    try {
      return await endpoint.getStats();
    } catch {
      return null;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.local.close();
    this.remote.close();
    this.remoteTracks.clear();
  }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Can this engine connect a peer connection to itself at all?
 *
 * Measured 2026-09-07 and it is not a hypothetical: Playwright's Firefox
 * gathers **zero** ICE candidates on this host — `iceGatheringState` never
 * leaves `"new"`, no `icecandidate` event ever fires, the offer carries
 * `c=IN IP4 0.0.0.0` and no `a=candidate` line, and both peers reach `failed`
 * in well under a second. It reproduces with exactly what is below — a bare
 * data channel, no media at all — so it is not this manager, not the encoding
 * policy and not a track. See `playwright.config.ts` for the prefs that were
 * tried and did nothing.
 *
 * Deliberately media-free and deliberately short-fused: every peer-connection
 * case gates on this, so it must be cheap, and an engine that cannot do it
 * must produce a **named skip** rather than a silent pass.
 */
export async function probeLoopbackSupport(timeoutMs = 3_000): Promise<boolean> {
  if (typeof RTCPeerConnection === "undefined") return false;
  const a = new RTCPeerConnection({ iceServers: [] });
  const b = new RTCPeerConnection({ iceServers: [] });
  try {
    a.addEventListener("icecandidate", (event) => {
      const candidate = (event as RTCPeerConnectionIceEvent).candidate;
      if (candidate) void b.addIceCandidate(candidate).catch(() => undefined);
    });
    b.addEventListener("icecandidate", (event) => {
      const candidate = (event as RTCPeerConnectionIceEvent).candidate;
      if (candidate) void a.addIceCandidate(candidate).catch(() => undefined);
    });
    a.createDataChannel("probe");
    const offer = await a.createOffer();
    await a.setLocalDescription(offer);
    await b.setRemoteDescription(offer);
    const answer = await b.createAnswer();
    await b.setLocalDescription(answer);
    await a.setRemoteDescription(answer);

    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (a.connectionState === "connected" && b.connectionState === "connected") return true;
      if (a.connectionState === "failed" || b.connectionState === "failed") return false;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } catch {
    return false;
  } finally {
    a.close();
    b.close();
  }
}
