import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { collectSetupStatusJson, resolveDailyBriefSetupStatus } from "./setup-status.js";

describe("resolveDailyBriefSetupStatus — pure resolver (R2-3 row pattern)", () => {
  it("not configured → info row pointing at `muse setup briefing`", () => {
    expect(resolveDailyBriefSetupStatus(undefined)).toEqual({
      enabled: false,
      nextStep: "muse setup briefing",
      status: "info"
    });
  });

  it("configured but disabled (e.g. `muse setup briefing --off`) → still info", () => {
    expect(resolveDailyBriefSetupStatus({ enabled: false, time: "08:30" })).toEqual({
      enabled: false,
      nextStep: "muse setup briefing",
      status: "info"
    });
  });

  it("enabled → ok row carrying the configured time", () => {
    expect(resolveDailyBriefSetupStatus({ enabled: true, time: "07:15" })).toEqual({
      enabled: true,
      status: "ok",
      time: "07:15"
    });
  });
});

describe("collectSetupStatusJson — dailyBrief row reads the real daemon config file", () => {
  function tmpDaemonConfigFile(): string {
    return join(mkdtempSync(join(tmpdir(), "muse-setup-status-daily-brief-")), "daemon.json");
  }

  it("no daemon config file yet → dailyBrief.enabled is false", async () => {
    const configFile = tmpDaemonConfigFile(); // never written
    const snap = await collectSetupStatusJson({ env: { MUSE_DAEMON_CONFIG_FILE: configFile } as never });
    expect(snap.dailyBrief).toEqual({ enabled: false, nextStep: "muse setup briefing", status: "info" });
  });

  it("an enabled dailyBrief block in the config file surfaces as an `ok` row", async () => {
    const configFile = tmpDaemonConfigFile();
    writeFileSync(configFile, JSON.stringify({ dailyBrief: { enabled: true, time: "06:45" } }), "utf8");
    const snap = await collectSetupStatusJson({ env: { MUSE_DAEMON_CONFIG_FILE: configFile } as never });
    expect(snap.dailyBrief).toEqual({ enabled: true, status: "ok", time: "06:45" });
  });

  it("a malformed config file degrades to not-configured, never throws", async () => {
    const configFile = tmpDaemonConfigFile();
    writeFileSync(configFile, "{not json", "utf8");
    const snap = await collectSetupStatusJson({ env: { MUSE_DAEMON_CONFIG_FILE: configFile } as never });
    expect(snap.dailyBrief.enabled).toBe(false);
  });
});
