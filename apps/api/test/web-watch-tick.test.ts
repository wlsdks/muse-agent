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

const CONFIG = JSON.stringify([
  { id: "w", message: "Your order shipped", rule: { appears: "shipped" }, title: "Order", url: "https://x.test/order" }
]);

describe("startWebWatchTick — delivers a fired web-watch through the messaging registry", () => {
  it("tickOnce fires exactly once on the rising edge and never while the term persists", async () => {
    const watches = webWatchesFromConfig(CONFIG, {
      fetchImpl: sequenceFetch([
        { body: "processing", status: 200 },
        { body: "shipped now", status: 200 },
        { body: "shipped now", status: 200 }
      ]),
      retryOptions: noWait
    });
    const sent: OutboundMessage[] = [];
    const handle = startWebWatchTick({
      destination: "555",
      providerId: "telegram",
      registry: new MessagingProviderRegistry([capturingProvider(sent)]),
      watches
    });
    try {
      await handle.tickOnce(); // processing → baseline
      await handle.tickOnce(); // shipped → fire
      await handle.tickOnce(); // still shipped → no re-fire
    } finally {
      handle.stop();
    }
    expect(sent).toHaveLength(1);
    expect(sent[0]!.destination).toBe("555");
    expect(sent[0]!.text).toContain("Your order shipped");
  });

  it("skips delivery during quiet hours", async () => {
    const watches = webWatchesFromConfig(CONFIG, {
      fetchImpl: sequenceFetch([{ body: "processing", status: 200 }, { body: "shipped", status: 200 }]),
      retryOptions: noWait
    });
    const sent: OutboundMessage[] = [];
    const handle = startWebWatchTick({
      destination: "555",
      now: () => new Date(2026, 0, 1, 3, 0, 0),
      providerId: "telegram",
      quietHours: { endHour: 7, startHour: 22 },
      registry: new MessagingProviderRegistry([capturingProvider(sent)]),
      watches
    });
    try {
      await handle.tickOnce();
      await handle.tickOnce();
    } finally {
      handle.stop();
    }
    expect(sent).toHaveLength(0);
  });
});

function fakeServer() {
  const hooks: { name: string; fn: () => unknown }[] = [];
  return {
    hooks,
    server: { addHook: (name: string, fn: () => unknown) => hooks.push({ fn, name }), log: { info: () => undefined, warn: () => undefined } }
  };
}

describe("startWebWatchDaemonIfConfigured — env-gated registration", () => {
  const options = { messaging: new MessagingProviderRegistry([capturingProvider([])]) } as unknown as Parameters<typeof startWebWatchDaemonIfConfigured>[2];
  const env = {
    MUSE_WEB_WATCH_CONFIG: CONFIG,
    MUSE_WEB_WATCH_DESTINATION: "555",
    MUSE_WEB_WATCH_ENABLED: "true",
    MUSE_WEB_WATCH_PROVIDER: "telegram"
  } as unknown as NodeJS.ProcessEnv;

  it("registers an onClose stop hook when fully configured", () => {
    const { hooks, server } = fakeServer();
    startWebWatchDaemonIfConfigured(env, server as never, options);
    expect(hooks.filter((h) => h.name === "onClose")).toHaveLength(1);
  });

  it("absent env / empty config / disabled ⇒ NOT started", () => {
    const { hooks, server } = fakeServer();
    startWebWatchDaemonIfConfigured({} as NodeJS.ProcessEnv, server as never, options);
    startWebWatchDaemonIfConfigured({ ...env, MUSE_WEB_WATCH_CONFIG: "[]" } as NodeJS.ProcessEnv, server as never, options);
    startWebWatchDaemonIfConfigured({ ...env, MUSE_WEB_WATCH_ENABLED: "false" } as NodeJS.ProcessEnv, server as never, options);
    expect(hooks).toHaveLength(0);
  });
});
