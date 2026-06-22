import { homeWatchesFromConfig } from "@muse/domain-tools";
import { MessagingProviderRegistry, type MessagingProvider, type OutboundMessage, type OutboundReceipt } from "@muse/messaging";
import { describe, expect, it } from "vitest";

import { startWebWatchTick } from "../src/web-watch-tick.js";
import { startHomeWatchDaemonIfConfigured } from "../src/tick-daemons.js";

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

function haStateSequence(states: string[]) {
  let i = 0;
  return (async (url: string) => {
    const state = states[Math.min(i++, states.length - 1)]!;
    const entityId = url.split("/api/states/")[1] ?? "x";
    return new Response(JSON.stringify({ attributes: {}, entity_id: entityId, state }), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
}

const CONFIG = JSON.stringify([
  { entityId: "lock.front_door", id: "door", message: "Front door is unlocked!", rule: { appears: "unlocked" }, title: "Front door" }
]);

function fakeServer() {
  const hooks: { name: string; fn: () => unknown }[] = [];
  return {
    hooks,
    server: { addHook: (name: string, fn: () => unknown) => hooks.push({ fn, name }), log: { info: () => undefined, warn: () => undefined } }
  };
}

describe("home-watch daemon — end-to-end: a user's MUSE_HOME_WATCH_CONFIG → a delivered ping", () => {
  it("the config builds HA-state watches that fire once on the locked→unlocked edge through real messaging", async () => {
    const env = {
      MUSE_HOMEASSISTANT_TOKEN: "ha-tok",
      MUSE_HOMEASSISTANT_URL: "http://ha.local",
      MUSE_HOME_WATCH_CONFIG: CONFIG,
      MUSE_HOME_WATCH_DESTINATION: "555",
      MUSE_HOME_WATCH_ENABLED: "true",
      MUSE_HOME_WATCH_PROVIDER: "telegram"
    } as unknown as NodeJS.ProcessEnv;

    const watches = (env.MUSE_HOMEASSISTANT_URL && env.MUSE_HOMEASSISTANT_TOKEN)
      ? homeWatchesFromConfig(env.MUSE_HOME_WATCH_CONFIG ?? "", {
          baseUrl: env.MUSE_HOMEASSISTANT_URL,
          fetchImpl: haStateSequence(["locked", "unlocked", "unlocked"]),
          retryOptions: { baseDelayMs: 0, sleep: async () => {} },
          token: env.MUSE_HOMEASSISTANT_TOKEN
        })
      : [];
    expect(watches).toHaveLength(1);

    const sent: OutboundMessage[] = [];
    const handle = startWebWatchTick({
      destination: env.MUSE_HOME_WATCH_DESTINATION!,
      providerId: env.MUSE_HOME_WATCH_PROVIDER!,
      registry: new MessagingProviderRegistry([capturingProvider(sent)]),
      watches
    });
    try {
      await handle.tickOnce(); // locked baseline
      await handle.tickOnce(); // unlocked → fire
      await handle.tickOnce(); // still unlocked → no re-fire
    } finally {
      handle.stop();
    }
    expect(sent).toHaveLength(1);
    expect(sent[0]!.destination).toBe("555");
    expect(sent[0]!.text).toContain("Front door is unlocked");
  });

  it("registers the daemon only when enabled + provider + destination + HA creds + a valid config are all present", () => {
    const env = {
      MUSE_HOMEASSISTANT_TOKEN: "ha-tok",
      MUSE_HOMEASSISTANT_URL: "http://ha.local",
      MUSE_HOME_WATCH_CONFIG: CONFIG,
      MUSE_HOME_WATCH_DESTINATION: "555",
      MUSE_HOME_WATCH_ENABLED: "true",
      MUSE_HOME_WATCH_PROVIDER: "telegram"
    } as unknown as NodeJS.ProcessEnv;
    const options = { messaging: new MessagingProviderRegistry([capturingProvider([])]) } as unknown as Parameters<typeof startHomeWatchDaemonIfConfigured>[2];

    const on = fakeServer();
    startHomeWatchDaemonIfConfigured(env, on.server as never, options);
    expect(on.hooks.filter((h) => h.name === "onClose")).toHaveLength(1);

    const off = fakeServer();
    startHomeWatchDaemonIfConfigured({ ...env, MUSE_HOME_WATCH_ENABLED: "false" } as NodeJS.ProcessEnv, off.server as never, options);
    startHomeWatchDaemonIfConfigured({ ...env, MUSE_HOMEASSISTANT_TOKEN: undefined } as NodeJS.ProcessEnv, off.server as never, options);
    startHomeWatchDaemonIfConfigured({ ...env, MUSE_HOME_WATCH_CONFIG: "[]" } as NodeJS.ProcessEnv, off.server as never, options);
    expect(off.hooks).toHaveLength(0);
  });
});
