import { describe, expect, it } from "vitest";

import { createHttpSnapshot, webWatchesFromConfig } from "@muse/proactivity";

const noWait = { baseDelayMs: 0, sleep: async () => {} };

function recordingFetch(body: string, status = 200) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ headers: (init?.headers as Record<string, string>) ?? {}, url: String(url) });
    return new Response(body, { status });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetchImpl };
}

describe("createHttpSnapshot — authenticated page via request headers", () => {
  it("sends the configured Cookie / Authorization header on the snapshot fetch", async () => {
    const { calls, fetchImpl } = recordingFetch("Status: shipped");
    const snapshot = createHttpSnapshot("https://shop.test/orders/42", {
      fetchImpl,
      headers: { authorization: "Bearer tok123", cookie: "session=abc" },
      retryOptions: noWait
    });
    expect(await snapshot()).toBe("Status: shipped");
    expect(calls[0]!.headers["cookie"]).toBe("session=abc");
    expect(calls[0]!.headers["authorization"]).toBe("Bearer tok123");
  });

  it("no headers → a plain unauthenticated GET (no auth leaked)", async () => {
    const { calls, fetchImpl } = recordingFetch("ok");
    await createHttpSnapshot("https://x.test", { fetchImpl, retryOptions: noWait })();
    expect(calls[0]!.headers["cookie"]).toBeUndefined();
  });
});

describe("webWatchesFromConfig — parses per-watch headers for authenticated watches", () => {
  it("builds a watch whose snapshot carries the configured headers", async () => {
    const { calls, fetchImpl } = recordingFetch("Order: shipped");
    const watches = webWatchesFromConfig(
      JSON.stringify([{
        headers: { cookie: "sid=xyz" },
        id: "order",
        message: "shipped",
        rule: { appears: "shipped" },
        title: "Order",
        url: "https://shop.test/orders/42"
      }]),
      { fetchImpl, retryOptions: noWait }
    );
    expect(watches).toHaveLength(1);
    expect(await watches[0]!.snapshot()).toBe("Order: shipped");
    expect(calls[0]!.headers["cookie"]).toBe("sid=xyz");
  });

  it("a non-object / non-string-valued headers field is ignored (still a valid watch)", async () => {
    const { calls, fetchImpl } = recordingFetch("x");
    const watches = webWatchesFromConfig(
      JSON.stringify([{ headers: ["nope"], id: "w", message: "m", rule: { appears: "x" }, title: "t", url: "https://x.test" }]),
      { fetchImpl, retryOptions: noWait }
    );
    expect(watches).toHaveLength(1);
    await watches[0]!.snapshot();
    expect(calls[0]!.headers["0"]).toBeUndefined();
  });
});
