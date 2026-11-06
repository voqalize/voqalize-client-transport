/**
 * The client an app holds, typed by us.
 *
 * `createVoqalizeClient()` returns pipecat's `PipecatClient`, unchanged at
 * runtime. What changes is the type it is handed back as: `VoqalizeClient`
 * names the members we support and nothing else, in types this file declares
 * itself. **This file imports nothing**, so no pipecat type is reachable from
 * an app that holds a `VoqalizeClient`, and a pipecat release that adds,
 * renames or retypes something does not change what an app sees until we
 * choose to follow it.
 *
 * Every member is a `PipecatClient` member of the same name and a compatible
 * type. `src/client.ts` assigns a `PipecatClient` to a `VoqalizeClient`, and
 * that assignment is the test: a member here that pipecat lacks, or types
 * differently, fails the build. The one member pipecat does not have,
 * `hasLiveCall`, is put on the instance (`VoqalizeSession`).
 *
 * Event and method names are pipecat's (`botReady`, `uiCommand`,
 * `disconnectBot`), because the object is pipecat's and renaming them would
 * mean a wrapper. Names we coin follow the lexicon.
 */

/** Where the connection is. The values `PipecatClient.state` takes. */
export type ConnectionState =
  | "disconnected"
  | "initializing"
  | "initialized"
  | "authenticating"
  | "authenticated"
  | "connecting"
  | "connected"
  | "ready"
  | "disconnecting"
  | "error";

/**
 * What `connect()` takes: the `sessions.connect` response body, as JSON
 * parsed it. Plain-object `headers` are accepted. With `keepAcrossPageLoads`,
 * `connect()` with no argument rejoins the call this tab already holds.
 */
export interface SessionParams {
  webrtc_request_params?: {
    endpoint: string;
    headers?: Record<string, string> | Headers;
    requestData?: unknown;
    timeout?: number;
  };
  [key: string]: unknown;
}

/** An action the brain dispatched to the page (`uiCommand`). */
export interface ActionData {
  command: string;
  payload: unknown;
}

/** What the agent said, or is about to say (`botOutput`). */
export interface AgentOutput {
  text: string;
  aggregated_by?: string;
  spoken?: boolean;
  will_be_spoken?: boolean;
  output_type?: string;
}

/** What the user said (`userTranscript`). `final` is false while it may change. */
export interface UserTranscript {
  text: string;
  final: boolean;
  timestamp: string;
  user_id: string;
}

/** An error the server reported (`error`). */
export interface ErrorMessage {
  type: string;
  data?: unknown;
}

/**
 * A microphone or speaker that could not be used (`deviceError`, and what
 * `isDeviceError()` recognises). `type` is why, `devices` is which kinds.
 */
export interface DeviceProblem extends Error {
  type: string;
  devices: string[];
}

/** Whose track it is: `local` is the user's, otherwise the agent's. */
export interface ParticipantInfo {
  local: boolean;
}

/** The events `on()` and `off()` accept, and what each handler is given. */
export interface VoqalizeEvents {
  connected: () => void;
  disconnected: () => void;
  transportStateChanged: (state: ConnectionState) => void;
  botReady: (data: { version: string }) => void;
  error: (message: ErrorMessage) => void;
  serverMessage: (data: unknown) => void;
  uiCommand: (data: ActionData) => void;
  botOutput: (data: AgentOutput) => void;
  botTtsText: (data: { text: string }) => void;
  userTranscript: (data: UserTranscript) => void;
  botStartedSpeaking: () => void;
  botStoppedSpeaking: () => void;
  userStartedSpeaking: () => void;
  userStoppedSpeaking: () => void;
  userMuteStarted: () => void;
  userMuteStopped: () => void;
  botLlmStarted: () => void;
  botLlmStopped: () => void;
  trackStarted: (track: MediaStreamTrack, participant?: ParticipantInfo) => void;
  trackStopped: (track: MediaStreamTrack, participant?: ParticipantInfo) => void;
  localAudioLevel: (level: number) => void;
  deviceError: (error: DeviceProblem) => void;
  availableMicsUpdated: (mics: MediaDeviceInfo[]) => void;
  availableSpeakersUpdated: (speakers: MediaDeviceInfo[]) => void;
  micUpdated: (mic: MediaDeviceInfo) => void;
  speakerUpdated: (speaker: MediaDeviceInfo) => void;
}

/** The client: the members of `PipecatClient` we support. */
export interface VoqalizeClient {
  /** Join the session. Pass the `sessions.connect` response body. */
  connect(session?: SessionParams): Promise<unknown>;
  /** Close this page's connection. The session ends when the agent's side does. */
  disconnect(): Promise<void>;
  /** End the session for everyone. Call before `disconnect()` on "End". */
  disconnectBot(): void;
  readonly state: ConnectionState;
  on<K extends keyof VoqalizeEvents>(event: K, handler: VoqalizeEvents[K]): this;
  off<K extends keyof VoqalizeEvents>(event: K, handler: VoqalizeEvents[K]): this;
  /** An event for the brain's `on_ui_event`. */
  sendUIEvent(event: string, payload?: unknown): void;
  sendClientMessage(type: string, data?: unknown): void;
  /** Text the brain receives as if the user had said it. */
  sendText(content: string): Promise<unknown>;
  enableMic(enable: boolean): void;
  readonly isMicEnabled: boolean;
  /** True until `initDevices()` has run; device lists are empty before it. */
  needsInit(): boolean;
  initDevices(): Promise<void>;
  getAllMics(): Promise<MediaDeviceInfo[]>;
  getAllSpeakers(): Promise<MediaDeviceInfo[]>;
  readonly selectedMic: { deviceId?: string; label?: string };
  readonly selectedSpeaker: MediaDeviceInfo | Record<string, never>;
  updateMic(deviceId: string): void;
  updateSpeaker(deviceId: string): void;
  tracks(): {
    local: { audio?: MediaStreamTrack };
    bot?: { audio?: MediaStreamTrack };
  };
  /**
   * The transport, opaque. The avatar and Stage read the live peer connection
   * from it (`transport.pc`, an `RTCPeerConnection` or null), which this
   * package keeps working because it bundles the transport at a fixed version.
   */
  readonly transport: unknown;
}

/** What `createVoqalizeClient()` returns. */
export interface VoqalizeSession extends VoqalizeClient {
  /**
   * With `keepAcrossPageLoads`, whether this tab holds a session it has not
   * ended: call `connect()` with no argument to rejoin it. Always false
   * without the option.
   */
  readonly hasLiveCall: boolean;
}
