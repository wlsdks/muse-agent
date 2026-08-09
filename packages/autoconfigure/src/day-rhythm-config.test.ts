import { mkdtempSync, writeFileSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DAY_RHYTHM_DEFAULT_EVENING_HOUR,
  DAY_RHYTHM_DEFAULT_MORNING_HOUR,
  normalizeDayRhythmConfig,
  readDayRhythmConfig,
  readDayRhythmConfigSafe,
  writeDayRhythmConfig
} from "./day-rhythm-config.js";

function tmpConfigFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "muse-day-rhythm-cfg-"));
  return join(dir, "config.json");
}

describe("normalizeDayRhythmConfig", () => {
  it("absent block ⇒ disabled defaults", () => {
    expect(normalizeDayRhythmConfig(undefined)).toEqual({
      enabled: false,
      eveningHour: DAY_RHYTHM_DEFAULT_EVENING_HOUR,
      morningHour: DAY_RHYTHM_DEFAULT_MORNING_HOUR
    });
  });

  it("non-object raw ⇒ disabled defaults, never throws", () => {
    expect(normalizeDayRhythmConfig("not an object")).toEqual({
      enabled: false,
      eveningHour: DAY_RHYTHM_DEFAULT_EVENING_HOUR,
      morningHour: DAY_RHYTHM_DEFAULT_MORNING_HOUR
    });
    expect(normalizeDayRhythmConfig(null)).toEqual({
      enabled: false,
      eveningHour: DAY_RHYTHM_DEFAULT_EVENING_HOUR,
      morningHour: DAY_RHYTHM_DEFAULT_MORNING_HOUR
    });
  });

  it("honors explicit enabled + custom hours", () => {
    expect(normalizeDayRhythmConfig({ enabled: true, eveningHour: 20, morningHour: 7 })).toEqual({
      enabled: true,
      eveningHour: 20,
      morningHour: 7
    });
  });

  it("rejects an out-of-range or non-integer hour, falling back to the default", () => {
    expect(normalizeDayRhythmConfig({ enabled: true, morningHour: 24 }).morningHour).toBe(DAY_RHYTHM_DEFAULT_MORNING_HOUR);
    expect(normalizeDayRhythmConfig({ enabled: true, morningHour: -1 }).morningHour).toBe(DAY_RHYTHM_DEFAULT_MORNING_HOUR);
    expect(normalizeDayRhythmConfig({ enabled: true, morningHour: 8.5 }).morningHour).toBe(DAY_RHYTHM_DEFAULT_MORNING_HOUR);
    expect(normalizeDayRhythmConfig({ enabled: true, morningHour: "8" }).morningHour).toBe(DAY_RHYTHM_DEFAULT_MORNING_HOUR);
  });

  it("a non-true enabled value (string, 1, undefined) never coerces on", () => {
    expect(normalizeDayRhythmConfig({ enabled: "true" }).enabled).toBe(false);
    expect(normalizeDayRhythmConfig({ enabled: 1 }).enabled).toBe(false);
  });
});

describe("readDayRhythmConfig / writeDayRhythmConfig", () => {
  it("an absent file reads as disabled defaults (fresh install)", async () => {
    const file = tmpConfigFile();
    expect(await readDayRhythmConfig(file)).toEqual({
      enabled: false,
      eveningHour: DAY_RHYTHM_DEFAULT_EVENING_HOUR,
      morningHour: DAY_RHYTHM_DEFAULT_MORNING_HOUR
    });
  });

  it("write then read round-trips", async () => {
    const file = tmpConfigFile();
    await writeDayRhythmConfig(file, { enabled: true, eveningHour: 19, morningHour: 9 });
    expect(await readDayRhythmConfig(file)).toEqual({ enabled: true, eveningHour: 19, morningHour: 9 });
  });

  it("preserves apiUrl/defaultModel that predate the write (read-merge-write, no collateral loss)", async () => {
    const file = tmpConfigFile();
    await writeFile(file, `${JSON.stringify({ apiUrl: "http://api.example", defaultModel: "ollama/gemma4:12b" })}\n`);
    await writeDayRhythmConfig(file, { enabled: true, eveningHour: 18, morningHour: 8 });
    const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    expect(raw.apiUrl).toBe("http://api.example");
    expect(raw.defaultModel).toBe("ollama/gemma4:12b");
    expect(raw.dayRhythm).toEqual({ enabled: true, eveningHour: 18, morningHour: 8 });
  });

  it("a later write does not resurrect a previously-cleared field (disabling round-trips false)", async () => {
    const file = tmpConfigFile();
    await writeDayRhythmConfig(file, { enabled: true, eveningHour: 18, morningHour: 8 });
    await writeDayRhythmConfig(file, { enabled: false, eveningHour: 18, morningHour: 8 });
    expect((await readDayRhythmConfig(file)).enabled).toBe(false);
  });

  it("rejects a config file that isn't valid JSON", async () => {
    const file = tmpConfigFile();
    await writeFile(file, "not json");
    await expect(readDayRhythmConfig(file)).rejects.toThrow(/not valid JSON/);
  });

  it.skipIf(process.platform === "win32")("writes the file with owner-only POSIX permissions", async () => {
    const file = tmpConfigFile();
    await writeDayRhythmConfig(file, { enabled: true, eveningHour: 18, morningHour: 8 });
    const mode = (await stat(file)).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe("readDayRhythmConfigSafe — the daemon's per-tick reader", () => {
  it("a corrupt config file resolves to DISABLED defaults instead of throwing", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "muse-dayrhythm-")), "config.json");
    writeFileSync(file, "{not json");
    await expect(readDayRhythmConfigSafe(file)).resolves.toEqual({
      enabled: false,
      eveningHour: DAY_RHYTHM_DEFAULT_EVENING_HOUR,
      morningHour: DAY_RHYTHM_DEFAULT_MORNING_HOUR
    });
  });

  it("a healthy enabled config passes through unchanged", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "muse-dayrhythm-")), "config.json");
    writeFileSync(file, JSON.stringify({ dayRhythm: { enabled: true, eveningHour: 19, morningHour: 7 } }));
    await expect(readDayRhythmConfigSafe(file)).resolves.toEqual({ enabled: true, eveningHour: 19, morningHour: 7 });
  });
});
