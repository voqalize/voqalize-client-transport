/**
 * The page-side surface for `e2e/factory.spec.ts`.
 *
 * `createVoqalizeTransport()` is the one thing in this package a consumer
 * actually calls, and it is also the one thing the contract suite cannot
 * reach: the contract drives a `VoqalizeMediaManager` directly, by design, so
 * that tier 1 can run the same bodies in node. Everything the factory adds —
 * that the injection takes, that `initDevices()` runs through *our* manager,
 * and above all that the `replaceTrack` wiring the stock transport only
 * performs for its own default manager really does move a mid-call device
 * switch onto a live sender — is proven here, against a real `SmallWebRTCTransport`
 * and real `RTCPeerConnection`s in a real engine.
 *
 * No signalling server is involved. The transport is never `_connect()`ed;
 * what is exercised is the wiring, which is what the factory is.
 */

import { PipecatClient } from "@pipecat-ai/client-js";

import type { SmallWebRTCTransport } from "@pipecat-ai/small-webrtc-transport";

import { createVoqalizeTransport, attachTrackChangedHandler } from "../src/transport";
import { VoqalizeMediaManager } from "../src/mediaManager";

interface Built {
  client: PipecatClient;
  transport: SmallWebRTCTransport;
  manager: VoqalizeMediaManager;
  pc: RTCPeerConnection | null;
}

let built: Built | null = null;

function current(): Built {
  if (!built) throw new Error("call build() first");
  return built;
}

const factory = {
  /**
   * Exactly the four lines a consumer writes, and no more. The transport is
   * handed to a real `PipecatClient`, because that is what calls
   * `transport.initialize()` — without it the transport's own `state` setter
   * throws on the first assignment, and a harness that constructed the
   * transport alone would be testing a shape no application ever holds.
   *
   * Nothing connects: `webrtcRequestParams` points at a route that does not
   * exist, and no test here calls `connect()`.
   */
  async build(): Promise<void> {
    await factory.teardown();
    const transport = createVoqalizeTransport({
      webrtcRequestParams: { endpoint: "http://127.0.0.1:5183/__never" },
    });
    const client = new PipecatClient({ transport, enableMic: true, enableCam: false });
    // The manager the transport holds; `injected()` proves it is ours.
    const manager = (transport as unknown as { mediaManager: VoqalizeMediaManager }).mediaManager;
    built = { client, transport, manager, pc: null };
  },

  async teardown(): Promise<void> {
    if (!built) return;
    built.pc?.close();
    await built.manager.destroy();
    built = null;
  },

  /**
   * Did the injection take? Answered by identity, not by behaviour, because a
   * transport that silently fell back to its own default manager would still
   * pass every behavioural assertion below, while running code this package
   * exists to replace.
   *
   * `foreignScripts` is the second half of that: every script the page has
   * actually loaded, from any origin but its own. The list must be empty —
   * nothing in the media path may fetch code at runtime.
   */
  injected(): { ours: boolean; constructorName: string; foreignScripts: string[] } {
    const { transport } = current();
    const held = (transport as unknown as { mediaManager: unknown }).mediaManager;
    return {
      ours: held instanceof VoqalizeMediaManager,
      constructorName: (held as object).constructor.name,
      foreignScripts: performance
        .getEntriesByType("resource")
        .filter((entry) => (entry as PerformanceResourceTiming).initiatorType === "script")
        .map((entry) => entry.name)
        .filter((url) => new URL(url, location.href).origin !== location.origin),
    };
  },

  /** `PipecatClient.initDevices()` reaches the manager, and the manager acquires. */
  async initDevices(): Promise<{ micLabel: string; readyState: string; kind: string }> {
    const { client, transport } = current();
    await client.initDevices();
    const track = transport.tracks().local.audio;
    if (!track) throw new Error("no local audio track after initDevices()");
    return { micLabel: track.label, readyState: track.readyState, kind: track.kind };
  },

  async getAllMics(): Promise<number> {
    return (await current().client.getAllMics()).length;
  },

  /**
   * Stand in for the peer connection the transport builds on connect, then
   * switch the microphone and report what the sender ends up carrying.
   *
   * `withGetter` chooses which of `findSender`'s two paths runs: with it, the
   * `getAudioTransceiver()` the shipped transport actually has; without it,
   * the standards-only fallback that matches the sender by the track it is
   * currently carrying. Both are shipped code and both are exercised, because
   * the fallback is what protects a future pipecat release from breaking this.
   */
  async switchMicOnLiveSender(
    withGetter: boolean,
  ): Promise<{ before: string | null; after: string | null; published: string | null }> {
    const { transport, manager } = current();

    const pc = new RTCPeerConnection();
    built!.pc = pc;
    const transceiver = pc.addTransceiver("audio", { direction: "sendonly" });

    const internals = transport as unknown as {
      pc: RTCPeerConnection;
      getAudioTransceiver?: () => RTCRtpTransceiver;
    };
    internals.pc = pc;
    if (withGetter) internals.getAudioTransceiver = () => transceiver;
    else delete internals.getAudioTransceiver;

    // What `addUserMedia()` does on connect: publish what the manager holds.
    const initial = manager.tracks().local.audio ?? null;
    await transceiver.sender.replaceTrack(initial as MediaStreamTrack | null);
    const before = transceiver.sender.track?.id ?? null;

    // The mid-call device switch. This is the event nothing wires for an
    // injected manager unless the factory does it.
    const mics = await manager.getAllMics();
    const other = mics.find((m) => m.deviceId !== "" && m.deviceId !== "default") ?? mics[0];
    await manager.updateMic(other!.deviceId);

    return {
      before,
      after: transceiver.sender.track?.id ?? null,
      published: manager.tracks().local.audio?.id ?? null,
    };
  },

  /**
   * The same wiring, attached by hand to a transport the factory did not
   * build — the escape hatch `attachTrackChangedHandler` exists for.
   */
  async attachByHand(): Promise<boolean> {
    const manager = new VoqalizeMediaManager();
    const pc = new RTCPeerConnection();
    const transceiver = pc.addTransceiver("audio", { direction: "sendonly" });
    const stub = { pc, getAudioTransceiver: () => transceiver };

    attachTrackChangedHandler(stub as never, manager);
    await manager.initialize();
    await manager.enableMic(true);

    const carried = transceiver.sender.track?.id ?? null;
    const published = manager.tracks().local.audio?.id ?? null;
    pc.close();
    await manager.destroy();
    return carried !== null && carried === published;
  },

  /**
   * The playout guard's false-positive check: a real remote audio track,
   * carried over a loopback call and played on a bound element, for `ms`. A
   * healthy element must never be re-attached. The sound is an oscillator, so
   * the check needs no capture device and runs in every engine.
   */
  async healthyPlayout(ms: number): Promise<{
    recoveries: string[];
    paused: boolean;
    samplesAdvanced: boolean;
  }> {
    const recoveries: string[] = [];
    const manager = new VoqalizeMediaManager({
      onPlaybackRecovered: (reason) => recoveries.push(reason),
    });
    const context = new AudioContext();
    const oscillator = context.createOscillator();
    const destination = context.createMediaStreamDestination();
    oscillator.connect(destination);
    oscillator.start();

    const send = new RTCPeerConnection();
    const receive = new RTCPeerConnection();
    send.onicecandidate = (e) => void receive.addIceCandidate(e.candidate ?? undefined);
    receive.onicecandidate = (e) => void send.addIceCandidate(e.candidate ?? undefined);
    const arrived = new Promise<MediaStreamTrack>((resolve) => {
      receive.ontrack = (e) => resolve(e.track);
    });
    send.addTrack(destination.stream.getAudioTracks()[0]!);
    await send.setLocalDescription(await send.createOffer());
    await receive.setRemoteDescription(send.localDescription!);
    await receive.setLocalDescription(await receive.createAnswer());
    await send.setRemoteDescription(receive.localDescription!);

    manager.setStatsSource(() => receive.getStats());
    const audio = document.createElement("audio");
    document.body.append(audio);
    const unbind = manager.bindOutputElement(audio);
    const track = await arrived;
    audio.srcObject = new MediaStream([track]);
    await audio.play().catch(() => undefined);

    const samples = async () => {
      let total = 0;
      (await receive.getStats()).forEach((stat: Record<string, unknown>) => {
        if (stat.type === "inbound-rtp" && typeof stat.totalSamplesReceived === "number") {
          total = stat.totalSamplesReceived;
        }
      });
      return total;
    };
    const before = await samples();
    await new Promise((resolve) => setTimeout(resolve, ms));
    const after = await samples();
    const paused = audio.paused;

    unbind();
    audio.remove();
    send.close();
    receive.close();
    oscillator.stop();
    await context.close();
    await manager.destroy();
    return { recoveries, paused, samplesAdvanced: after > before };
  },
};

export type Factory = typeof factory;

declare global {
  interface Window {
    __factory: Factory;
  }
}

window.__factory = factory;
