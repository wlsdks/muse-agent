import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MessagingProviderRegistry, type MessagingProvider } from "@muse/messaging";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildServer } from "../src/server.js";
import { createFollowupRuntimeStatusStore } from "../src/followup-runtime-status.js";
import { startFollowupDaemonIfConfigured } from "../src/tick-daemons.js";

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

describe("startFollowupDaemonIfConfigured runtime status", () => {
  it.each([
    ["missing file", (root: string) => join(root, "missing.json")],
    ["missing route", (root: string) => join(root, "followups.json")]
  ])("records not-configured and installs no hook for %s", (_label, fileForRoot) => {
    const root = mkdtempSync(join(tmpdir(), "muse-followup-daemon-config-"));
    const followupsFile = fileForRoot(root);
    if (_label === "missing route") {
      writeFileSync(followupsFile, JSON.stringify({ followups: [] }), "utf8");
    }
    const runtimeStatus = createFollowupRuntimeStatusStore();
    const { server, hooks } = fakeServer();
    const options = {
      followupsFile,
      messaging: _label === "missing route" ? undefined : registry()
    } as unknown as Parameters<typeof startFollowupDaemonIfConfigured>[2];

    startFollowupDaemonIfConfigured(
      _label === "missing route"
        ? { MUSE_FOLLOWUP_DEFAULT_PROVIDER: "telegram", MUSE_FOLLOWUP_DEFAULT_DESTINATION: "123" }
        : { MUSE_FOLLOWUP_DEFAULT_PROVIDER: "telegram", MUSE_FOLLOWUP_DEFAULT_DESTINATION: "123" },
      server as never,
      options,
      runtimeStatus
    );

    expect(hooks).toHaveLength(0);
    expect(runtimeStatus.get()).toMatchObject({ lastDecision: "not-configured" });
  });

  it("records not-configured and installs no hook when the exact followups file is unreadable", () => {
    const root = mkdtempSync(join(tmpdir(), "muse-followup-daemon-unreadable-"));
    const followupsFile = join(root, "followups.json");
    writeFileSync(followupsFile, JSON.stringify({ followups: [] }), "utf8");
    chmodSync(followupsFile, 0o000);
    try {
      const runtimeStatus = createFollowupRuntimeStatusStore();
      const { server, hooks } = fakeServer();
      const options = { followupsFile, messaging: registry() } as unknown as Parameters<typeof startFollowupDaemonIfConfigured>[2];

      startFollowupDaemonIfConfigured(
        { MUSE_FOLLOWUP_DEFAULT_PROVIDER: "telegram", MUSE_FOLLOWUP_DEFAULT_DESTINATION: "123" },
        server as never,
        options,
        runtimeStatus
      );

      expect(hooks).toHaveLength(0);
      expect(runtimeStatus.get()).toMatchObject({ lastDecision: "not-configured" });
    } finally {
      chmodSync(followupsFile, 0o600);
    }
  });

  it("records not-configured and installs no hook when the exact path is a directory", () => {
    const root = mkdtempSync(join(tmpdir(), "muse-followup-daemon-directory-"));
    const runtimeStatus = createFollowupRuntimeStatusStore();
    const { server, hooks } = fakeServer();
    const options = { followupsFile: root, messaging: registry() } as unknown as Parameters<typeof startFollowupDaemonIfConfigured>[2];

    startFollowupDaemonIfConfigured(
      { MUSE_FOLLOWUP_DEFAULT_PROVIDER: "telegram", MUSE_FOLLOWUP_DEFAULT_DESTINATION: "123" },
      server as never,
      options,
      runtimeStatus
    );

    expect(hooks).toHaveLength(0);
    expect(runtimeStatus.get()).toMatchObject({ lastDecision: "not-configured" });
  });

  it.each([
    ["corrupt JSON", "not-json"],
    ["invalid follow-up shape", JSON.stringify({ followups: [{}] })]
  ])("records not-configured and installs no hook for %s", (_label, contents) => {
    vi.useFakeTimers();
    const root = mkdtempSync(join(tmpdir(), "muse-followup-daemon-invalid-source-"));
    const followupsFile = join(root, "followups.json");
    writeFileSync(followupsFile, contents, "utf8");
    const runtimeStatus = createFollowupRuntimeStatusStore();
    const { server, hooks } = fakeServer();
    const options = {
      defaultModel: "model",
      followupsFile,
      messaging: registry(),
      modelProvider: { generate: async () => ({ output: "unused" }) }
    } as unknown as Parameters<typeof startFollowupDaemonIfConfigured>[2];

    startFollowupDaemonIfConfigured(
      { MUSE_FOLLOWUP_DEFAULT_PROVIDER: "telegram", MUSE_FOLLOWUP_DEFAULT_DESTINATION: "123" },
      server as never,
      options,
      runtimeStatus
    );

    expect(hooks).toHaveLength(0);
    expect(runtimeStatus.get()).toMatchObject({ lastDecision: "not-configured" });
  });

  it("records not-configured and installs no hook when the model is absent", () => {
    const root = mkdtempSync(join(tmpdir(), "muse-followup-daemon-model-"));
    const followupsFile = join(root, "followups.json");
    writeFileSync(followupsFile, JSON.stringify({ followups: [] }), "utf8");
    const runtimeStatus = createFollowupRuntimeStatusStore();
    const { server, hooks } = fakeServer();
    const options = { followupsFile, messaging: registry() } as unknown as Parameters<typeof startFollowupDaemonIfConfigured>[2];

    startFollowupDaemonIfConfigured(
      { MUSE_FOLLOWUP_DEFAULT_PROVIDER: "telegram", MUSE_FOLLOWUP_DEFAULT_DESTINATION: "123" },
      server as never,
      options,
      runtimeStatus
    );

    expect(hooks).toHaveLength(0);
    expect(runtimeStatus.get()).toMatchObject({ lastDecision: "not-configured" });
  });

  it("passes the process-local store through the configured daemon into a real no-due tick", async () => {
    vi.useFakeTimers();
    const root = mkdtempSync(join(tmpdir(), "muse-followup-daemon-status-"));
    const followupsFile = join(root, "followups.json");
    writeFileSync(followupsFile, JSON.stringify({ followups: [] }), "utf8");
    const runtimeStatus = createFollowupRuntimeStatusStore();
    const { server, hooks } = fakeServer();
    const options = {
      defaultModel: "model",
      followupsFile,
      messaging: registry(),
      modelProvider: { generate: async () => ({ output: "unused" }) }
    } as unknown as Parameters<typeof startFollowupDaemonIfConfigured>[2];

    startFollowupDaemonIfConfigured(
      {
        MUSE_FOLLOWUP_DEFAULT_DESTINATION: "123",
        MUSE_FOLLOWUP_DEFAULT_PROVIDER: "telegram",
        MUSE_FOLLOWUP_TICK_MS: "5000"
      },
      server as never,
      options,
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

describe("buildServer follow-up runtime wiring", () => {
  it("exposes the not-configured observation through the existing upcoming GET", async () => {
    const root = mkdtempSync(join(tmpdir(), "muse-followup-server-status-"));
    const server = buildServer({
      env: { MUSE_INTERRUPTION_LEDGER_FILE: join(root, "ledger.json") },
      logger: false
    });

    const response = await server.inject({ method: "GET", url: "/api/automation/upcoming" });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      followupRuntime: { lastDecision: "not-configured" }
    });
    await server.close();
  });

  it("records not-configured without installing the follow-up daemon behind the delivery brake", async () => {
    const root = mkdtempSync(join(tmpdir(), "muse-followup-server-brake-"));
    const followupsFile = join(root, "followups.json");
    writeFileSync(followupsFile, JSON.stringify({ followups: [] }), "utf8");
    const server = buildServer({
      defaultModel: "model",
      env: {
        MUSE_DAEMON_DELIVERY_ENABLED: "false",
        MUSE_FOLLOWUP_DEFAULT_DESTINATION: "123",
        MUSE_FOLLOWUP_DEFAULT_PROVIDER: "telegram",
        MUSE_FOLLOWUP_TICK_MS: "5000",
        MUSE_INTERRUPTION_LEDGER_FILE: join(root, "ledger.json")
      },
      followupsFile,
      logger: false,
      messaging: registry(),
      modelProvider: { generate: async () => ({ output: "unused" }) }
    });

    const response = await server.inject({ method: "GET", url: "/api/automation/upcoming" });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      followupRuntime: { lastDecision: "not-configured" }
    });
    await server.close();
  });
});
