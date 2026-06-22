import { describe, expect, it } from "vitest";

import { createSearchMcpServer } from "../src/index.js";

const DDG_HTML =
  '<a rel="nofollow" class="result__a" href="https://example.com/a">Example A</a>' +
  '<a class="result__snippet">Snippet A</a>';

function ddgOk(): Response {
  return new Response(DDG_HTML, { status: 200, headers: { "content-type": "text/html" } });
}
function searxOk(): Response {
  return new Response(
    JSON.stringify({ results: [{ title: "Searx A", url: "https://example.com/s", content: "via searxng" }] }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}
function status(code: number): Response {
  return new Response("", { status: code });
}

function sequenceFetch(factories: Array<() => Response>) {
  let index = 0;
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    const factory = factories[Math.min(index, factories.length - 1)]!;
    index += 1;
    return factory();
  }) as unknown as typeof globalThis.fetch;
  return { calls: () => calls, fetchImpl };
}

const noWait = { baseDelayMs: 0, retries: 2, sleep: async (): Promise<void> => {} };

function searchTool(opts: Parameters<typeof createSearchMcpServer>[0]) {
  const server = createSearchMcpServer(opts);
  return server.tools[0]!;
}

describe("muse.search — transient-failure retry-with-backoff (P19 web actuator hardening)", () => {
  it("DDG: recovers from two transient 503s then succeeds on the third attempt", async () => {
    const { calls, fetchImpl } = sequenceFetch([() => status(503), () => status(503), ddgOk]);
    const tool = searchTool({ fetch: fetchImpl, retryOptions: noWait });

    const result = (await tool.execute({ query: "hello" })) as {
      backend?: string;
      total?: number;
      error?: string;
    };

    expect(result.error).toBeUndefined();
    expect(result.backend).toBe("duckduckgo");
    expect(result.total).toBe(1);
    expect(calls()).toBe(3);
  });

  it("DDG: a persistent 503 still surfaces the error after retries are exhausted", async () => {
    const { calls, fetchImpl } = sequenceFetch([() => status(503)]);
    const tool = searchTool({ fetch: fetchImpl, retryOptions: noWait });

    const result = (await tool.execute({ query: "hello" })) as { error?: string; status?: number };

    expect(result.status).toBe(503);
    expect(result.error).toContain("503");
    expect(calls()).toBe(3);
  });

  it("DDG: a 429 is retried, then reported as rate-limited when it persists", async () => {
    const { calls, fetchImpl } = sequenceFetch([() => status(429)]);
    const tool = searchTool({ fetch: fetchImpl, retryOptions: noWait });

    const result = (await tool.execute({ query: "hello" })) as { rateLimited?: boolean; status?: number };

    expect(result.rateLimited).toBe(true);
    expect(result.status).toBe(429);
    expect(calls()).toBe(3);
  });

  it("SearXNG: recovers from a transient 503 then succeeds (preferred backend not abandoned on a blip)", async () => {
    const { calls, fetchImpl } = sequenceFetch([() => status(503), searxOk]);
    const tool = searchTool({
      fetch: fetchImpl,
      retryOptions: noWait,
      searxngUrl: "http://localhost:8888"
    });

    const result = (await tool.execute({ query: "hello" })) as { backend?: string; total?: number };

    expect(result.backend).toBe("searxng");
    expect(result.total).toBe(1);
    expect(calls()).toBe(2);
  });

  it("SearXNG: a permanent failure falls through to the DDG backend", async () => {
    // First 3 calls (searxng + 2 retries) all 404 → undefined → DDG path,
    // which then succeeds. 404 is non-retriable, so searxng tries ONCE.
    const factories = [() => status(404), ddgOk];
    const { calls, fetchImpl } = sequenceFetch(factories);
    const tool = searchTool({
      fetch: fetchImpl,
      retryOptions: noWait,
      searxngUrl: "http://localhost:8888"
    });

    const result = (await tool.execute({ query: "hello" })) as { backend?: string };

    expect(result.backend).toBe("duckduckgo");
    // searxng 404 (no retry, non-retriable) = 1 call, then DDG ok = 1 call.
    expect(calls()).toBe(2);
  });
});
