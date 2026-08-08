import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { InMemoryRuntimeSettingsStore, RuntimeSettings } from "@muse/runtime-settings";
import { beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
  options: undefined as Record<string, unknown> | undefined
}));

vi.mock("../src/consolidate-tick.js", () => ({
  startConsolidateTick: (options: Record<string, unknown>) => {
    captured.options = options;
    return {
      getStatus: () => ({ lastDecision: null, lastObservedAtIso: null }),
      stop: vi.fn(),
      tickOnce: vi.fn()
    };
  }
}));

import { buildServer } from "../src/server.js";
import { startConsolidateDaemonIfConfigured } from "../src/tick-daemons.js";

function fakeServer() {
  return {
    addHook: vi.fn(),
    log: { info: vi.fn(), warn: vi.fn() }
  };
}

describe("startConsolidateDaemonIfConfigured", () => {
  beforeEach(() => {
    captured.options = undefined;
  });

  it("starts a dormant tick with a live runtime resolver even when env is off", async () => {
    const root = mkdtempSync(join(tmpdir(), "muse-consolidate-daemon-toggle-"));
    const runtimeSettings = new RuntimeSettings(new InMemoryRuntimeSettingsStore());
    const server = fakeServer();
    startConsolidateDaemonIfConfigured(
      { MUSE_DAEMON_SETTINGS_FILE: join(root, "daemon-settings.json") },
      server as never,
      {
        defaultModel: "qwen3:8b",
        modelProvider: { generate: vi.fn() },
        runtimeSettings
      } as never,
      { phaseDProactiveOn: false, phaseDReminderOn: false, runtimeSettings }
    );

    expect(captured.options).toBeDefined();
    const isEnabled = captured.options?.isEnabled as (() => Promise<boolean>);
    await expect(isEnabled()).resolves.toBe(false);

    await runtimeSettings.set({ key: "MUSE_SKILL_CONSOLIDATE_IDLE_ENABLED", type: "boolean", value: "true" });
    await expect(isEnabled()).resolves.toBe(true);
    await runtimeSettings.set({ key: "MUSE_SKILL_CONSOLIDATE_IDLE_ENABLED", type: "boolean", value: "false" });
    await expect(isEnabled()).resolves.toBe(false);
  });

  it("does not start a tick without a model provider or default model", () => {
    const server = fakeServer();
    startConsolidateDaemonIfConfigured(
      { MUSE_SKILL_CONSOLIDATE_IDLE_ENABLED: "true" },
      server as never,
      {} as never,
      { phaseDProactiveOn: false, phaseDReminderOn: false }
    );
    expect(captured.options).toBeUndefined();
  });

  it("reports the shared runtime toggle through the real API assembly without a restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "muse-consolidate-status-api-"));
    const runtimeSettings = new RuntimeSettings(new InMemoryRuntimeSettingsStore());
    const server = buildServer({
      defaultModel: "qwen3:8b",
      env: {
        MUSE_LEARN_QUEUE_FILE: join(root, "learn-queue.jsonl"),
        MUSE_LEARNING_PAUSE_FILE: join(root, "learning-paused.json"),
        MUSE_SKILL_CONSOLIDATE_IDLE_ENABLED: "true"
      },
      logger: false,
      modelProvider: { generate: vi.fn() },
      runtimeSettings
    });

    const before = await server.inject({ method: "GET", url: "/api/self-improvement/status" });
    expect(before.json()).toMatchObject({ configured: true, enabled: true, state: "running" });

    const disabled = await server.inject({
      method: "PATCH",
      payload: { enabled: false, key: "MUSE_SKILL_CONSOLIDATE_IDLE_ENABLED" },
      url: "/api/settings/daemon-flags"
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json()).toMatchObject({ appliedLive: true, enabled: false, key: "MUSE_SKILL_CONSOLIDATE_IDLE_ENABLED" });
    expect(await runtimeSettings.find("MUSE_SKILL_CONSOLIDATE_IDLE_ENABLED")).toMatchObject({ value: "false", type: "boolean" });
    const afterDisable = await server.inject({ method: "GET", url: "/api/self-improvement/status" });
    expect(afterDisable.json()).toMatchObject({ configured: true, enabled: false, state: "dormant" });

    const enabled = await server.inject({
      method: "PATCH",
      payload: { enabled: true, key: "MUSE_SKILL_CONSOLIDATE_IDLE_ENABLED" },
      url: "/api/settings/daemon-flags"
    });
    expect(enabled.statusCode).toBe(200);
    const afterEnable = await server.inject({ method: "GET", url: "/api/self-improvement/status" });
    expect(afterEnable.json()).toMatchObject({ configured: true, enabled: true, state: "running" });
    await server.close();
  });
});
