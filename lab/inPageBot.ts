/**
 * An agent in the page: answers `SmallWebRTCTransport`'s offers at a fake
 * endpoint, with a peer connection of its own that speaks an oscillator on the
 * audio lane. Enough of the server for the transport to run a real call and a
 * real rebuild — a new offer with `restart_pc`, a new peer connection on both
 * sides, the old one closed — without one.
 *
 * It answers through `fetch`, which is how pipecat's client sends the offer,
 * and only for its own endpoint. The transport is built with
 * `waitForICEGathering`, so every candidate is in the offer; the PATCH that
 * still trickles them afterwards is acknowledged and dropped.
 */

export interface InPageBot {
  endpoint: string;
  /** Every offer the transport sent, in order. */
  offers: Array<{ at: number; pcId: unknown; restart: unknown }>;
  /** The bot's current peer connection. */
  pc(): RTCPeerConnection | null;
  stop(): Promise<void>;
}

export async function startInPageBot(): Promise<InPageBot> {
  const endpoint = `${location.origin}/__in-page-bot`;
  const context = new AudioContext();
  const oscillator = context.createOscillator();
  const destination = context.createMediaStreamDestination();
  oscillator.connect(destination);
  oscillator.start();
  const voice = destination.stream.getAudioTracks()[0]!;

  const offers: InPageBot["offers"] = [];
  const pcs: RTCPeerConnection[] = [];
  let serial = 0;

  const answer = async (offer: {
    sdp: string;
    type: RTCSdpType;
  }): Promise<RTCSessionDescriptionInit> => {
    // The server's half of a rebuild: the old connection goes when the new
    // one is answered, as pipecat's `renegotiate(restart_pc=True)` does.
    const previous = pcs.at(-1);
    const pc = new RTCPeerConnection();
    pcs.push(pc);
    await pc.setRemoteDescription(offer);
    const audio = pc.getTransceivers()[0]!;
    audio.direction = "sendrecv";
    await audio.sender.replaceTrack(voice);
    await pc.setLocalDescription(await pc.createAnswer());
    if (pc.iceGatheringState !== "complete") {
      await new Promise<void>((resolve) => {
        pc.addEventListener("icegatheringstatechange", () => {
          if (pc.iceGatheringState === "complete") resolve();
        });
      });
    }
    previous?.close();
    return pc.localDescription!.toJSON();
  };

  const realFetch = window.fetch;
  window.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.url !== endpoint) return realFetch(input, init);
    if (request.method === "PATCH") return Response.json({});
    const body = (await request.json()) as {
      sdp: string;
      type: RTCSdpType;
      pc_id: unknown;
      restart_pc: unknown;
    };
    offers.push({ at: performance.now(), pcId: body.pc_id, restart: body.restart_pc });
    const description = await answer(body);
    return Response.json({ ...description, pc_id: `bot-${++serial}` });
  };

  return {
    endpoint,
    offers,
    pc: () => pcs.at(-1) ?? null,
    async stop() {
      window.fetch = realFetch;
      for (const pc of pcs) pc.close();
      oscillator.stop();
      await context.close();
    },
  };
}
