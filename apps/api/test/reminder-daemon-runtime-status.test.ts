import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MessagingProviderRegistry, type MessagingProvider } from "@muse/messaging";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildServer } from "../src/server.js";
import { createReminderRuntimeStatusStore } from "../src/reminder-runtime-status.js";
import { startReminderDaemonIfConfigured } from "../src/tick-daemons.js";

function registry(): MessagingProviderRegistry {
  const provider: MessagingProvider = {
    describe: () => ({ description: "test", displayName: "Telegram", id: "telegram" }),
    id: "telegram",
    send: async (message) => ({ destination: message.destination, messageId: "test", providerId: "telegram" })
  };
  return new MessagingProviderRegistry([provider]);
}

function fakeServer() {
  const hooks: Array<() => unknown> = [];
  return {
    hooks,
    server: {
      addHook: (_name: string, hook: () => unknown) => hooks.push(hook),
      log: { info: () => undefined, warn: () => undefined }
    }
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("startReminderDaemonIfConfigured runtime status", () => {
  it("records not-configured and installs no hook when the exact reminders file is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "muse-reminder-daemon-missing-"));
    const runtimeStatus = createReminderRuntimeStatusStore();
    const { server, hooks } = fakeServer();
    const options = {
      messaging: registry(),
      remindersFile: join(root, "missing.json")
    } as unknown as Parameters<typeof startReminderDaemonIfConfigured>[2];

    startReminderDaemonIfConfigured(
      { MUSE_REMINDER_DEFAULT_PROVIDER: "telegram", MUSE_REMINDER_DEFAULT_DESTINATION: "123" },
      server as never,
      options,
      { phaseDReminderOn: false, phaseDProactiveOn: false },
      runtimeStatus
    );

    expect(hooks).toHaveLength(0);
    expect(runtimeStatus.get()).toMatchObject({ lastDecision: "not-configured" });
  });

  it("records not-configured and installs no hook when the exact reminders file is unreadable", () => {
    const root = mkdtempSync(join(tmpdir(), "muse-reminder-daemon-unreadable-"));
    const remindersFile = join(root, "reminders.json");
    writeFileSync(remindersFile, JSON.stringify({ reminders: [] }), "utf8");
    chmodSync(remindersFile, 0o000);
    try {
      const runtimeStatus = createReminderRuntimeStatusStore();
      const { server, hooks } = fakeServer();
      const options = { messaging: registry(), remindersFile } as unknown as Parameters<typeof startReminderDaemonIfConfigured>[2];

      startReminderDaemonIfConfigured(
        { MUSE_REMINDER_DEFAULT_PROVIDER: "telegram", MUSE_REMINDER_DEFAULT_DESTINATION: "123" },
        server as never,
        options,
        { phaseDReminderOn: false, phaseDProactiveOn: false },
        runtimeStatus
      );

      expect(hooks).toHaveLength(0);
      expect(runtimeStatus.get()).toMatchObject({ lastDecision: "not-configured" });
    } finally {
      chmodSync(remindersFile, 0o600);
    }
  });

  it("passes the process-local store through the configured daemon into a real no-due tick", async () => {
    vi.useFakeTimers();
    const root = mkdtempSync(join(tmpdir(), "muse-reminder-daemon-status-"));
    const remindersFile = join(root, "reminders.json");
    writeFileSync(remindersFile, JSON.stringify({ reminders: [] }), "utf8");
    const runtimeStatus = createReminderRuntimeStatusStore();
    const { server, hooks } = fakeServer();
    const options = {
      actionLogFile: join(root, "actions.json"),
      messaging: registry(),
      remindersFile
    } as unknown as Parameters<typeof startReminderDaemonIfConfigured>[2];

    startReminderDaemonIfConfigured(
      {
        MUSE_REMINDER_DEFAULT_DESTINATION: "123",
        MUSE_REMINDER_DEFAULT_PROVIDER: "telegram",
        MUSE_REMINDER_TICK_MS: "5000"
      },
      server as never,
      options,
      { phaseDReminderOn: false, phaseDProactiveOn: false },
      runtimeStatus
    );

    expect(hooks).toHaveLength(1);
    await vi.runOnlyPendingTimersAsync();
    await vi.waitFor(() => expect(runtimeStatus.get()).toMatchObject({
      lastDecision: "no-due",
      lastDeliveredCount: 0,
      lastDueCount: 0,
      lastErrorCount: 0,
      lastFiredCount: 0
    }));
    for (const hook of hooks) await hook();
  });
});

describe("buildServer reminder runtime wiring", () => {
  it("exposes the not-configured observation through the existing authenticated upcoming GET", async () => {
    const root = mkdtempSync(join(tmpdir(), "muse-reminder-server-status-"));
    const server = buildServer({
      env: { MUSE_INTERRUPTION_LEDGER_FILE: join(root, "ledger.json") },
      logger: false
    });

    const response = await server.inject({ method: "GET", url: "/api/automation/upcoming" });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      reminderRuntime: { lastDecision: "not-configured" }
    });
    await server.close();
  });
});
