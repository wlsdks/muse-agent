import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readQuietHoursSettingSync } from "./daemon-settings-store.js";
import { registerSettingsRoutes, shapeQuietHoursSettings } from "./settings-routes.js";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "muse-quiet-hours-routes-"));
  file = join(dir, "daemon-settings.json");
});

afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

describe("shapeQuietHoursSettings — the pure resolver GET/PATCH share", () => {
  it("nothing set → source none, no effective range", () => {
    expect(shapeQuietHoursSettings({}, file)).toEqual({ enabled: false, effectiveRange: undefined, range: undefined, source: "none" });
  });

  it("MUSE_REMINDER_QUIET_HOURS set → source env, effectiveRange is the raw env value", () => {
    expect(shapeQuietHoursSettings({ MUSE_REMINDER_QUIET_HOURS: "22-7" }, file)).toMatchObject({
      effectiveRange: "22-7",
      source: "env"
    });
  });

  it("env wins over an enabled persisted setting — AC3 precedence", async () => {
    const { writeQuietHoursSetting } = await import("./daemon-settings-store.js");
    await writeQuietHoursSetting(file, { enabled: true, range: "23:00-08:00" });
    const view = shapeQuietHoursSettings({ MUSE_REMINDER_QUIET_HOURS: "22-7" }, file);
    expect(view.source).toBe("env");
    expect(view.effectiveRange).toBe("22-7");
    // the persisted setting is still reported (so the UI can show it), just not in force
    expect(view.enabled).toBe(true);
    expect(view.range).toBe("23:00-08:00");
  });
});

describe("GET/PATCH /api/settings/quiet-hours", () => {
  it("GET with no daemonSettingsFile still answers (source none)", async () => {
    const server = Fastify();
    registerSettingsRoutes(server, { authService: undefined });
    const res = await server.inject({ method: "GET", url: "/api/settings/quiet-hours" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ source: "none" });
    await server.close();
  });

  it("PATCH persists an enabled setting and GET reflects it back", async () => {
    const server = Fastify();
    registerSettingsRoutes(server, { authService: undefined, daemonSettingsFile: file });
    const patch = await server.inject({
      method: "PATCH",
      payload: { enabled: true, range: "23:00-08:00" },
      url: "/api/settings/quiet-hours"
    });
    expect(patch.statusCode).toBe(200);
    expect(JSON.parse(patch.body)).toMatchObject({ effectiveRange: "23:00-08:00", enabled: true, source: "persisted" });
    expect(readQuietHoursSettingSync(file)).toEqual({ enabled: true, range: "23:00-08:00" });
    await server.close();
  });

  it("PATCH with an invalid range → 400, the store is UNCHANGED", async () => {
    const server = Fastify();
    registerSettingsRoutes(server, { authService: undefined, daemonSettingsFile: file });
    // seed a known-good value first so we can prove it survives the bad PATCH
    await server.inject({ method: "PATCH", payload: { enabled: true, range: "23:00-08:00" }, url: "/api/settings/quiet-hours" });
    const bad = await server.inject({
      method: "PATCH",
      payload: { enabled: true, range: "not-a-range" },
      url: "/api/settings/quiet-hours"
    });
    expect(bad.statusCode).toBe(400);
    expect(readQuietHoursSettingSync(file)).toEqual({ enabled: true, range: "23:00-08:00" });
    await server.close();
  });

  it("PATCH with a non-boolean enabled → 400, store unchanged", async () => {
    const server = Fastify();
    registerSettingsRoutes(server, { authService: undefined, daemonSettingsFile: file });
    const res = await server.inject({
      method: "PATCH",
      payload: { enabled: "yes", range: "23:00-08:00" },
      url: "/api/settings/quiet-hours"
    });
    expect(res.statusCode).toBe(400);
    expect(readQuietHoursSettingSync(file)).toBeUndefined();
    await server.close();
  });

  it("PATCH route is absent (404) when no daemonSettingsFile is configured", async () => {
    const server = Fastify();
    registerSettingsRoutes(server, { authService: undefined });
    const res = await server.inject({ method: "PATCH", payload: { enabled: true, range: "23:00-08:00" }, url: "/api/settings/quiet-hours" });
    expect(res.statusCode).toBe(404);
    await server.close();
  });
});
