import { homeWatchesFromConfig } from "@muse/domain-tools";
import { MessagingProviderRegistry, type MessagingProvider, type OutboundMessage, type OutboundReceipt } from "@muse/messaging";
import { afterEach, describe, expect, it } from "vitest";

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

  it("does not read a remote HA token or register a watch under local-only", () => {
    let tokenReads = 0;
    const env = {
      MUSE_HOMEASSISTANT_URL: "http://ha.local:8123",
      MUSE_HOME_WATCH_CONFIG: CONFIG,
      MUSE_HOME_WATCH_DESTINATION: "555",
      MUSE_HOME_WATCH_ENABLED: "true",
      MUSE_HOME_WATCH_PROVIDER: "telegram"
    } as NodeJS.ProcessEnv;
    Object.defineProperty(env, "MUSE_HOMEASSISTANT_TOKEN", {
      configurable: true,
      get: () => {
        tokenReads += 1;
        throw new Error("remote HA token must not be read");
      }
    });
    const options = { messaging: new MessagingProviderRegistry([capturingProvider([])]) } as unknown as Parameters<typeof startHomeWatchDaemonIfConfigured>[2];
    const remote = fakeServer();
    startHomeWatchDaemonIfConfigured(env, remote.server as never, options, true);
    expect(remote.hooks).toEqual([]);
    expect(tokenReads).toBe(0);
  });

  it("still registers a canonical loopback watch under local-only", () => {
    const env = {
      MUSE_HOMEASSISTANT_TOKEN: "ha-tok",
      MUSE_HOMEASSISTANT_URL: "http://localhost:8123/",
      MUSE_HOME_WATCH_CONFIG: CONFIG,
      MUSE_HOME_WATCH_DESTINATION: "555",
      MUSE_HOME_WATCH_ENABLED: "true",
      MUSE_HOME_WATCH_PROVIDER: "telegram"
    } as NodeJS.ProcessEnv;
    const options = { messaging: new MessagingProviderRegistry([capturingProvider([])]) } as unknown as Parameters<typeof startHomeWatchDaemonIfConfigured>[2];
    const loopback = fakeServer();
    startHomeWatchDaemonIfConfigured(env, loopback.server as never, options, true);
    expect(loopback.hooks.filter((hook) => hook.name === "onClose")).toHaveLength(1);
  });
});

describe.sequential("home-watch daemon — ambient Home Assistant local-only floor", () => {
  const previous = process.env.MUSE_LOCAL_ONLY;

  afterEach(() => {
    if (previous === undefined) delete process.env.MUSE_LOCAL_ONLY;
    else process.env.MUSE_LOCAL_ONLY = previous;
  });

  it("does not let a supplied false reopen a remote watch in an actually strict process", () => {
    process.env.MUSE_LOCAL_ONLY = "true";
    let tokenReads = 0;
    const env = {
      MUSE_HOMEASSISTANT_URL: "http://ha.local:8123",
      MUSE_HOME_WATCH_CONFIG: CONFIG,
      MUSE_HOME_WATCH_DESTINATION: "555",
      MUSE_HOME_WATCH_ENABLED: "true",
      MUSE_HOME_WATCH_PROVIDER: "telegram"
    } as NodeJS.ProcessEnv;
    Object.defineProperty(env, "MUSE_HOMEASSISTANT_TOKEN", {
      configurable: true,
      get: () => {
        tokenReads += 1;
        throw new Error("ambient strictness must block before token read");
      }
    });
    const options = { messaging: new MessagingProviderRegistry([capturingProvider([])]) } as unknown as Parameters<typeof startHomeWatchDaemonIfConfigured>[2];
    const server = fakeServer();
    startHomeWatchDaemonIfConfigured(env, server.server as never, options, false);
    expect(server.hooks).toEqual([]);
    expect(tokenReads).toBe(0);
  });

  it("does not probe a token when a strict Home Assistant URL is absent or blank", () => {
    const options = { messaging: new MessagingProviderRegistry([capturingProvider([])]) } as unknown as Parameters<typeof startHomeWatchDaemonIfConfigured>[2];
    for (const url of [undefined, "   "]) {
      let tokenReads = 0;
      const env = {
        MUSE_HOMEASSISTANT_URL: url,
        MUSE_HOME_WATCH_CONFIG: CONFIG,
        MUSE_HOME_WATCH_DESTINATION: "555",
        MUSE_HOME_WATCH_ENABLED: "true",
        MUSE_HOME_WATCH_PROVIDER: "telegram"
      } as NodeJS.ProcessEnv;
      Object.defineProperty(env, "MUSE_HOMEASSISTANT_TOKEN", {
        configurable: true,
        get: () => {
          tokenReads += 1;
          throw new Error("blank Home Assistant URL must not read a token");
        }
      });
      const server = fakeServer();
      startHomeWatchDaemonIfConfigured(env, server.server as never, options, true);
      expect(server.hooks, String(url)).toEqual([]);
      expect(tokenReads, String(url)).toBe(0);
    }
  });
});
