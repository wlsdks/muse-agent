import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { MessagingProviderError } from "../src/errors.js";
import { readSlackAfter } from "../src/slack-after-store.js";
import { SlackProvider } from "../src/slack-provider.js";

describe("SlackProvider transport and rate-limit contract", () => {
  it("normalizes a timeout-shaped outbound rejection without making an ambiguous POST retryable", async () => {
    const fetchImpl = (async () => { throw new Error("request to Slack timed out after 30000ms"); }) as unknown as typeof globalThis.fetch;
    const provider = new SlackProvider({ fetch: fetchImpl, token: "t" });
    const err = await provider.send({ destination: "C1", text: "hi" }).catch((cause: unknown) => cause) as MessagingProviderError;
    expect(err).toBeInstanceOf(MessagingProviderError);
    expect(err.code).toBe("UPSTREAM_FAILED");
    expect(err.retryable).toBe(false);
  });

  it("normalizes an unreadable successful outbound body instead of issuing a fake receipt", async () => {
    const unreadable = {
      headers: new Headers(),
      ok: true,
      status: 200,
      statusText: "OK",
      text: async (): Promise<string> => { throw new Error("body stream failed"); }
    } as unknown as Response;
    const provider = new SlackProvider({ fetch: async () => unreadable, token: "t" });
    const err = await provider.send({ destination: "C1", text: "hi" }).catch((cause: unknown) => cause) as MessagingProviderError;
    expect(err).toBeInstanceOf(MessagingProviderError);
    expect(err.status).toBe(200);
    expect(err.retryable).toBe(false);
  });

  it("retries a rate-limited inbound read then returns the successful history", async () => {
    let attempts = 0;
    const provider = new SlackProvider({
      fetch: async () => {
        attempts += 1;
        return attempts === 1
          ? new Response(JSON.stringify({ error: "ratelimited", ok: false }), { headers: { "retry-after": "0" }, status: 429 })
          : new Response(JSON.stringify({ messages: [{ text: "after retry", ts: "1700000000.000001", username: "alice" }], ok: true }));
      },
      token: "t"
    });
    const inbound = await provider.fetchInbound({ source: "C1" });
    expect(attempts).toBe(2);
    expect(inbound).toMatchObject([{ messageId: "1700000000.000001", text: "after retry" }]);
  });

  it("retains Retry-After after an inbound rate limit remains exhausted", async () => {
    const provider = new SlackProvider({
      fetch: async () => new Response(JSON.stringify({ error: "ratelimited", ok: false }), { headers: { "retry-after": "0" }, status: 429 }),
      token: "t"
    });
    const err = await provider.fetchInbound({ source: "C1" }).catch((cause: unknown) => cause) as MessagingProviderError;
    expect(err).toBeInstanceOf(MessagingProviderError);
    expect(err.status).toBe(429);
    expect(err.retryAfterMs).toBe(0);
  });

  it("does not persist an out-of-range timestamp as the next history cursor", async () => {
    const directory = await mkdtemp(join(tmpdir(), "muse-slack-cursor-"));
    const afterFile = join(directory, "after.json");
    try {
      const provider = new SlackProvider({
        afterFile,
        fetch: async () => new Response(JSON.stringify({
          messages: [{ text: "malformed external timestamp", ts: "9999999999999999" }],
          ok: true
        })),
        token: "t"
      });
      await provider.pollUpdates({ source: "C1" });
      expect(await readSlackAfter(afterFile, "C1")).toBeUndefined();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
