import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FastifyInstance } from "fastify";

import { MessagingProviderRegistry, TelegramProvider } from "@muse/messaging";
import { describe, expect, it } from "vitest";

import { startObjectivesDaemonIfConfigured } from "../src/tick-daemons.js";
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
  const dir = mkdtempSync(join(tmpdir(), "muse-obj-daemon-"));
  return {
    defaultModel: "ollama/qwen3:8b",
    messaging: new MessagingProviderRegistry([
      new TelegramProvider({ baseUrl: "https://tg.test", fetch: async () => new Response("{}"), token: "T" })
    ]),
    modelProvider: { generate: async () => ({ output: '{"outcome":"unmet"}' }) },
    objectivesFile: join(dir, "objectives.json")
  } as unknown as ServerOptions;
}

const ENV = {
  MUSE_OBJECTIVES_DESTINATION: "555",
  MUSE_OBJECTIVES_PROVIDER: "telegram"
} as unknown as NodeJS.ProcessEnv;

describe("startObjectivesDaemonIfConfigured — P9-b2 final child (objectives daemon env-gated)", () => {
  it("env + options + provider + modelProvider + defaultModel ⇒ registers an onClose stop hook", () => {
    const { hooks, server } = fakeServer();
    startObjectivesDaemonIfConfigured(ENV, server, configuredOptions());
    const onClose = hooks.filter((h) => h.name === "onClose");
    expect(onClose).toHaveLength(1);
    expect(() => onClose[0]!.fn()).not.toThrow();
  });

  it("absent env ⇒ NOT started", () => {
    const { hooks, server } = fakeServer();
    startObjectivesDaemonIfConfigured({} as NodeJS.ProcessEnv, server, configuredOptions());
    expect(hooks).toHaveLength(0);
  });

  it("env present but no modelProvider/defaultModel ⇒ NOT started (the evaluator needs the model)", () => {
    const { hooks, server } = fakeServer();
    const opts = configuredOptions();
    const noModel = { ...opts, defaultModel: undefined, modelProvider: undefined } as unknown as ServerOptions;
    startObjectivesDaemonIfConfigured(ENV, server, noModel);
    expect(hooks).toHaveLength(0);
  });

  it("env present but the named provider is not registered ⇒ NOT started", () => {
    const { hooks, server } = fakeServer();
    const opts = configuredOptions();
    const noProvider = { ...opts, messaging: new MessagingProviderRegistry([]) } as unknown as ServerOptions;
    startObjectivesDaemonIfConfigured(ENV, server, noProvider);
    expect(hooks).toHaveLength(0);
  });
});
