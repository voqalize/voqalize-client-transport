/**
 * The transport under test for scenarios 6 and 7.
 *
 * `loopback.ts` proves media *encodes*. It cannot prove media *survives*,
 * because both of its peers live on this host and no test can take the path
 * between them away. This file puts the relay in the middle
 * (`relay/udpRelay.ts`) and then puts pipecat's own recovery state machine on
 * top of it, so the question a test asks is the production one: when the path
 * breaks or moves, does the call come back, and does it come back **with the
 * capture tracks it started with and no second permission prompt**.
 *
 * ## This is `SmallWebRTCTransport`'s state machine, not one of ours
 *
 * Read from `@pipecat-ai/small-webrtc-transport@1.10.6` and reproduced
 * deliberately, because a harness that recovers *better* than the shipping
 * transport proves nothing about the shipping transport:
 *
 * - `iceConnectionState === "failed"` → `attemptReconnection(true)`.
 * - `iceConnectionState === "disconnected"` → wait (pipecat: 5 s), and if it
 *   is *still* disconnected, `attemptReconnection(true)`.
 * - `attemptReconnection(true)` **builds the new peer connection first and
 *   closes the old one after** — `startNewPeerConnection()` then
 *   `closePeerConnection(oldPC)`.
 * - `closePeerConnection` stops every transceiver **and calls
 *   `sender.track.stop()` on every sender**, then closes.
 * - `addUserMedia()` re-publishes by reading `mediaManager.tracks().local` and
 *   `replaceTrack`ing whatever it finds onto the new senders.
 * - `signalingState === "stable"` clears the reconnecting flag *and resets the
 *   attempt counter* — so "max 3 attempts" is really "max 3 attempts that fail
 *   before signalling completes", and a call that renegotiates cleanly but
 *   never connects retries forever. Reproduced as-is; it is a property of the
 *   thing we ship on, not a bug we get to fix here.
 *
 * The last four lines are the whole reason this file exists. Put them in
 * order: the new peer connection is handed the very track objects the old one
 * is about to `stop()`. A manager that publishes its capture tracks loses the
 * microphone on the first reconnect. A manager that publishes a clone loses
 * *the clone* — which is still every frame of the call, on both peer
 * connections, because it is one track object shared between them. Decision 1
 * is necessary and, on its own, not sufficient; what closes the gap is in
 * `voqalizeMediaManager.ts` under "the published clone died but the capture
 * track is alive".
 *
 * One trigger of pipecat's is deliberately absent: `icegatheringstatechange`
 * → complete while still `checking` → `attemptReconnection(false)`. It fires
 * on the *initial* connect against a slow-gathering peer, which is not a
 * scenario on this list, and including it makes a wedged call thrash on a
 * timer instead of on its state.
 */

import { LANE_ORDER, underlyingTrack, countMLines, type Lane } from "./loopback";
import type { RelayHandle } from "./relayClient";
import type { TrackLike } from "../src/mediaPlatform";

/** The three lanes, in m-line order, as the manager hands them over. */
export type PublishedTracks = Partial<Record<Lane, TrackLike | null>>;

const LANE_KIND: Readonly<Record<Lane, "audio" | "video">> = {
  audio: "audio",
  video: "video",
  screenVideo: "video",
};

export interface LabTransportOptions {
  relay: RelayHandle;
  /** What to publish, read fresh on every rebuild — pipecat's `addUserMedia()`. */
  tracks: () => PublishedTracks;
  /**
   * pipecat waits 5 000 ms before acting on `disconnected`. Tests shorten it;
   * the *behaviour* under proof is the transition, not the constant.
   */
  disconnectedGraceMs?: number;
  maxReconnectionAttempts?: number;
  /**
   * Recover with `createOffer({ iceRestart: true })` on the existing peer
   * connection instead of rebuilding it. **Not what pipecat does** — it
   * rebuilds, with a comment saying aiortc would not accept a bare ICE restart
   * — but it is the cheaper path phase 4 has to decide about, and the only
   * honest way to decide is to measure both against the same wedge.
   */
  preferIceRestart?: boolean;
  onEvent?: (event: string) => void;
}

export interface LaneNumbers {
  lane: Lane;
  senderTrackId: string | null;
  senderTrackReadyState: string | null;
  framesEncoded: number | null;
  packetsSent: number;
  packetsReceived: number;
  bytesReceived: number;
}

export interface TransportSnapshot {
  connectionState: string;
  iceConnectionState: string;
  signalingState: string;
  remoteConnectionState: string;
  /** How many peer connections have been built. 1 on a call that never broke. */
  generation: number;
  reconnectionAttempts: number;
  isReconnecting: boolean;
  stopped: boolean;
  mLineCount: number;
  events: string[];
}

interface Generation {
  index: number;
  client: RTCPeerConnection;
  server: RTCPeerConnection;
  transceivers: Map<Lane, RTCRtpTransceiver>;
}

/** Strip trickled candidates so the only address either peer is given is the relay's. */
function stripCandidates(sdp: string): string {
  return sdp
    .split(/\r?\n/)
    .filter((line) => !line.startsWith("a=candidate:") && !line.startsWith("a=end-of-candidates"))
    .join("\r\n");
}

function firstMid(sdp: string | undefined): string {
  const match = /^a=mid:(.+)$/m.exec(sdp ?? "");
  return match?.[1]?.trim() ?? "0";
}

export class LabTransport {
  private generation: Generation | null = null;
  private generationCount = 0;
  private reconnectionAttempts = 0;
  private isReconnecting = false;
  private stopped = false;
  private closed = false;
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private candidateFoundation = 1000;
  private readonly log: string[] = [];

  private readonly graceMs: number;
  private readonly maxAttempts: number;
  private readonly preferIceRestart: boolean;

  constructor(private readonly options: LabTransportOptions) {
    this.graceMs = options.disconnectedGraceMs ?? 5_000;
    this.maxAttempts = options.maxReconnectionAttempts ?? 3;
    this.preferIceRestart = options.preferIceRestart ?? false;
  }

  async connect(): Promise<void> {
    await this.startNewPeerConnection();
  }

  /** Resolves once the client peer reports `connected`; throws rather than hanging. */
  async waitUntilConnected(timeoutMs = 30_000): Promise<void> {
    await this.waitFor(
      () => this.generation?.client.connectionState === "connected",
      timeoutMs,
      "never connected",
    );
  }

  /** Resolves on the first `disconnected`/`failed` — the wedge showing up. */
  async waitUntilBroken(timeoutMs = 30_000): Promise<string> {
    let seen = "";
    await this.waitFor(
      () => {
        const state = this.generation?.client.iceConnectionState ?? "";
        if (state === "disconnected" || state === "failed") {
          seen = state;
          return true;
        }
        return false;
      },
      timeoutMs,
      "the wedge never reached the peer connection",
    );
    return seen;
  }

  async waitForGeneration(index: number, timeoutMs = 30_000): Promise<void> {
    await this.waitFor(
      () => this.generationCount >= index,
      timeoutMs,
      `only ${this.generationCount} peer connections were ever built`,
    );
  }

  snapshot(): TransportSnapshot {
    const client = this.generation?.client;
    return {
      connectionState: client?.connectionState ?? "none",
      iceConnectionState: client?.iceConnectionState ?? "none",
      signalingState: client?.signalingState ?? "none",
      remoteConnectionState: this.generation?.server.connectionState ?? "none",
      generation: this.generationCount,
      reconnectionAttempts: this.reconnectionAttempts,
      isReconnecting: this.isReconnecting,
      stopped: this.stopped,
      mLineCount: countMLines(client?.localDescription?.sdp),
      events: [...this.log],
    };
  }

  async laneNumbers(): Promise<LaneNumbers[]> {
    const generation = this.generation;
    if (!generation) return [];
    const receivers = generation.server.getTransceivers();
    const out: LaneNumbers[] = [];
    for (const [index, lane] of LANE_ORDER.entries()) {
      const transceiver = generation.transceivers.get(lane);
      const track = transceiver?.sender.track ?? null;
      const numbers: LaneNumbers = {
        lane,
        senderTrackId: track?.id ?? null,
        senderTrackReadyState: track?.readyState ?? null,
        framesEncoded: null,
        packetsSent: 0,
        packetsReceived: 0,
        bytesReceived: 0,
      };
      if (transceiver) {
        const outbound = await transceiver.sender.getStats().catch(() => null);
        outbound?.forEach((report) => {
          if (report.type !== "outbound-rtp") return;
          if (typeof report.framesEncoded === "number")
            numbers.framesEncoded = report.framesEncoded;
          if (typeof report.packetsSent === "number") numbers.packetsSent = report.packetsSent;
        });
      }
      const receiver = receivers[index]?.receiver;
      if (receiver) {
        const inbound = await receiver.getStats().catch(() => null);
        inbound?.forEach((report) => {
          if (report.type !== "inbound-rtp") return;
          if (typeof report.packetsReceived === "number") {
            numbers.packetsReceived = report.packetsReceived;
          }
          if (typeof report.bytesReceived === "number")
            numbers.bytesReceived = report.bytesReceived;
        });
      }
      out.push(numbers);
    }
    return out;
  }

  /** Re-publish from the manager onto the *current* senders, as pipecat's `addUserMedia` does. */
  async republish(): Promise<void> {
    if (this.generation) await this.addUserMedia(this.generation);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.clearDisconnectTimer();
    if (this.generation) this.closePeerConnection(this.generation);
    this.generation = null;
  }

  // -- the state machine ------------------------------------------------------

  private async startNewPeerConnection(iceRestart = false): Promise<void> {
    // The relay's ports are read here and nowhere else. After a `rebind` the
    // old ones are closed, so a transport that cached them would rebuild
    // straight back onto a path that no longer exists — which is precisely the
    // failure scenario 6 describes.
    const ports = await this.options.relay.ports();
    this.generationCount += 1;
    const index = this.generationCount;

    const client = new RTCPeerConnection({ iceServers: [] });
    const server = new RTCPeerConnection({ iceServers: [] });
    const transceivers = new Map<Lane, RTCRtpTransceiver>();
    for (const lane of LANE_ORDER) {
      transceivers.set(lane, client.addTransceiver(LANE_KIND[lane], { direction: "sendonly" }));
    }
    const generation: Generation = { index, client, server, transceivers };
    this.generation = generation;
    this.note(`pc:${index}:built`);

    client.addEventListener("iceconnectionstatechange", () => {
      if (this.generation !== generation) return;
      this.note(`ice:${index}:${client.iceConnectionState}`);
      this.handleIceConnectionStateChange(generation);
    });
    client.addEventListener("connectionstatechange", () => {
      if (this.generation !== generation) return;
      this.note(`conn:${index}:${client.connectionState}`);
    });
    client.addEventListener("signalingstatechange", () => {
      if (this.generation !== generation) return;
      if (client.signalingState === "stable") this.handleReconnectionCompleted();
    });

    await this.addUserMedia(generation);
    await this.negotiate(generation, ports.address, ports.portFromA, ports.portFromB, iceRestart);
  }

  /** pipecat's `addUserMedia()`: read the manager's published tracks, replace them in. */
  private async addUserMedia(generation: Generation): Promise<void> {
    const published = this.options.tracks();
    for (const lane of LANE_ORDER) {
      const track = underlyingTrack(published[lane]);
      const sender = generation.transceivers.get(lane)?.sender;
      if (!sender) continue;
      if (track && sender.track === track) continue;
      await sender.replaceTrack(track);
    }
  }

  private async negotiate(
    generation: Generation,
    address: string,
    portFromClient: number,
    portFromServer: number,
    iceRestart: boolean,
  ): Promise<void> {
    const { client, server } = generation;
    const offer = await client.createOffer(iceRestart ? { iceRestart: true } : {});
    await client.setLocalDescription(offer);
    await server.setRemoteDescription({
      type: "offer",
      sdp: stripCandidates(client.localDescription?.sdp ?? offer.sdp ?? ""),
    });
    const answer = await server.createAnswer();
    await server.setLocalDescription(answer);
    await client.setRemoteDescription({
      type: "answer",
      sdp: stripCandidates(server.localDescription?.sdp ?? answer.sdp ?? ""),
    });

    // Neither peer is ever told the other's real address. Each is handed one
    // synthetic host candidate pointing at the relay socket *it* should send
    // to, and BUNDLE carries it for all three m-lines. The address is the
    // relay's, not `127.0.0.1` — Firefox forms no pair against a loopback
    // remote (see `RelayPorts.address`).
    await this.addRelayCandidate(client, address, portFromClient);
    await this.addRelayCandidate(server, address, portFromServer);
  }

  private async addRelayCandidate(
    pc: RTCPeerConnection,
    address: string,
    port: number,
  ): Promise<void> {
    const foundation = this.candidateFoundation++;
    await pc.addIceCandidate({
      candidate: `candidate:${foundation} 1 udp 2130706431 ${address} ${port} typ host`,
      sdpMid: firstMid(pc.remoteDescription?.sdp),
      sdpMLineIndex: 0,
    });
  }

  private handleIceConnectionStateChange(generation: Generation): void {
    if (this.closed) return;
    const state = generation.client.iceConnectionState;
    if (state === "failed") {
      void this.attemptReconnection(true);
      return;
    }
    if (state === "disconnected") {
      this.clearDisconnectTimer();
      this.disconnectTimer = setTimeout(() => {
        this.disconnectTimer = null;
        if (this.closed) return;
        if (
          this.generation === generation &&
          generation.client.iceConnectionState === "disconnected"
        ) {
          void this.attemptReconnection(true);
        }
      }, this.graceMs);
      return;
    }
    // Recovered on its own, which ICE does more often than people expect.
    if (state === "connected" || state === "completed") this.clearDisconnectTimer();
  }

  private handleReconnectionCompleted(): void {
    this.reconnectionAttempts = 0;
    this.isReconnecting = false;
  }

  private async attemptReconnection(recreate: boolean): Promise<void> {
    if (this.closed || this.isReconnecting) return;
    if (this.reconnectionAttempts >= this.maxAttempts) {
      this.note("stopped:max-attempts");
      this.stopped = true;
      await this.close();
      return;
    }
    this.isReconnecting = true;
    this.reconnectionAttempts += 1;
    this.clearDisconnectTimer();

    if (this.preferIceRestart) {
      this.note(`reconnect:${this.reconnectionAttempts}:ice-restart`);
      const generation = this.generation;
      if (!generation) return;
      const ports = await this.options.relay.ports();
      await this.negotiate(generation, ports.address, ports.portFromA, ports.portFromB, true);
      return;
    }

    this.note(`reconnect:${this.reconnectionAttempts}:recreate`);
    const old = this.generation;
    if (recreate) {
      await this.startNewPeerConnection();
      // **After**, exactly as pipecat does it. The new peer connection is
      // already publishing the track objects this is about to stop.
      if (old) this.closePeerConnection(old);
    } else if (old) {
      const ports = await this.options.relay.ports();
      await this.negotiate(old, ports.address, ports.portFromA, ports.portFromB, false);
    }
  }

  /** `SmallWebRTCTransport.closePeerConnection`, line for line, plus the far end. */
  private closePeerConnection(generation: Generation): void {
    for (const transceiver of generation.client.getTransceivers()) {
      if (transceiver.stop) transceiver.stop();
    }
    for (const sender of generation.client.getSenders()) {
      sender.track?.stop();
    }
    generation.client.close();
    generation.server.close();
    this.note(`pc:${generation.index}:closed`);
  }

  private clearDisconnectTimer(): void {
    if (this.disconnectTimer !== null) {
      clearTimeout(this.disconnectTimer);
      this.disconnectTimer = null;
    }
  }

  private note(event: string): void {
    this.log.push(event);
    this.options.onEvent?.(event);
  }

  private async waitFor(
    predicate: () => boolean,
    timeoutMs: number,
    message: string,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (predicate()) return;
      if (Date.now() >= deadline) {
        throw new Error(`${message} (after ${timeoutMs}ms; ${JSON.stringify(this.snapshot())})`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}
