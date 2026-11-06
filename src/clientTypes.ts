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
 * Every member but `hasLiveCall` is a `PipecatClient` member of the same name
 * and a compatible type, and every event one pipecat emits. `src/client.ts`
 * checks both: a member here that pipecat lacks or types incompatibly, or an
 * event whose payload is unrelated to pipecat's, fails the build.
 * `hasLiveCall` is the transport's, and is put on the instance.
 *
 * The payload types are pipecat 1.13.1's, field for field, narrowed to what
 * gato sends where pipecat's are wider: an error's `data` is `{error, fatal}`
 * where pipecat says `unknown`.
 *
 * An app may describe its own protocol with the brain — the actions it
 * dispatches, the UI events and client messages it handles, the server
 * messages it sends — as an `AppProtocol`, and pass it to
 * `createVoqalizeClient<P>()`. The client then checks those names and
 * payloads. Nothing checks them at runtime: the brain is the app's own code,
 * and the protocol is the app's statement of what it sends.
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

/** One relay the browser may use, as `RTCIceServer` spells it. */
export interface IceServerParams {
  urls: string[];
  username: string;
  credential: string;
}

/**
 * What `connect()` takes: the `sessions.connect` response body, as
 * `JSON.parse` returns it. With `keepAcrossPageLoads`, `connect()` with no
 * argument rejoins the session this tab already holds.
 */
export interface SessionParams {
  /** Where the browser sends its offer, and what it presents there. */
  webrtc_request_params: {
    endpoint: string;
    headers: Record<string, string> | Headers;
  };
  session_id: string;
  /** The node's relay. Absent or null for a node with none. */
  ice_config?: { iceServers: IceServerParams[] } | null;
}

/**
 * What the agent said it is, on `botReady` and from `connect()`. `version` is
 * the RTVI protocol version the server speaks.
 */
export interface BotReady {
  version: string;
  about?: unknown;
}

/**
 * The app's protocol with its brain. Every key is optional; one left out is
 * untyped (any name, `unknown` payload).
 *
 * ```ts
 * interface Shop extends AppProtocol {
 *   actions: { show_product: { sku: string }; open_cart: null };
 *   uiEvents: { added_to_cart: { sku: string; qty: number } };
 * }
 * const client = createVoqalizeClient<Shop>();
 * client.on("uiCommand", (a) => a.command === "show_product" && show(a.payload.sku));
 * ```
 */
export interface AppProtocol {
  /** What the brain's `dispatch(Action(...))` sends: name → payload (`uiCommand`). */
  actions?: Record<string, unknown>;
  /** What `sendUIEvent()` sends to the brain's `on_ui_event`: name → payload. */
  uiEvents?: Record<string, unknown>;
  /** What `sendClientMessage()` sends to the brain: type → data. */
  clientMessages?: Record<string, unknown>;
  /** What the brain's `send_rtvi()` sends (`serverMessage`). */
  serverMessage?: unknown;
}

/** No protocol: every name is allowed and every payload is `unknown`. */
export interface UntypedProtocol {
  actions: Record<string, unknown>;
  uiEvents: Record<string, unknown>;
  clientMessages: Record<string, unknown>;
  serverMessage: unknown;
}

type Untyped = Record<string, unknown>;
/** A protocol's actions, or any name when it states none. */
export type ActionsOf<P extends AppProtocol> = P extends { actions: infer A extends Untyped }
  ? A
  : Untyped;
/** A protocol's UI events, or any name when it states none. */
export type UIEventsOf<P extends AppProtocol> = P extends { uiEvents: infer E extends Untyped }
  ? E
  : Untyped;
/** A protocol's client messages, or any type when it states none. */
export type ClientMessagesOf<P extends AppProtocol> = P extends {
  clientMessages: infer M extends Untyped;
}
  ? M
  : Untyped;
/** A protocol's server message, or `unknown` when it states none. */
export type ServerMessageOf<P extends AppProtocol> = P extends { serverMessage: infer S }
  ? S
  : unknown;

/** The argument list for a payload: optional only when it may be undefined. */
type PayloadArg<T> = undefined extends T ? [payload?: T] : [payload: T];

/**
 * An action the brain dispatched to the page (`uiCommand`). With a protocol,
 * a union with one member per action, so checking `command` narrows `payload`.
 */
export type ActionData<A extends Record<string, unknown> = Untyped> = {
  [K in keyof A & string]: { command: K; payload: A[K] };
}[keyof A & string];

/**
 * How far the agent has spoken a piece of `botOutput`. `"new"` is the first
 * time a segment is seen; `"in-progress"` carries `spoken_progress`.
 */
export type SpokenStatus = "new" | "in-progress" | "completed";

/** What the agent said, or is about to say (`botOutput`). */
export interface AgentOutput {
  text: string;
  /** `"sentence"` or `"word"`; another string for an aggregation pipecat adds. */
  aggregated_by?: "sentence" | "word" | (string & {});
  /** The segment this output belongs to; outputs of one segment share it. */
  segment_id?: number;
  /** Whether this text goes to speech, or is display only. */
  will_be_spoken?: boolean;
  /** @deprecated RTVI 1.4 only; gato sends `will_be_spoken`. */
  spoken?: boolean;
  spoken_status?: SpokenStatus;
  /** With `spoken_status` `"in-progress"`: what has been spoken and what is left. */
  spoken_progress?: { accumulated_text: string; remaining_text: string };
}

/** What the user said (`userTranscript`). `final` is false while it may change. */
export interface UserTranscript {
  text: string;
  final: boolean;
  /** ISO 8601. */
  timestamp: string;
  user_id: string;
}

/** An error the server reported (`error`), as the RTVI message carrying it. */
export interface ErrorMessage {
  id: string;
  label: string;
  type: "error";
  data: {
    error: string;
    /** True when the server is ending the session because of it. */
    fatal: boolean;
  };
}

/** Which kind of device a `DeviceProblem` is about. */
export type DeviceKind = "cam" | "mic" | "speaker";

/** Why a device could not be used. */
export type DeviceProblemType =
  "in-use" | "permissions" | "undefined-mediadevices" | "not-found" | "constraints" | "unknown";

/**
 * A microphone or speaker that could not be used (`deviceError`, and what
 * `isDeviceError()` recognises). `type` is why, `devices` is which kinds.
 */
export interface DeviceProblem extends Error {
  readonly type: DeviceProblemType;
  readonly devices: DeviceKind[];
  readonly details: Record<string, string | boolean | number | Error> | undefined;
}

/** Whose track it is: `local` is the user's, otherwise the agent's. */
export interface ParticipantInfo {
  id: string;
  name: string;
  local: boolean;
}

/** The events `on()` and `off()` accept, and what each handler is given. */
export interface VoqalizeEvents<P extends AppProtocol = UntypedProtocol> {
  connected: () => void;
  disconnected: () => void;
  transportStateChanged: (state: ConnectionState) => void;
  botReady: (data: BotReady) => void;
  error: (message: ErrorMessage) => void;
  serverMessage: (data: ServerMessageOf<P>) => void;
  uiCommand: (action: ActionData<ActionsOf<P>>) => void;
  botOutput: (output: AgentOutput) => void;
  botTtsText: (data: { text: string }) => void;
  userTranscript: (transcript: UserTranscript) => void;
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

/** The tracks of a session: the user's microphone and the agent's audio. */
export interface SessionTracks {
  local: { audio?: MediaStreamTrack };
  bot?: { audio?: MediaStreamTrack };
}

/** What `createVoqalizeClient()` returns. */
export interface VoqalizeClient<P extends AppProtocol = UntypedProtocol> {
  /**
   * Join the session: pass the `sessions.connect` response body. Resolves
   * when the agent is ready. With no argument, rejoins the session this tab
   * holds (`hasLiveCall`).
   */
  connect(session?: SessionParams): Promise<BotReady>;
  /** Close this page's connection. The session ends when the agent's side does. */
  disconnect(): Promise<void>;
  /** End the session for everyone. Call before `disconnect()` on "End". */
  disconnectBot(): void;
  readonly state: ConnectionState;
  /**
   * With `keepAcrossPageLoads`, whether this tab holds a session it has not
   * ended: call `connect()` with no argument to rejoin it. Always false
   * without the option.
   */
  readonly hasLiveCall: boolean;
  on<K extends keyof VoqalizeEvents<P>>(event: K, handler: VoqalizeEvents<P>[K]): this;
  off<K extends keyof VoqalizeEvents<P>>(event: K, handler: VoqalizeEvents<P>[K]): this;
  /** An event for the brain's `on_ui_event`. */
  sendUIEvent<K extends keyof UIEventsOf<P> & string>(
    event: K,
    ...payload: PayloadArg<UIEventsOf<P>[K]>
  ): void;
  /** A message for the brain, which it reads as a `client-message`. */
  sendClientMessage<K extends keyof ClientMessagesOf<P> & string>(
    type: K,
    ...data: PayloadArg<ClientMessagesOf<P>[K]>
  ): void;
  /** Text the brain receives as if the user had said it. */
  sendText(content: string): Promise<unknown>;
  enableMic(enable: boolean): void;
  readonly isMicEnabled: boolean;
  /** True until `initDevices()` has run; device lists are empty before it. */
  needsInit(): boolean;
  initDevices(): Promise<void>;
  getAllMics(): Promise<MediaDeviceInfo[]>;
  getAllSpeakers(): Promise<MediaDeviceInfo[]>;
  /** The microphone in use, or `{}` before one is chosen. */
  readonly selectedMic: MediaDeviceInfo | Record<string, never>;
  /** The speaker in use, or `{}` before one is chosen. */
  readonly selectedSpeaker: MediaDeviceInfo | Record<string, never>;
  updateMic(deviceId: string): void;
  updateSpeaker(deviceId: string): void;
  tracks(): SessionTracks;
  /**
   * The transport, opaque. The avatar and Stage read the live peer connection
   * from it (`transport.pc`, an `RTCPeerConnection` or null), which this
   * package keeps working because it bundles the transport at a fixed version.
   */
  readonly transport: unknown;
}
