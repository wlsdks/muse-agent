import { describe, expect, it } from "vitest";

import { DiscordProvider } from "../src/discord-provider.js";
import { MessagingProviderError, MessagingValidationError } from "../src/errors.js";

// Contract-faithful HTTP fake: records every request and returns a Response the
// real Discord REST API would (per outbound-safety.md — drive the REAL code
// path against a contract-faithful fake, assert the resulting state, never a
// stubbed registry).
function recordingFetch(responder: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ init, url });
    return responder(url, init);
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetchImpl };
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });

describe("DiscordProvider.send — outbound (contract-faithful fake)", () => {
  it("POSTs to the channel messages endpoint with Bot auth and returns a receipt", async () => {
    const { calls, fetchImpl } = recordingFetch(() => json({ id: "msg-123" }));
    const provider = new DiscordProvider({ baseUrl: "https://fake.test/api", fetch: fetchImpl, token: "tok" });
    const receipt = await provider.send({ destination: "chan-1", text: "hello world" });

    expect(receipt).toEqual({ destination: "chan-1", messageId: "msg-123", providerId: "discord", raw: { id: "msg-123" } });
    expect(calls[0]!.url).toBe("https://fake.test/api/v10/channels/chan-1/messages");
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bot tok");
  });

  it("suppresses ALL mention resolution so a literal @everyone in agent output can't ping the server", async () => {
    const { calls, fetchImpl } = recordingFetch(() => json({ id: "m" }));
    const provider = new DiscordProvider({ fetch: fetchImpl, token: "t" });
    await provider.send({ destination: "c", text: "ping @everyone now" });
    const body = JSON.parse(calls[0]!.init.body as string) as { content: string; allowed_mentions: { parse: string[] } };
    expect(body.content).toBe("ping @everyone now"); // text shown verbatim
    expect(body.allowed_mentions).toEqual({ parse: [] }); // but resolves no mentions
  });

  it("truncates to Discord's 2000-char hard limit (a 2001..4096 message would otherwise 400)", async () => {
    const { calls, fetchImpl } = recordingFetch(() => json({ id: "m" }));
    const provider = new DiscordProvider({ fetch: fetchImpl, token: "t" });
    await provider.send({ destination: "c", text: "x".repeat(2500) });
    expect((JSON.parse(calls[0]!.init.body as string) as { content: string }).content.length).toBe(2000);
  });

  it("rejects an empty message at validation BEFORE any network call (no spurious send)", async () => {
    const { calls, fetchImpl } = recordingFetch(() => json({ id: "m" }));
    const provider = new DiscordProvider({ fetch: fetchImpl, token: "t" });
    await expect(provider.send({ destination: "c", text: "   " })).rejects.toBeInstanceOf(MessagingValidationError);
    expect(calls).toHaveLength(0);
  });

  it("maps a non-OK API response to UPSTREAM_FAILED carrying the status + Discord error message", async () => {
    const { fetchImpl } = recordingFetch(() => json({ code: 50001, message: "Missing Access" }, 403));
    const provider = new DiscordProvider({ fetch: fetchImpl, token: "t" });
    const err = await provider.send({ destination: "c", text: "hi" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MessagingProviderError);
    expect((err as MessagingProviderError).code).toBe("UPSTREAM_FAILED");
    expect((err as MessagingProviderError & { status?: number }).status).toBe(403);
    expect((err as Error).message).toContain("Missing Access");
  });

  it("treats an OK response with no message id as an upstream failure (no silent fake receipt)", async () => {
    const { fetchImpl } = recordingFetch(() => json({}));
    const provider = new DiscordProvider({ fetch: fetchImpl, token: "t" });
    const err = await provider.send({ destination: "c", text: "hi" }).catch((e: unknown) => e);
    expect((err as MessagingProviderError).code).toBe("UPSTREAM_FAILED");
    expect((err as Error).message).toContain("missing message id");
  });
});

describe("DiscordProvider.fetchInbound — inbound (snapshot mode)", () => {
  it("requires a channel id (source) — INVALID_DESTINATION otherwise, never a guessed channel", async () => {
    const { calls, fetchImpl } = recordingFetch(() => json([]));
    const provider = new DiscordProvider({ fetch: fetchImpl, token: "t" });
    const err = await provider.fetchInbound({}).catch((e: unknown) => e);
    expect((err as MessagingProviderError).code).toBe("INVALID_DESTINATION");
    expect(calls).toHaveLength(0);
  });

  it("parses channel messages, filtering empty-content entries and preferring global_name as the sender", async () => {
    const messages = [
      { author: { global_name: "Bob B", username: "bob" }, channel_id: "chan-1", content: "hi there", id: "1002", timestamp: "2026-05-31T10:00:00Z" },
      { author: { username: "empty" }, channel_id: "chan-1", content: "", id: "1003" },
      { author: { username: "carol" }, channel_id: "chan-1", content: "older", id: "1001" }
    ];
    const { fetchImpl } = recordingFetch(() => json(messages));
    const provider = new DiscordProvider({ fetch: fetchImpl, token: "t" });
    const inbound = await provider.fetchInbound({ source: "chan-1" });

    expect(inbound).toHaveLength(2); // the empty-content entry is dropped
    expect(inbound[0]).toMatchObject({ messageId: "1002", providerId: "discord", sender: "Bob B", source: "chan-1", text: "hi there" });
    // username is the fallback when global_name is absent
    expect(inbound[1]!.sender).toBe("carol");
  });

  it("maps a non-OK inbound response to UPSTREAM_FAILED with the status", async () => {
    const { fetchImpl } = recordingFetch(() => json({ message: "Server Error" }, 500));
    const provider = new DiscordProvider({ fetch: fetchImpl, token: "t" });
    const err = await provider.fetchInbound({ source: "c" }).catch((e: unknown) => e);
    expect((err as MessagingProviderError).code).toBe("UPSTREAM_FAILED");
    expect((err as MessagingProviderError & { status?: number }).status).toBe(500);
  });
});
