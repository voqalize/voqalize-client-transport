/**
 * Plain-object headers, accepted. Internal; `createVoqalizeTransport()`
 * installs it on every transport it builds.
 *
 * `SmallWebRTCTransport@1.10.8` builds the offer request with
 * `Object.fromEntries((request.headers ?? new Headers()).entries())`. A
 * `Headers` has `entries()`; the object `JSON.parse` gives back for
 * `{"headers": {"Authorization": "…"}}` does not, so a page that passes the
 * `sessions.connect` response straight to `connect()` threw a `TypeError` that
 * never mentions headers. Every app wrote the same one-line conversion.
 *
 * This does it once, in the two places a request reaches the transport: the
 * constructor's `webrtcRequestParams`, and the params `connect()` validates and
 * hands to `_connect`. The base class has already turned
 * `webrtc_request_params` into `webrtcRequestParams` by then. A `Headers`, an
 * array of pairs and an absent field pass through as they were.
 *
 * `_connect` and `_webrtcRequest` are not in the transport's `.d.ts`. If a
 * pipecat release renames `_connect`, plain headers stop working again and a
 * `Headers` still does; the call itself is unaffected.
 */

interface Hookable {
  _connect?: (params?: unknown) => Promise<void>;
  _webrtcRequest?: unknown;
}

/** A request with its `headers` as a `Headers`, or the value unchanged. */
export function withRealHeaders<T>(request: T): T {
  if (typeof request !== "object" || request === null) return request;
  const headers = (request as { headers?: unknown }).headers;
  if (
    headers === undefined ||
    headers === null ||
    typeof headers !== "object" ||
    (typeof Headers !== "undefined" && headers instanceof Headers)
  ) {
    return request;
  }
  return { ...request, headers: new Headers(headers as HeadersInit) };
}

function withRealHeadersInParams(params: unknown): unknown {
  if (typeof params !== "object" || params === null) return params;
  const request = (params as { webrtcRequestParams?: unknown }).webrtcRequestParams;
  if (request === undefined) return params;
  const fixed = withRealHeaders(request);
  return fixed === request ? params : { ...params, webrtcRequestParams: fixed };
}

export function acceptPlainHeaders(transport: object): void {
  const hooks = transport as Hookable;
  hooks._webrtcRequest = withRealHeaders(hooks._webrtcRequest);
  const connect = hooks._connect;
  if (typeof connect !== "function") return;
  hooks._connect = function (this: unknown, params?: unknown) {
    return connect.call(this, withRealHeadersInParams(params));
  };
}
