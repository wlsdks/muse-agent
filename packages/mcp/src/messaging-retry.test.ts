import { MessagingProviderError, type MessagingProvider, type MessagingProviderRegistry, type OutboundReceipt } from "@muse/messaging";
import { describe, expect, it, vi } from "vitest";

import { sendWithRetry } from "@muse/mcp-shared";

function fakeRegistry(send: (providerId: string, message: { destination: string; text: string }) => Promise<OutboundReceipt>): MessagingProviderRegistry {
  return {
    send,
    require: (id: string) => ({ id }) as unknown as MessagingProvider
  } as unknown as MessagingProviderRegistry;
}

const okReceipt = (): OutboundReceipt => ({ messageId: "ok", providerId: "tg", destination: "u" });

describe("sendWithRetry", () => {
  it("resolves on the first successful attempt — no backoff burned", async () => {
    const send = vi.fn(async () => okReceipt());
    await sendWithRetry(fakeRegistry(send), "tg", { destination: "u", text: "hi" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("retries through a transient failure and resolves on the second attempt", async () => {
    let calls = 0;
    const send = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        throw new MessagingProviderError("tg", "UPSTREAM_FAILED", "503", 503);
      }
      return okReceipt();
    });
    await sendWithRetry(fakeRegistry(send), "tg", { destination: "u", text: "hi" });
    expect(calls).toBe(2);
  });

  it("attempts at most 3 times and rethrows the last retryable error", async () => {
    const send = vi.fn(async () => {
      throw new MessagingProviderError("tg", "UPSTREAM_FAILED", "503", 503);
    });
    await expect(sendWithRetry(fakeRegistry(send), "tg", { destination: "u", text: "hi" }))
      .rejects.toThrow(/503/);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("short-circuits on a non-retryable MessagingProviderError (no burn of the backoff ladder)", async () => {
    const send = vi.fn(async () => {
      throw new MessagingProviderError("tg", "INVALID_DESTINATION", "bad chat");
    });
    await expect(sendWithRetry(fakeRegistry(send), "tg", { destination: "u", text: "hi" }))
      .rejects.toThrow(/bad chat/);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("retries a generic Error (no .retryable property defaults to retried — transient network errors fit)", async () => {
    let calls = 0;
    const send = vi.fn(async () => {
      calls += 1;
      if (calls < 2) throw new Error("ECONNRESET");
      return okReceipt();
    });
    await sendWithRetry(fakeRegistry(send), "tg", { destination: "u", text: "hi" });
    expect(calls).toBe(2);
  });
});
