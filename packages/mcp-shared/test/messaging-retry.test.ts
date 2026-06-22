import { MessagingProviderError } from "@muse/messaging";
import { describe, expect, it } from "vitest";

import { sendWithRetry } from "../src/messaging-retry.js";

type Registry = Parameters<typeof sendWithRetry>[0];
const MSG = { destination: "@me", text: "hi" };

/** A registry whose send throws the given errors in order, then succeeds. */
function scriptedRegistry(throwsThenOk: readonly unknown[]): { registry: Registry; attempts: () => number } {
  let i = 0;
  const registry = {
    send: async () => {
      const e = throwsThenOk[i];
      i += 1;
      if (e !== undefined) throw e;
      return { destination: MSG.destination, messageId: "ok", providerId: "p" };
    }
  };
  return { registry: registry as unknown as Registry, attempts: () => i };
}

const rateLimited = (retryAfterMs?: number): MessagingProviderError =>
  new MessagingProviderError("telegram", "UPSTREAM_FAILED", "rate limited", 429, retryAfterMs);

describe("sendWithRetry — honours a 429 Retry-After over the fixed ladder", () => {
  it("waits the server-mandated Retry-After (not the 200ms ladder) before retrying, then delivers", async () => {
    const slept: number[] = [];
    const { registry, attempts } = scriptedRegistry([rateLimited(3000), undefined]);
    await sendWithRetry(registry, "telegram", MSG, { sleep: async (ms) => { slept.push(ms); } });
    expect(slept).toEqual([3000]); // the server hint, NOT BACKOFFS_MS[1]=200
    expect(attempts()).toBe(2); // failed once, then succeeded
  });

  it("caps an absurd Retry-After so a hostile hint can't hang the loop", async () => {
    const slept: number[] = [];
    const { registry } = scriptedRegistry([rateLimited(3_600_000), undefined]); // 1 hour
    await sendWithRetry(registry, "telegram", MSG, { sleep: async (ms) => { slept.push(ms); } });
    expect(slept).toEqual([30_000]); // capped at RETRY_AFTER_CAP_MS
  });

  it("falls back to the fixed backoff ladder when no Retry-After is present (no regression on a plain 5xx)", async () => {
    const slept: number[] = [];
    const transient = new MessagingProviderError("telegram", "UPSTREAM_FAILED", "503", 503);
    const { registry } = scriptedRegistry([transient, transient, undefined]);
    await sendWithRetry(registry, "telegram", MSG, { sleep: async (ms) => { slept.push(ms); } });
    expect(slept).toEqual([200, 800]); // the ladder, unchanged
  });

  it("still short-circuits a non-retryable error without sleeping", async () => {
    const slept: number[] = [];
    const permanent = new MessagingProviderError("telegram", "INVALID_DESTINATION", "bad chat", 400);
    const { registry, attempts } = scriptedRegistry([permanent, undefined]);
    await expect(sendWithRetry(registry, "telegram", MSG, { sleep: async (ms) => { slept.push(ms); } })).rejects.toBe(permanent);
    expect(slept).toEqual([]);
    expect(attempts()).toBe(1);
  });
});
