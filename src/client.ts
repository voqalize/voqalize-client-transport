/**
 * `createVoqalizeClient()` — pipecat's `PipecatClient`, over our transport,
 * handed back as `VoqalizeSession` (`src/clientTypes.ts`).
 *
 * Types only: the object is a `PipecatClient` and nothing wraps it. That keeps
 * the rule in the voqalize repo's CLAUDE.md (no client wrapper over pipecat's
 * client) while an app imports nothing from pipecat. The assignment marked
 * below is the compile check that every member we promise is one pipecat has.
 */

import { DeviceError, PipecatClient, RTVIEvent } from "@pipecat-ai/client-js";
import type { Participant } from "@pipecat-ai/client-js";

import type { DeviceProblem, VoqalizeClient, VoqalizeSession } from "./clientTypes";
import { VoqalizeMediaManager } from "./mediaManager";
import { createVoqalizeTransport } from "./transport";

export interface VoqalizeClientOptions {
  /** Open the microphone when the session connects. Default true. */
  enableMic?: boolean;
  /**
   * Keep the session across a reload or a link to another page of the same
   * site: see `hasLiveCall`. Default false.
   */
  keepAcrossPageLoads?: boolean;
  /**
   * The element the agent plays on. The client gives it the agent's audio
   * when it arrives, routes it to the speaker `updateSpeaker()` chose, and
   * restarts it when a browser blocks or stalls playback. Left out, play the
   * agent yourself from the `trackStarted` event.
   */
  audio?: HTMLAudioElement;
  /** Your own manager, when the app needs it before the client exists. */
  mediaManager?: VoqalizeMediaManager;
}

/**
 * The client for one page. `connect()` it with the `sessions.connect`
 * response body.
 *
 * ```ts
 * import { createVoqalizeClient } from "@voqalize/client-transport";
 *
 * const client = createVoqalizeClient({ audio: document.querySelector("audio")! });
 * client.on("uiCommand", ({ command, payload }) => run(command, payload));
 * await client.connect(await (await fetch("/api/voice/start", { method: "POST" })).json());
 * ```
 */
export function createVoqalizeClient(options: VoqalizeClientOptions = {}): VoqalizeSession {
  const { enableMic = true, keepAcrossPageLoads = false, audio } = options;
  const mediaManager = options.mediaManager ?? new VoqalizeMediaManager();
  const transport = createVoqalizeTransport({ mediaManager, keepAcrossPageLoads });
  const client = new PipecatClient({ transport, enableMic });

  if (audio) {
    mediaManager.bindOutputElement(audio);
    const playing = (): MediaStreamTrack | undefined =>
      audio.srcObject instanceof MediaStream ? audio.srcObject.getAudioTracks()[0] : undefined;
    client.on(RTVIEvent.TrackStarted, (track: MediaStreamTrack, participant?: Participant) => {
      if (participant?.local || track.kind !== "audio" || playing()?.id === track.id) return;
      audio.srcObject = new MediaStream([track]);
      void mediaManager.playOutput(audio);
    });
    client.on(RTVIEvent.TrackStopped, (track: MediaStreamTrack, participant?: Participant) => {
      if (participant?.local || track.kind !== "audio") return;
      if (playing()?.id === track.id) audio.srcObject = null;
    });
  }

  // The boundary check: a PipecatClient is a VoqalizeClient.
  const supported: VoqalizeClient = client;
  return Object.defineProperty(supported, "hasLiveCall", {
    get: () => transport.hasLiveCall,
    enumerable: true,
  }) as VoqalizeSession;
}

/** Whether `error` is a microphone or speaker the browser would not give us. */
export function isDeviceError(error: unknown): error is DeviceProblem {
  return error instanceof DeviceError;
}
