import { webWatchesFromConfig } from "@muse/proactivity";
import { MessagingProviderError, MessagingProviderRegistry, type MessagingProvider, type OutboundMessage, type OutboundReceipt } from "@muse/messaging";
import { describe, expect, it } from "vitest";

import { startWebWatchTick } from "../src/web-watch-tick.js";

// A provider that fails transiently (retryable 503) on its first N sends,
// then succeeds — proving the sink retries instead of dropping the notice.
function flakyProvider(failures: number, sent: OutboundMessage[]): MessagingProvider {
  let calls = 0;
  return {
    describe: () => ({ description: "t", displayName: "T", id: "telegram" }),
    id: "telegram",
    async send(message: OutboundMessage): Promise<OutboundReceipt> {
      calls += 1;
      if (calls <= failures) {
        throw new MessagingProviderError("telegram", "UPSTREAM_FAILED", "transient 503", 503);
      }
      sent.push(message);
      return { destination: message.destination, messageId: "m1", providerId: "telegram" };
    }
  };
}

function sequenceFetch(bodies: Array<{ status: number; body: string }>) {
  let i = 0;
  return (async () => new Response(bodies[Math.min(i++, bodies.length - 1)]!.body, { status: bodies[Math.min(i - 1, bodies.length - 1)]!.status })) as unknown as typeof globalThis.fetch;
}

const CONFIG = JSON.stringify([
  { id: "w", message: "Your order shipped", rule: { appears: "shipped" }, title: "Order", url: "https://x.test/o" }
]);

describe("web-watch tick sink — survives a transient messaging-provider failure (P19)", () => {
  it("a fired notice is delivered after a transient 503, not silently dropped", async () => {
    const watches = webWatchesFromConfig(CONFIG, {
      fetchImpl: sequenceFetch([{ body: "processing", status: 200 }, { body: "shipped", status: 200 }]),
      retryOptions: { baseDelayMs: 0, sleep: async () => {} }
    });
    const sent: OutboundMessage[] = [];
    const handle = startWebWatchTick({
      destination: "555",
      providerId: "telegram",
      registry: new MessagingProviderRegistry([flakyProvider(1, sent)]), // first send 503s, retry succeeds
      watches
    });
    try {
      await handle.tickOnce(); // processing baseline
      await handle.tickOnce(); // shipped → fire; first send 503s, sendWithRetry retries → delivered
    } finally {
      handle.stop();
    }
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("Your order shipped");
  });
});
