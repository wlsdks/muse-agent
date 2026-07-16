import { afterEach, describe, expect, it, vi } from "vitest";

import { createApiClient } from "./client.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockFetch(impl: (url: string, init: RequestInit) => Response) {
  const spy = vi.fn((url: URL | string, init?: RequestInit) =>
    Promise.resolve(impl(String(url), init ?? {}))
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}

describe("createApiClient", () => {
  it("resolves paths against the base URL and parses JSON", async () => {
    const spy = mockFetch(() => new Response(JSON.stringify({ status: "ok" }), { status: 200 }));
    const client = createApiClient("http://127.0.0.1:3030", "");
    const body = await client.get<{ status: string }>("/api/health");
    expect(body.status).toBe("ok");
    expect(spy.mock.calls[0]?.[0]).toBe("http://127.0.0.1:3030/api/health");
  });

  it("sends a bearer token and JSON body on POST", async () => {
    const spy = mockFetch(() => new Response(JSON.stringify({ id: "t1" }), { status: 200 }));
    const client = createApiClient("http://127.0.0.1:3030", "secret");
    await client.post("/api/tasks", { title: "ship it" });
    const init = spy.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer secret");
    expect(init.body).toBe(JSON.stringify({ title: "ship it" }));
  });

  it("surfaces the server's error message on a non-OK response", async () => {
    mockFetch(() => new Response(JSON.stringify({ errorMessage: "upstream unavailable" }), { status: 503 }));
    const client = createApiClient("http://127.0.0.1:3030", "");
    await expect(client.get("/api/chat")).rejects.toThrow(/upstream unavailable/);
  });

  it("surfaces the API's standard error field on a non-OK response", async () => {
    mockFetch(() => new Response(JSON.stringify({ error: "continuity run not found" }), { status: 404 }));
    const client = createApiClient("http://127.0.0.1:3030", "");
    await expect(client.get("/api/continuity/run")).rejects.toThrow(/continuity run not found/);
  });

  it("returns undefined for 204 No Content (DELETE)", async () => {
    mockFetch(() => new Response(null, { status: 204 }));
    const client = createApiClient("http://127.0.0.1:3030", "");
    await expect(client.del("/api/tasks/1")).resolves.toBeUndefined();
  });

  it("turns a malformed 2xx body into an actionable transport error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>proxy error</html>", { status: 200 })));

    await expect(createApiClient("https://muse.test", "").get("/api/tasks"))
      .rejects.toThrow("Malformed API response (200)");
  });
});
