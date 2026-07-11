import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { readDaemonConfig, resolveDaemonConfigFile } from "./commands-daemon-config.js";

describe("resolveDaemonConfigFile", () => {
  it("uses an explicit MUSE_DAEMON_CONFIG_FILE when set", () => {
    expect(resolveDaemonConfigFile({ MUSE_DAEMON_CONFIG_FILE: "/tmp/custom.json" } as NodeJS.ProcessEnv)).toBe("/tmp/custom.json");
  });

  it("falls back to HOME/.config/muse/daemon.json", () => {
    expect(resolveDaemonConfigFile({ HOME: "/home/me" } as NodeJS.ProcessEnv)).toBe(join("/home/me", ".config", "muse", "daemon.json"));
  });
});

describe("readDaemonConfig (tolerant)", () => {
  it("returns the parsed provider/destination from a valid file", () => {
    const dir = mkdtempSync(join(tmpdir(), "daemon-cfg-"));
    const file = join(dir, "daemon.json");
    writeFileSync(file, JSON.stringify({ provider: "telegram", destination: "123", extra: "ignored" }));
    expect(readDaemonConfig(file)).toEqual({ provider: "telegram", destination: "123" });
  });

  it("returns {} for a missing file (never throws)", () => {
    expect(readDaemonConfig(join(tmpdir(), "definitely-absent-daemon.json"))).toEqual({});
  });

  it("returns {} for a malformed file (never throws)", () => {
    const dir = mkdtempSync(join(tmpdir(), "daemon-cfg-"));
    const file = join(dir, "bad.json");
    writeFileSync(file, "{not json");
    expect(readDaemonConfig(file)).toEqual({});
  });
});
