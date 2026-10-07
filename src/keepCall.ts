/**
 * Keeping a call across full page loads. Internal;
 * `createVoqalizeTransport({ keepAcrossPageLoads: true })` installs it.
 *
 * ## What a rejoin is
 *
 * A full page load closes the peer connection. A server that holds a closed
 * call for a while, and takes a fresh offer with the same request as the same
 * call coming back, lets the next page carry on where the last one stopped:
 * the new page calls `connect()` with the request the old page connected with,
 * and nothing else. A new transport has no peer-connection id, so the offer
 * reads as a rejoin, not as a renegotiation of a connection the server has
 * already dropped.
 *
 * Stock pipecat can do this by hand: keep the connect params somewhere that
 * survives the load and pass them to `connect()` again. This module is that
 * bookkeeping, done once:
 *
 * - **Save** the request every `connect()` resolves to, in `sessionStorage`,
 *   before the offer goes out, so a load in the middle of connecting still
 *   finds it.
 * - **Reuse** it when `connect()` is called with no request of its own. A
 *   request the app passes always wins, and replaces what was saved.
 * - **Forget** it when the call ends: the app's `disconnectBot()`, or a server
 *   that refuses the offer (any 4xx, on connect or on a reconnect; pipecat does
 *   not tell a 410 apart from the rest, and none of them can be retried).
 *
 * It never starts a call by itself, and it never hangs up on `pagehide`: the
 * page going away is exactly what it is for. `hasLiveCall` is the app's cue to
 * call `connect()` on load.
 *
 * `sessionStorage` is per tab and per origin, so a second tab starts its own
 * call, and the saved request (which carries the session's credentials) never
 * leaves the origin that made it. Every access is guarded: a private window or
 * blocked storage means no rejoin, never an error.
 *
 * It reaches three members of `SmallWebRTCTransport` that its `.d.ts` does not
 * declare: `_connect` (the base class's `connect()` validates the params and
 * hands them here), `stop` (where a refused reconnect ends up) and
 * `sendMessage` (which carries `disconnect-bot`). If a pipecat release renames
 * `_connect`, the feature switches itself off and says so; the call itself is
 * unaffected.
 */

import { logger } from "@pipecat-ai/client-js";

const STORAGE_KEY = "voqalize-client-transport:call";
const DISCONNECT_BOT = "disconnect-bot";

/** Where the saved request lives. `sessionStorage` in a page; a fake in a test. */
export interface CallStore {
  read(): string | null;
  write(value: string): void;
  clear(): void;
}

/** The members of `SmallWebRTCTransport` this module wraps. */
interface Hookable {
  _connect?: (params?: unknown) => Promise<void>;
  stop?: (error?: unknown) => Promise<void>;
  sendMessage?: (message: unknown) => void;
  _webrtcRequest?: unknown;
}

/** The request as stored: everything `APIRequest` holds, made JSON. */
interface SavedCall {
  webrtcRequestParams: {
    endpoint: string;
    headers?: Array<[string, string]>;
    requestData?: unknown;
    timeout?: number;
  };
  iceConfig?: unknown;
}

export function sessionCallStore(): CallStore {
  const storage = (): Storage | null => {
    try {
      return globalThis.sessionStorage ?? null;
    } catch {
      return null; // Some engines throw on the property read itself.
    }
  };
  return {
    read() {
      try {
        return storage()?.getItem(STORAGE_KEY) ?? null;
      } catch {
        return null;
      }
    },
    write(value) {
      try {
        storage()?.setItem(STORAGE_KEY, value);
      } catch {
        // Full or blocked: this page keeps its call, the next one starts anew.
      }
    },
    clear() {
      try {
        storage()?.removeItem(STORAGE_KEY);
      } catch {
        // As above.
      }
    },
  };
}

/**
 * Install the bookkeeping on `transport`. Returns whether this tab holds a call
 * it has not ended, read fresh from the store on every call.
 */
export function keepCallAcrossPageLoads(transport: object, store: CallStore): () => boolean {
  const hooks = transport as Hookable;
  const hasLiveCall = () => restore(store.read()) !== null;

  const connect = hooks._connect;
  if (typeof connect !== "function") {
    logger.warn("[voqalize] keepAcrossPageLoads is off: this pipecat transport has no _connect");
    return () => false;
  }

  hooks._connect = function (this: Hookable, params?: unknown) {
    let effective = params;
    if (!hasRequest(params)) {
      const saved = restore(store.read());
      if (saved) effective = { ...(isObject(params) ? params : {}), ...saved };
    }
    const request = hasRequest(effective)
      ? (effective as { webrtcRequestParams: unknown }).webrtcRequestParams
      : this._webrtcRequest;
    const iceConfig = isObject(effective) ? effective.iceConfig : undefined;
    const saved = serialize(request, iceConfig);
    if (saved) store.write(JSON.stringify(saved));
    // A `Request` endpoint cannot be written down; nothing stale may stay
    // behind it either.
    else store.clear();
    return connect.call(this, effective);
  };

  const stop = hooks.stop;
  if (typeof stop === "function") {
    hooks.stop = function (this: Hookable, error?: unknown) {
      if (isRefusal(error)) store.clear();
      return stop.call(this, error);
    };
  }

  const sendMessage = hooks.sendMessage;
  if (typeof sendMessage === "function") {
    hooks.sendMessage = function (this: Hookable, message: unknown) {
      if (isObject(message) && message.type === DISCONNECT_BOT) store.clear();
      return sendMessage.call(this, message);
    };
  }

  return hasLiveCall;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasRequest(params: unknown): boolean {
  return isObject(params) && isObject(params.webrtcRequestParams);
}

/** A 4xx from the offer endpoint, as pipecat reports it: `.status` on the error. */
function isRefusal(error: unknown): boolean {
  const status = isObject(error) ? error.status : undefined;
  return typeof status === "number" && status >= 400 && status < 500;
}

function serialize(request: unknown, iceConfig: unknown): SavedCall | null {
  if (!isObject(request)) return null;
  const { endpoint, headers, requestData, timeout } = request;
  let url: string;
  if (typeof endpoint === "string") url = endpoint;
  else if (typeof URL !== "undefined" && endpoint instanceof URL) url = endpoint.toString();
  else return null;
  const saved: SavedCall = { webrtcRequestParams: { endpoint: url } };
  if (headers !== undefined && headers !== null) {
    const pairs = headerPairs(headers);
    if (!pairs) return null;
    saved.webrtcRequestParams.headers = pairs;
  }
  if (requestData !== undefined) saved.webrtcRequestParams.requestData = requestData;
  if (typeof timeout === "number") saved.webrtcRequestParams.timeout = timeout;
  if (iceConfig !== undefined) saved.iceConfig = iceConfig;
  return saved;
}

function headerPairs(headers: unknown): Array<[string, string]> | null {
  if (typeof Headers !== "undefined" && headers instanceof Headers) return [...headers.entries()];
  if (Array.isArray(headers)) return headers.map(([k, v]) => [String(k), String(v)]);
  if (isObject(headers)) return Object.entries(headers).map(([k, v]) => [k, String(v)]);
  return null;
}

/** The saved request in the shape `_connect` takes, or null for none or garbage. */
function restore(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  let saved: SavedCall;
  try {
    saved = JSON.parse(raw) as SavedCall;
  } catch {
    return null;
  }
  const request = isObject(saved) ? saved.webrtcRequestParams : undefined;
  if (!isObject(request) || typeof request.endpoint !== "string") return null;
  const params: Record<string, unknown> = {
    webrtcRequestParams: {
      ...request,
      headers: request.headers ? new Headers(request.headers) : undefined,
    },
  };
  if (saved.iceConfig !== undefined) params.iceConfig = saved.iceConfig;
  return params;
}
