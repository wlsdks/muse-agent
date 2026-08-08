import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MessagingProviderRegistry, type MessagingProvider } from "@muse/messaging";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildServer } from "../src/server.js";
import { createPatternRuntimeStatusStore } from "../src/pattern-runtime-status.js";
import { startPatternDaemonIfConfigured } from "../src/tick-daemons.js";

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

function startOptions(patternsFiredFile: string) {
  return { messaging: registry(), patternsFiredFile } as unknown as Parameters<typeof startPatternDaemonIfConfigured>[2];
}

const patternEnv = {
  MUSE_PROACTIVE_PATTERN_DESTINATION: "123",
  MUSE_PROACTIVE_PATTERN_ENABLED: "true",
  MUSE_PROACTIVE_PATTERN_PROVIDER: "telegram"
};

afterEach(() => {
  vi.useRealTimers();
});

describe("startPatternDaemonIfConfigured runtime status", () => {
  it("allows a missing sidecar as the valid first-run state and installs one hook", () => {
    const root = mkdtempSync(join(tmpdir(), "muse-pattern-daemon-missing-"));
    const runtimeStatus = createPatternRuntimeStatusStore();
    const { hooks, server } = fakeServer();

    startPatternDaemonIfConfigured(patternEnv, server as never, startOptions(join(root, "missing.json")), runtimeStatus);

    expect(hooks).toHaveLength(1);
    expect(runtimeStatus.get()).toBeNull();
    for (const hook of hooks) void hook();
  });

  it.each([
    ["corrupt JSON", (file: string) => writeFileSync(file, "not-json", "utf8")],
    ["invalid shape", (file: string) => writeFileSync(file, JSON.stringify({ fired: "not-an-array" }), "utf8")],
    ["broken symlink", (file: string) => symlinkSync(join(file, "missing-target.json"), file)]
  ])("records not-configured and installs no hook for an existing %s sidecar", (_label, makeBroken) => {
    const root = mkdtempSync(join(tmpdir(), "muse-pattern-daemon-invalid-"));
    const file = join(root, "patterns-fired.json");
    makeBroken(file);
    const runtimeStatus = createPatternRuntimeStatusStore();
    const { hooks, server } = fakeServer();

    startPatternDaemonIfConfigured(patternEnv, server as never, startOptions(file), runtimeStatus);

    expect(hooks).toHaveLength(0);
    expect(runtimeStatus.get()).toMatchObject({ lastDecision: "not-configured" });
  });

  it("accepts a readable valid existing sidecar", () => {
    const root = mkdtempSync(join(tmpdir(), "muse-pattern-daemon-valid-"));
    const file = join(root, "patterns-fired.json");
    writeFileSync(file, JSON.stringify({ fired: [] }), "utf8");
    const { hooks, server } = fakeServer();

    startPatternDaemonIfConfigured(patternEnv, server as never, startOptions(file));

    expect(hooks).toHaveLength(1);
    for (const hook of hooks) void hook();
  });
});

describe("assembled pattern runtime status", () => {
  it("records not-configured through Upcoming when the route is absent", async () => {
    const root = mkdtempSync(join(tmpdir(), "muse-pattern-server-route-"));
    const server = buildServer({
      env: {
        HOME: root,
        MUSE_INTERRUPTION_LEDGER_FILE: join(root, "ledger.json"),
        ...patternEnv
      },
      logger: false
    });

    const response = await server.inject({ method: "GET", url: "/api/automation/upcoming" });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ patternRuntime: { lastDecision: "not-configured" } });
    await server.close();
  });

  it("records not-configured through Upcoming when the global delivery brake is engaged", async () => {
    const root = mkdtempSync(join(tmpdir(), "muse-pattern-server-brake-"));
    const server = buildServer({
      env: {
        HOME: root,
        MUSE_DAEMON_DELIVERY_ENABLED: "false",
        MUSE_INTERRUPTION_LEDGER_FILE: join(root, "ledger.json"),
        ...patternEnv
      },
      logger: false,
      messaging: registry(),
      patternsFiredFile: join(root, "patterns-fired.json")
    });

    const response = await server.inject({ method: "GET", url: "/api/automation/upcoming" });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ patternRuntime: { lastDecision: "not-configured" } });
    await server.close();
  });
});
