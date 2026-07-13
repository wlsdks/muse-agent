import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FastifyInstance } from "fastify";

import { MessagingProviderRegistry, TelegramProvider } from "@muse/messaging";
import { afterEach, describe, expect, it } from "vitest";

import { startSituationalBriefingDaemonIfConfigured } from "../src/tick-daemons.js";
import type { ServerOptions } from "../src/server.js";

function fakeServer() {
  const hooks: { name: string; fn: () => unknown }[] = [];
  const server = {
    addHook: (name: string, fn: () => unknown) => {
      hooks.push({ fn, name });
    },
    log: { info: () => {}, warn: () => {} }
  } as unknown as FastifyInstance;
  return { hooks, server };
}

function configuredOptions(): ServerOptions {
  const dir = mkdtempSync(join(tmpdir(), "muse-brief-daemon-"));
  return {
    briefingSidecarFile: join(dir, "briefing-fired.json"),
    messaging: new MessagingProviderRegistry([
      new TelegramProvider({ baseUrl: "https://tg.test", fetch: async () => new Response("{}"), token: "T" })
    ]),
    objectivesFile: join(dir, "objectives.json")
  } as unknown as ServerOptions;
}

const ENV = {
  MUSE_BRIEFING_DESTINATION: "555",
  MUSE_BRIEFING_PROVIDER: "telegram"
} as unknown as NodeJS.ProcessEnv;

describe("startSituationalBriefingDaemonIfConfigured — P9-b2 child 2/2 (briefing env-gated registration)", () => {
  it("with env + options + a registered provider: registers an onClose stop hook (started + stoppable)", () => {
    const { hooks, server } = fakeServer();
    startSituationalBriefingDaemonIfConfigured(ENV, server, configuredOptions());
    const onClose = hooks.filter((h) => h.name === "onClose");
    expect(onClose).toHaveLength(1);
    // The registered stop hook runs cleanly (the daemon is real + stoppable).
    expect(() => onClose[0]!.fn()).not.toThrow();
  });

  it("absent env ⇒ NOT started (no hook registered)", () => {
    const { hooks, server } = fakeServer();
    startSituationalBriefingDaemonIfConfigured({} as NodeJS.ProcessEnv, server, configuredOptions());
    expect(hooks).toHaveLength(0);
  });

  it("env present but the required options are missing ⇒ NOT started", () => {
    const { hooks, server } = fakeServer();
    startSituationalBriefingDaemonIfConfigured(ENV, server, { messaging: undefined } as unknown as ServerOptions);
    expect(hooks).toHaveLength(0);
  });

  it("env present but the named provider is not registered ⇒ NOT started", () => {
    const { hooks, server } = fakeServer();
    const opts = configuredOptions();
    const noProvider = { ...opts, messaging: new MessagingProviderRegistry([]) } as unknown as ServerOptions;
    startSituationalBriefingDaemonIfConfigured(ENV, server, noProvider);
    expect(hooks).toHaveLength(0);
  });

  it("keeps non-home briefing registration while omitting a remote HA alert before token read under local-only", () => {
    let tokenReads = 0;
    const env = {
      ...ENV,
      MUSE_BRIEFING_HOME_ALERTS: JSON.stringify([{ alertStates: ["unlocked"], entityId: "lock.front_door", label: "Front door" }]),
      MUSE_HOMEASSISTANT_URL: "http://ha.local:8123"
    } as NodeJS.ProcessEnv;
    Object.defineProperty(env, "MUSE_HOMEASSISTANT_TOKEN", {
      configurable: true,
      get: () => {
        tokenReads += 1;
        throw new Error("remote HA token must not be read by briefing setup");
      }
    });
    const { hooks, server } = fakeServer();
    startSituationalBriefingDaemonIfConfigured(env, server, configuredOptions(), true);
    expect(hooks.filter((hook) => hook.name === "onClose")).toHaveLength(1);
    expect(tokenReads).toBe(0);
  });
});

describe.sequential("startSituationalBriefingDaemonIfConfigured — ambient HA strictness floor", () => {
  const previous = process.env.MUSE_LOCAL_ONLY;

  afterEach(() => {
    if (previous === undefined) delete process.env.MUSE_LOCAL_ONLY;
    else process.env.MUSE_LOCAL_ONLY = previous;
  });

  it("does not let a supplied false reopen a remote HA alert when the process is strict", () => {
    process.env.MUSE_LOCAL_ONLY = "true";
    let tokenReads = 0;
    const env = {
      ...ENV,
      MUSE_BRIEFING_HOME_ALERTS: JSON.stringify([{ alertStates: ["unlocked"], entityId: "lock.front_door", label: "Front door" }]),
      MUSE_HOMEASSISTANT_URL: "http://ha.local:8123"
    } as NodeJS.ProcessEnv;
    Object.defineProperty(env, "MUSE_HOMEASSISTANT_TOKEN", {
      configurable: true,
      get: () => {
        tokenReads += 1;
        throw new Error("ambient strictness must block before token read");
      }
    });
    const { hooks, server } = fakeServer();
    startSituationalBriefingDaemonIfConfigured(env, server, configuredOptions(), false);
    expect(hooks.filter((hook) => hook.name === "onClose")).toHaveLength(1);
    expect(tokenReads).toBe(0);
  });

  it("does not probe a token when a strict Home Assistant URL is absent or blank", () => {
    for (const url of [undefined, "   "]) {
      let tokenReads = 0;
      const env = {
        ...ENV,
        MUSE_BRIEFING_HOME_ALERTS: JSON.stringify([{ alertStates: ["unlocked"], entityId: "lock.front_door", label: "Front door" }]),
        MUSE_HOMEASSISTANT_URL: url
      } as NodeJS.ProcessEnv;
      Object.defineProperty(env, "MUSE_HOMEASSISTANT_TOKEN", {
        configurable: true,
        get: () => {
          tokenReads += 1;
          throw new Error("blank Home Assistant URL must not read a token");
        }
      });
      const { hooks, server } = fakeServer();
      startSituationalBriefingDaemonIfConfigured(env, server, configuredOptions(), true);
      expect(hooks.filter((hook) => hook.name === "onClose"), String(url)).toHaveLength(1);
      expect(tokenReads, String(url)).toBe(0);
    }
  });
});
