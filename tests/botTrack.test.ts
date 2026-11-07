/**
 * `tracks().bot.audio`: the agent's voice as it arrives, read from whichever
 * peer connection is current, and absent when there is none.
 */
import { describe, expect, it } from "vitest";

import { FakeMediaDevices, FakeMediaStreamTrack } from "../lab/fakeMediaDevices";
import { VoqalizeMediaManager } from "../src/mediaManager";
import { createVoqalizeTransport } from "../src/transport";

function manager(): VoqalizeMediaManager {
  return new VoqalizeMediaManager({ mediaDevices: new FakeMediaDevices() });
}

function fakePc(track: FakeMediaStreamTrack | null, state = "connected") {
  return {
    connectionState: state,
    getReceivers: () => (track ? [{ track }] : []),
  };
}

describe("the agent's audio in tracks()", () => {
  it("is absent with no source", () => {
    expect(manager().tracks().bot).toBeUndefined();
  });

  it("is the source's live track", () => {
    const m = manager();
    const voice = new FakeMediaStreamTrack("audio", "agent");
    m.setBotAudioSource(() => voice);
    expect(m.tracks().bot?.audio).toBe(voice);
  });

  it("is absent once the track has ended, or the source throws", () => {
    const m = manager();
    const voice = new FakeMediaStreamTrack("audio", "agent");
    m.setBotAudioSource(() => voice);
    voice.stop();
    expect(m.tracks().bot).toBeUndefined();
    m.setBotAudioSource(() => {
      throw new Error("moved");
    });
    expect(m.tracks().bot).toBeUndefined();
  });

  it("is absent after destroy", async () => {
    const m = manager();
    m.setBotAudioSource(() => new FakeMediaStreamTrack("audio", "agent"));
    await m.destroy();
    expect(m.tracks().bot).toBeUndefined();
  });

  it("follows the transport's current peer connection", () => {
    const m = manager();
    const transport = createVoqalizeTransport({ mediaManager: m });
    const internals = transport as unknown as { pc: unknown };
    expect(m.tracks().bot).toBeUndefined();

    const first = new FakeMediaStreamTrack("audio", "agent");
    internals.pc = fakePc(first);
    expect(m.tracks().bot?.audio).toBe(first);
    // The same answer through the transport, which is what a client calls.
    expect(transport.tracks().bot?.audio).toBe(first);

    // A network change: a new connection and a new track.
    const second = new FakeMediaStreamTrack("audio", "agent");
    internals.pc = fakePc(second);
    expect(m.tracks().bot?.audio).toBe(second);

    internals.pc = fakePc(second, "closed");
    expect(m.tracks().bot).toBeUndefined();
  });
});
