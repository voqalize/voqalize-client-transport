/**
 * `createVoqalizeClient()` — pipecat's `PipecatClient`, over our transport,
 * handed back as `VoqalizeClient` (`src/clientTypes.ts`).
 *
 * Types only: the object is a `PipecatClient` and nothing wraps it. That keeps
 * the rule in the voqalize repo's CLAUDE.md (no client wrapper over pipecat's
 * client) while an app imports nothing from pipecat. The checks marked
 * below are the compile-time proof that every member and event we promise is
 * one pipecat has.
 */

import { DeviceError, PipecatClient, RTVIEvent } from "@pipecat-ai/client-js";
import type { Participant, RTVIEvents } from "@pipecat-ai/client-js";

import type {
  AppProtocol,
  DeviceProblem,
  UntypedProtocol,
  VoqalizeClient,
  VoqalizeEvents,
} from "./clientTypes";
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
}

/**
 * Every member but `hasLiveCall` (the transport's) and the event methods,
 * which are checked event by event below: what a `PipecatClient` must be
 * assignable to.
 */
type PipecatMembers = Omit<VoqalizeClient, "hasLiveCall" | "on" | "off">;

/**
 * The event check. Each event we offer is one pipecat emits, and its handler
 * is given what pipecat passes or a narrowing of it: our payload and pipecat's
 * must be assignable one way or the other. Narrowing is how a payload is typed
 * to what gato sends (`ErrorMessage.data`) and to an app's protocol, where
 * pipecat says `unknown` or `any`; an unrelated type (`command: number`) fails.
 */
type Related<A, B> = [A] extends [B] ? true : [B] extends [A] ? true : false;
type PipecatHandlers = Required<RTVIEvents>;
type EventCheck = {
  [K in keyof VoqalizeEvents]: K extends keyof PipecatHandlers
    ? Related<Parameters<VoqalizeEvents[K]>, Parameters<PipecatHandlers[K]>>
    : false;
};
const everyEventIsPipecats: { [K in keyof VoqalizeEvents]: true } = {} as EventCheck;
void everyEventIsPipecats;

/**
 * The client for one page. `connect()` it with the `sessions.connect`
 * response body. Pass your `AppProtocol` as `P` to type the actions, UI
 * events, client messages and server messages you exchange with your brain.
 *
 * ```ts
 * import { createVoqalizeClient } from "@voqalize/client-transport";
 *
 * const client = createVoqalizeClient({ audio: document.querySelector("audio")! });
 * client.on("uiCommand", ({ command, payload }) => run(command, payload));
 * await client.connect(await (await fetch("/api/voice/start", { method: "POST" })).json());
 * ```
 */
export function createVoqalizeClient<P extends AppProtocol = UntypedProtocol>(
  options: VoqalizeClientOptions = {},
): VoqalizeClient<P> {
  const { enableMic = true, keepAcrossPageLoads = false, audio } = options;
  const mediaManager = new VoqalizeMediaManager();
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

  // The member check: a PipecatClient has every member we promise. A
  // protocol `P` narrows payloads only, which pipecat passes through unread.
  const supported: PipecatMembers = client;
  return Object.defineProperty(supported, "hasLiveCall", {
    get: () => transport.hasLiveCall,
    enumerable: true,
  }) as unknown as VoqalizeClient<P>;
}

/** Whether `error` is a microphone or speaker the browser would not give us. */
export function isDeviceError(error: unknown): error is DeviceProblem {
  return error instanceof DeviceError;
}
