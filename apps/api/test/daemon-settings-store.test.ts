import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { effectiveDaemonEnabled, readDaemonSettingsSync, writeDaemonSetting } from "../src/daemon-settings-store.js";

// UI daemon toggles: a mutable settings file the console can PATCH,
// consulted ahead of the env flag — env stays the launcher-level default,
// the file is the user's live choice.

describe("daemon-settings-store", () => {
  it("write → sync read round-trips a toggle", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "muse-dset-")), "daemon-settings.json");
    await writeDaemonSetting(file, "MUSE_TELEGRAM_POLL_ENABLED", true);
    await writeDaemonSetting(file, "MUSE_INBOUND_REPLY_ENABLED", false);
    expect(readDaemonSettingsSync(file)).toEqual({
      MUSE_INBOUND_REPLY_ENABLED: false,
      MUSE_TELEGRAM_POLL_ENABLED: true
    });
  });

  it("missing/corrupt file reads as empty (env keeps deciding)", () => {
    expect(readDaemonSettingsSync("/nonexistent/daemon-settings.json")).toEqual({});
  });

  it("effectiveDaemonEnabled: file overrides env in BOTH directions, env fills the gaps", () => {
    const settings = { MUSE_TELEGRAM_POLL_ENABLED: false, MUSE_MATRIX_POLL_ENABLED: true };
    const env = { MUSE_MATRIX_POLL_ENABLED: "0", MUSE_TELEGRAM_POLL_ENABLED: "1", MUSE_INBOUND_REPLY_ENABLED: "1" };
    expect(effectiveDaemonEnabled("MUSE_TELEGRAM_POLL_ENABLED", env, settings)).toBe(false);
    expect(effectiveDaemonEnabled("MUSE_MATRIX_POLL_ENABLED", env, settings)).toBe(true);
    expect(effectiveDaemonEnabled("MUSE_INBOUND_REPLY_ENABLED", env, settings)).toBe(true);
    expect(effectiveDaemonEnabled("MUSE_HOME_WATCH_ENABLED", env, settings)).toBe(false);
  });
});
