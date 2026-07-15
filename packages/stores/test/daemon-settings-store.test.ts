import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  readDaemonSettingsSync,
  readQuietHoursSettingSync,
  writeDaemonSetting,
  writeQuietHoursSetting
} from "../src/daemon-settings-store.js";

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "muse-daemon-settings-"));
  file = join(dir, "daemon-settings.json");
});
afterEach(async () => { await rm(dir, { force: true, recursive: true }); });

describe("daemon settings cross-process updates", () => {
  it("preserves a flag PATCH committed while a quiet-hours PATCH waits for the file lock", async () => {
    await writeDaemonSetting(file, "initial", true);
    await writeFile(`${file}.lock`, "external writer", { flag: "wx" });
    const localQuietHours = writeQuietHoursSetting(file, { enabled: true, range: "09:00-18:00" });
    await sleep(300);
    await writeFile(file, JSON.stringify({ flags: { external: true, initial: true }, version: 1 }));
    await unlink(`${file}.lock`);

    await localQuietHours;
    expect(readDaemonSettingsSync(file)).toEqual({ external: true, initial: true });
    expect(readQuietHoursSettingSync(file)).toEqual({ enabled: true, range: "09:00-18:00" });
  });
});
