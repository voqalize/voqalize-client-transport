import { describe, expect, it } from "vitest";

import { acceptPlainHeaders, withRealHeaders } from "../src/headers";

describe("plain-object headers", () => {
  it("become Headers", () => {
    const fixed = withRealHeaders({ endpoint: "e", headers: { Authorization: "Bearer t" } });
    expect(fixed.headers).toBeInstanceOf(Headers);
    expect((fixed.headers as unknown as Headers).get("authorization")).toBe("Bearer t");
  });

  it("leave a Headers, an absent field and a non-object as they were", () => {
    const headers = new Headers({ a: "b" });
    const request = { endpoint: "e", headers };
    expect(withRealHeaders(request)).toBe(request);
    const bare = { endpoint: "e" };
    expect(withRealHeaders(bare)).toBe(bare);
    expect(withRealHeaders(null)).toBe(null);
  });

  it("are fixed in what _connect receives and in the constructor's request", async () => {
    const seen: unknown[] = [];
    const transport = {
      _webrtcRequest: { endpoint: "ctor", headers: { x: "1" } } as unknown,
      async _connect(params?: unknown) {
        seen.push(params);
      },
    };
    acceptPlainHeaders(transport);
    expect((transport._webrtcRequest as { headers: unknown }).headers).toBeInstanceOf(Headers);

    await transport._connect({ webrtcRequestParams: { endpoint: "e", headers: { y: "2" } } });
    await transport._connect(undefined);
    const first = seen[0] as { webrtcRequestParams: { headers: Headers } };
    expect(first.webrtcRequestParams.headers.get("y")).toBe("2");
    expect(seen[1]).toBeUndefined();
  });
});
