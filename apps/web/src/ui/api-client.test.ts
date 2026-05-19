import { afterEach, describe, expect, it } from "vitest";

import { createApiClient } from "./api-client.js";

const realFetch = globalThis.fetch;

function stubFetch(res: {
  ok: boolean;
  status: number;
  statusText?: string;
  json?: () => Promise<unknown>;
}): void {
  globalThis.fetch = (async () => ({
    ok: res.ok,
    status: res.status,
    statusText: res.statusText ?? "",
    json: res.json ?? (async () => ({}))
  })) as unknown as typeof globalThis.fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("createApiClient error surfacing", () => {
  const client = () => createApiClient("http://muse.test", "tok");

  it("surfaces the server's errorMessage, not just the bare status", async () => {
    stubFetch({
      json: async () => ({ errorCode: "UPSTREAM_UNAVAILABLE", errorMessage: "the local model is starting up" }),
      ok: false,
      status: 503,
      statusText: "Service Unavailable"
    });
    await expect(client().get("/api/chat")).rejects.toThrow(
      "503 Service Unavailable: the local model is starting up"
    );
  });

  it("falls back to `message` and omits empty statusText (HTTP/2)", async () => {
    stubFetch({ json: async () => ({ message: "boom" }), ok: false, status: 503, statusText: "" });
    await expect(client().post("/api/x", {})).rejects.toThrow(/^503: boom$/u);
  });

  it("falls back to status when the error body is not JSON (no regression)", async () => {
    stubFetch({
      json: async () => { throw new SyntaxError("not json"); },
      ok: false,
      status: 500,
      statusText: "Internal Server Error"
    });
    await expect(client().get("/api/y")).rejects.toThrow("500 Internal Server Error");
  });

  it("still returns the parsed body on success and undefined on 204", async () => {
    stubFetch({ json: async () => ({ value: 42 }), ok: true, status: 200 });
    expect(await client().get<{ value: number }>("/api/ok")).toEqual({ value: 42 });

    stubFetch({ ok: true, status: 204 });
    expect(await client().delete("/api/gone")).toBeUndefined();
  });
});
