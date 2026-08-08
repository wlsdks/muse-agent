import { describe, expect, it } from "vitest";

import { shapeDaemonFlags } from "../src/settings-routes.js";
import { CONSOLIDATE_IDLE_FLAG } from "../src/consolidate-idle-flag.js";
import { InMemoryRuntimeSettingsStore, RuntimeSettings } from "@muse/runtime-settings";

// Truthful daemon status: the flags surface must report whether a daemon is
// ACTUALLY running (live handle via the supervisor), not just whether its
// env flag is set — a flag-on/daemon-dead badge was the UX audit's top lie.

describe("shapeDaemonFlags running state", () => {
  it("reports running for channel daemons from the live status snapshot", () => {
    const shaped = shapeDaemonFlags(
      { MUSE_INBOUND_REPLY_ENABLED: "1", MUSE_TELEGRAM_POLL_ENABLED: "1" },
      () => ({
        "inbound-reply": { running: true },
        "telegram-poll": { running: false }
      })
    );
    const telegram = shaped.flags.find((flag) => flag.key === "MUSE_TELEGRAM_POLL_ENABLED");
    const reply = shaped.flags.find((flag) => flag.key === "MUSE_INBOUND_REPLY_ENABLED");
    expect(telegram).toMatchObject({ enabled: true, running: false });
    expect(reply).toMatchObject({ enabled: true, running: true });
  });

  it("omits running when no status source is wired (non-channel daemons keep the old shape)", () => {
    const shaped = shapeDaemonFlags({ MUSE_TELEGRAM_POLL_ENABLED: "1" });
    const telegram = shaped.flags.find((flag) => flag.key === "MUSE_TELEGRAM_POLL_ENABLED");
    expect(telegram?.enabled).toBe(true);
    expect(telegram && "running" in telegram ? telegram.running : undefined).toBeUndefined();
  });

  it("lists the matrix sync daemon flag", () => {
    const shaped = shapeDaemonFlags({});
    expect(shaped.flags.some((flag) => flag.key === "MUSE_MATRIX_POLL_ENABLED")).toBe(true);
  });
});

describe("shapeDaemonFlags status detail passthrough", () => {
  it("carries lastIngestAtIso and lastError for channel daemons", () => {
    const shaped = shapeDaemonFlags(
      { MUSE_TELEGRAM_POLL_ENABLED: "1" },
      () => ({
        "telegram-poll": { lastError: "getUpdates failed", lastIngestAtIso: "2026-07-11T10:00:00.000Z", running: true }
      })
    );
    const telegram = shaped.flags.find((flag) => flag.key === "MUSE_TELEGRAM_POLL_ENABLED");
    expect(telegram).toMatchObject({
      lastError: "getUpdates failed",
      lastIngestAtIso: "2026-07-11T10:00:00.000Z",
      running: true
    });
  });
});

describe("PATCH /api/settings/daemon-flags", () => {
  async function buildPatchServer() {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const Fastify = (await import("fastify")).default;
    const { registerSettingsRoutes } = await import("../src/settings-routes.js");
    const dir = mkdtempSync(join(tmpdir(), "muse-dpatch-"));
    const settingsFile = join(dir, "daemon-settings.json");
    const applied: { key: string; enabled: boolean }[] = [];
    const server = Fastify({ logger: false });
    registerSettingsRoutes(server, {
      applyDaemonToggle: (key, enabled) => {
        applied.push({ enabled, key });
        return key !== "MUSE_HOME_WATCH_ENABLED";
      },
      authService: undefined,
      daemonSettingsFile: settingsFile
    });
    return { applied, server, settingsFile };
  }

  it("persists the toggle and reports live application for channel daemons", async () => {
    const { applied, server, settingsFile } = await buildPatchServer();
    const response = await server.inject({
      method: "PATCH",
      payload: { enabled: false, key: "MUSE_TELEGRAM_POLL_ENABLED" },
      url: "/api/settings/daemon-flags"
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ appliedLive: true, enabled: false, key: "MUSE_TELEGRAM_POLL_ENABLED" });
    expect(applied).toEqual([{ enabled: false, key: "MUSE_TELEGRAM_POLL_ENABLED" }]);
    const { readDaemonSettingsSync } = await import("../src/daemon-settings-store.js");
    expect(readDaemonSettingsSync(settingsFile)).toEqual({ MUSE_TELEGRAM_POLL_ENABLED: false });
  });

  it("a restart-only daemon persists but reports appliedLive=false", async () => {
    const { server } = await buildPatchServer();
    const response = await server.inject({
      method: "PATCH",
      payload: { enabled: true, key: "MUSE_HOME_WATCH_ENABLED" },
      url: "/api/settings/daemon-flags"
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ appliedLive: false, enabled: true });
  });

  it("rejects an unknown flag key (no arbitrary env writes)", async () => {
    const { server } = await buildPatchServer();
    const response = await server.inject({
      method: "PATCH",
      payload: { enabled: true, key: "MUSE_TOTALLY_MADE_UP" },
      url: "/api/settings/daemon-flags"
    });
    expect(response.statusCode).toBe(404);
  });

  it("GET resolves env first and PATCH round-trips a typed runtime override", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const Fastify = (await import("fastify")).default;
    const { registerSettingsRoutes } = await import("../src/settings-routes.js");
    const dir = mkdtempSync(join(tmpdir(), "muse-runtime-dpatch-"));
    const settingsFile = join(dir, "daemon-settings.json");
    const runtimeSettings = new RuntimeSettings(new InMemoryRuntimeSettingsStore());
    const server = Fastify({ logger: false });
    registerSettingsRoutes(server, {
      authService: undefined,
      daemonSettingsFile: settingsFile,
      env: { [CONSOLIDATE_IDLE_FLAG]: "true" },
      runtimeSettings
    });

    const fromEnv = await server.inject({ method: "GET", url: "/api/settings/daemon-flags" });
    expect(fromEnv.statusCode).toBe(200);
    expect(fromEnv.json().flags.find((flag: { key: string }) => flag.key === CONSOLIDATE_IDLE_FLAG)?.enabled).toBe(true);

    const patched = await server.inject({
      method: "PATCH",
      payload: { enabled: false, key: CONSOLIDATE_IDLE_FLAG },
      url: "/api/settings/daemon-flags"
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ appliedLive: true, enabled: false, key: CONSOLIDATE_IDLE_FLAG });
    expect(await runtimeSettings.find(CONSOLIDATE_IDLE_FLAG)).toMatchObject({
      key: CONSOLIDATE_IDLE_FLAG,
      type: "boolean",
      value: "false"
    });

    const afterPatch = await server.inject({ method: "GET", url: "/api/settings/daemon-flags" });
    expect(afterPatch.json().flags.find((flag: { key: string }) => flag.key === CONSOLIDATE_IDLE_FLAG)?.enabled).toBe(false);
    const { readDaemonSettingsSync } = await import("../src/daemon-settings-store.js");
    expect(readDaemonSettingsSync(settingsFile)).toEqual({});
  });

  it("rejects invalid selected-key requests without changing the prior runtime value", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const Fastify = (await import("fastify")).default;
    const { registerSettingsRoutes } = await import("../src/settings-routes.js");
    const runtimeSettings = new RuntimeSettings(new InMemoryRuntimeSettingsStore());
    await runtimeSettings.set({ key: CONSOLIDATE_IDLE_FLAG, type: "boolean", value: "false" });
    const server = Fastify({ logger: false });
    registerSettingsRoutes(server, {
      authService: undefined,
      daemonSettingsFile: join(mkdtempSync(join(tmpdir(), "muse-runtime-invalid-")), "daemon-settings.json"),
      runtimeSettings
    });

    const unknown = await server.inject({
      method: "PATCH",
      payload: { enabled: true, key: "MUSE_NOT_A_DAEMON_FLAG" },
      url: "/api/settings/daemon-flags"
    });
    expect(unknown.statusCode).toBe(404);
    const nonBoolean = await server.inject({
      method: "PATCH",
      payload: { enabled: "true", key: CONSOLIDATE_IDLE_FLAG },
      url: "/api/settings/daemon-flags"
    });
    expect(nonBoolean.statusCode).toBe(400);
    expect(await runtimeSettings.find(CONSOLIDATE_IDLE_FLAG)).toMatchObject({ value: "false", type: "boolean" });
  });
});
