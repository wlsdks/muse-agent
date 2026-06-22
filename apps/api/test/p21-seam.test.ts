import { webWatchesFromConfig } from "@muse/proactivity";
import { MessagingProviderRegistry, type MessagingProvider, type OutboundMessage, type OutboundReceipt } from "@muse/messaging";
import { describe, expect, it } from "vitest";

import { startWebWatchTick } from "../src/web-watch-tick.js";
import { startWebWatchDaemonIfConfigured } from "../src/tick-daemons.js";

function capturingProvider(sent: OutboundMessage[]): MessagingProvider {
  return {
    describe: () => ({ description: "test", displayName: "Test", id: "telegram" }),
    id: "telegram",
    async send(message: OutboundMessage): Promise<OutboundReceipt> {
      sent.push(message);
      return { destination: message.destination, messageId: "m1", providerId: "telegram" };
    }
  };
}

function sequenceFetch(bodies: Array<{ status: number; body: string }>) {
  let i = 0;
  return (async () => {
    const r = bodies[Math.min(i++, bodies.length - 1)]!;
    return new Response(r.body, { status: r.status });
  }) as unknown as typeof globalThis.fetch;
}

const noWait = { baseDelayMs: 0, sleep: async () => {} };

// The literal env string a user would set to "monitor my order page and
// ping me when it ships". The daemon reads exactly this key.
const USER_CONFIG = JSON.stringify([
  { id: "order", message: "Your order has shipped — track it.", rule: { appears: "shipped" }, title: "Order update", url: "https://shop.test/orders/42" }
]);

function fakeServer() {
  const hooks: { name: string; fn: () => unknown }[] = [];
  return {
    hooks,
    server: { addHook: (name: string, fn: () => unknown) => hooks.push({ fn, name }), log: { info: () => undefined, warn: () => undefined } }
  };
}

describe("P21 seam — web-watch composes end-to-end: a user's config → a delivered ping", () => {
  it("the user's MUSE_WEB_WATCH_CONFIG threads parse → HTTP snapshot → detector → runner → real messaging, pinging exactly once on the edge", async () => {
    const env = {
      MUSE_WEB_WATCH_CONFIG: USER_CONFIG,
      MUSE_WEB_WATCH_DESTINATION: "555",
      MUSE_WEB_WATCH_ENABLED: "true",
      MUSE_WEB_WATCH_PROVIDER: "telegram"
    } as unknown as NodeJS.ProcessEnv;

    // Same parse the daemon performs, with a contract-faithful HTTP page
    // that transitions processing → shipped → shipped.
    const watches = webWatchesFromConfig(env.MUSE_WEB_WATCH_CONFIG ?? "", {
      fetchImpl: sequenceFetch([
        { body: "<h1>Order #42</h1> Status: processing", status: 200 },
        { body: "<h1>Order #42</h1> Status: shipped", status: 200 },
        { body: "<h1>Order #42</h1> Status: shipped", status: 200 }
      ]),
      retryOptions: noWait
    });
    expect(watches).toHaveLength(1);

    const sent: OutboundMessage[] = [];
    const handle = startWebWatchTick({
      destination: env.MUSE_WEB_WATCH_DESTINATION!,
      providerId: env.MUSE_WEB_WATCH_PROVIDER!,
      registry: new MessagingProviderRegistry([capturingProvider(sent)]),
      watches
    });
    try {
      await handle.tickOnce(); // processing → baseline, no ping
      await handle.tickOnce(); // shipped → rising edge → ping
      await handle.tickOnce(); // still shipped → no re-ping
    } finally {
      handle.stop();
    }

    expect(sent).toHaveLength(1);
    expect(sent[0]!.destination).toBe("555");
    expect(sent[0]!.text).toContain("Order update");
    expect(sent[0]!.text).toContain("Your order has shipped");
  });

  it("the same env, fully configured, registers the production daemon; disabled/empty does not", () => {
    const env = {
      MUSE_WEB_WATCH_CONFIG: USER_CONFIG,
      MUSE_WEB_WATCH_DESTINATION: "555",
      MUSE_WEB_WATCH_ENABLED: "true",
      MUSE_WEB_WATCH_PROVIDER: "telegram"
    } as unknown as NodeJS.ProcessEnv;
    const options = { messaging: new MessagingProviderRegistry([capturingProvider([])]) } as unknown as Parameters<typeof startWebWatchDaemonIfConfigured>[2];

    const on = fakeServer();
    startWebWatchDaemonIfConfigured(env, on.server as never, options);
    expect(on.hooks.filter((h) => h.name === "onClose")).toHaveLength(1);

    const off = fakeServer();
    startWebWatchDaemonIfConfigured({ ...env, MUSE_WEB_WATCH_ENABLED: "false" } as NodeJS.ProcessEnv, off.server as never, options);
    startWebWatchDaemonIfConfigured({ ...env, MUSE_WEB_WATCH_CONFIG: "[]" } as NodeJS.ProcessEnv, off.server as never, options);
    expect(off.hooks).toHaveLength(0);
  });
});
