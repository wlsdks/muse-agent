import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { isSchedulerPaused, readSchedulerPauseState, setSchedulerPaused } from "../src/index.js";

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), "muse-schedpause-")), "scheduler-paused.json");
}

describe("scheduler pause store", () => {
  it("reads a missing file as NOT paused (fail-open)", async () => {
    expect(await readSchedulerPauseState(tmpFile())).toEqual({ paused: false });
  });

  it("round-trips a pause with a since timestamp", async () => {
    const file = tmpFile();
    await setSchedulerPaused(file, true, "2026-06-25T00:00:00.000Z");
    expect(await readSchedulerPauseState(file)).toEqual({ paused: true, since: "2026-06-25T00:00:00.000Z" });
    expect(await isSchedulerPaused(file)).toBe(true);
  });

  it("resume clears the pause", async () => {
    const file = tmpFile();
    await setSchedulerPaused(file, true, "2026-06-25T00:00:00.000Z");
    await setSchedulerPaused(file, false);
    expect(await isSchedulerPaused(file)).toBe(false);
  });

  it("fail-opens (NOT paused) on a corrupt file", async () => {
    const file = tmpFile();
    const { writeFile } = await import("node:fs/promises");
    await writeFile(file, "{not json", "utf8");
    expect(await isSchedulerPaused(file)).toBe(false);
  });
});
