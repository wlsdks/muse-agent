import { describe, expect, it } from "vitest";

import { fetchReadWithRetry } from "../src/provider-helpers.js";

const noSleep = async (): Promise<void> => {};

function sequencedFetch(statuses: readonly number[]): {
  impl: typeof globalThis.fetch;
  calls: () => number;
} {
  let i = 0;
  let n = 0;
  const impl = (async () => {
    n += 1;
    const status = statuses[Math.min(i, statuses.length - 1)]!;
    i += 1;
    return new Response("{}", { status });
  }) as unknown as typeof globalThis.fetch;
  return { calls: () => n, impl };
}

describe("fetchReadWithRetry — idempotent-read retry (poll/getUpdates only)", () => {
  it("retries a transient 503, then returns the eventual 200", async () => {
    const { impl, calls } = sequencedFetch([503, 200]);
    const res = await fetchReadWithRetry(impl, "http://x", { method: "GET" }, { sleep: noSleep });
    expect(res.status).toBe(200);
    expect(calls()).toBe(2);
  });

  it("does NOT retry a non-retriable 400", async () => {
    const { impl, calls } = sequencedFetch([400, 200]);
    const res = await fetchReadWithRetry(impl, "http://x", { method: "GET" }, { sleep: noSleep });
    expect(res.status).toBe(400);
    expect(calls()).toBe(1);
  });

  it("returns the last response after exhausting attempts on a persistent 500", async () => {
    const { impl, calls } = sequencedFetch([500]);
    const res = await fetchReadWithRetry(impl, "http://x", { method: "GET" }, { maxAttempts: 3, sleep: noSleep });
    expect(res.status).toBe(500);
    expect(calls()).toBe(3);
  });

  it("retries a network error, then succeeds", async () => {
    let n = 0;
    const impl = (async () => {
      n += 1;
      if (n === 1) {
        throw new Error("ECONNRESET");
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const res = await fetchReadWithRetry(impl, "http://x", { method: "GET" }, { sleep: noSleep });
    expect(res.status).toBe(200);
    expect(n).toBe(2);
  });
});
