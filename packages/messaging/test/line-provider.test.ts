import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { appendInbound } from "../src/inbox-store.js";
import { LineProvider } from "../src/line-provider.js";
import { MessagingProviderError, MessagingValidationError } from "../src/errors.js";

function recordingFetch(responder: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ init, url });
    return responder(url, init);
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetchImpl };
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });
const fixedNow = () => new Date("2026-05-31T12:00:00.000Z");

describe("LineProvider.send — outbound push (contract-faithful fake)", () => {
  it("POSTs the push endpoint with a text message + Bearer auth and synthesises a line:{iso} receipt", async () => {
    const { calls, fetchImpl } = recordingFetch(() => json({})); // LINE returns {} on success
    const provider = new LineProvider({ baseUrl: "https://fake.line", fetch: fetchImpl, now: fixedNow, token: "tok" });
    const receipt = await provider.send({ destination: "U123", text: "hi line" });

    // LINE's push API returns no id, so the provider synthesises one from now()
    // to keep the OutboundReceipt contract uniform across providers.
    expect(receipt).toEqual({ destination: "U123", messageId: "line:2026-05-31T12:00:00.000Z", providerId: "line" });
    expect(calls[0]!.url).toBe("https://fake.line/v2/bot/message/push");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ messages: [{ text: "hi line", type: "text" }], to: "U123" });
  });

  it("rejects an empty message at validation BEFORE any network call", async () => {
    const { calls, fetchImpl } = recordingFetch(() => json({}));
    const provider = new LineProvider({ fetch: fetchImpl, token: "t" });
    await expect(provider.send({ destination: "U", text: "   " })).rejects.toBeInstanceOf(MessagingValidationError);
    expect(calls).toHaveLength(0);
  });

  it("maps a non-OK push response to UPSTREAM_FAILED carrying status + the LINE error message", async () => {
    const { fetchImpl } = recordingFetch(() => json({ message: "Invalid channel access token" }, 401));
    const provider = new LineProvider({ fetch: fetchImpl, token: "t" });
    const err = await provider.send({ destination: "U", text: "hi" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MessagingProviderError);
    expect((err as MessagingProviderError).code).toBe("UPSTREAM_FAILED");
    expect((err as MessagingProviderError & { status?: number }).status).toBe(401);
    expect((err as Error).message).toContain("Invalid channel access token");
  });
});

describe("LineProvider.fetchInbound — persisted webhook inbox", () => {
  it("throws INVALID_DESTINATION when no inboxFile is configured (clean 'not supported', never silent [])", async () => {
    const provider = new LineProvider({ token: "t" });
    const err = await provider.fetchInbound({}).catch((e: unknown) => e);
    expect((err as MessagingProviderError).code).toBe("INVALID_DESTINATION");
  });

  describe("with a persisted inbox file", () => {
    let dir: string;
    let inboxFile: string;

    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), "muse-line-inbox-"));
      inboxFile = join(dir, "inbox.jsonl");
      await appendInbound(inboxFile, { messageId: "1", providerId: "line", receivedAtIso: "2026-05-31T11:00:00Z", source: "U1", text: "first" });
      await appendInbound(inboxFile, { messageId: "2", providerId: "line", receivedAtIso: "2026-05-31T11:01:00Z", source: "U1", text: "second" });
    });

    afterAll(async () => {
      await rm(dir, { force: true, recursive: true });
    });

    it("returns exactly what the webhook handler persisted, newest-first", async () => {
      const provider = new LineProvider({ inboxFile, token: "t" });
      const inbound = await provider.fetchInbound();
      expect(inbound.map((m) => m.text)).toEqual(["second", "first"]);
    });

    it("honours the limit (most-recent N)", async () => {
      const provider = new LineProvider({ inboxFile, token: "t" });
      const inbound = await provider.fetchInbound({ limit: 1 });
      expect(inbound).toHaveLength(1);
      expect(inbound[0]!.text).toBe("second");
    });
  });
});
