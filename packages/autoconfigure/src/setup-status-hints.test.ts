import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { collectSetupStatusJson } from "./setup-status.js";

/**
 * The "materialises on first …" next-step hints must name REAL commands. The
 * groups are `muse tasks` / `muse calendar` — `muse task` / `muse cal` are
 * unknown commands, so the old copy-paste hints hard-failed for a new user.
 */
describe("collectSetupStatusJson — copy-paste next-step hints name real commands", () => {
  const saved: Record<string, string | undefined> = {};
  const keys = ["MUSE_TASKS_FILE", "MUSE_CALENDAR_FILE"] as const;

  beforeEach(() => {
    for (const k of keys) saved[k] = process.env[k];
    const dir = mkdtempSync(join(tmpdir(), "muse-setup-hints-"));
    // Point at not-yet-created files so the "materialises" nextStep fires.
    process.env.MUSE_TASKS_FILE = join(dir, "tasks.json");
    process.env.MUSE_CALENDAR_FILE = join(dir, "calendar.json");
  });

  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("tasks hint points at `muse tasks add` (not `muse task add`)", async () => {
    const snap = await collectSetupStatusJson();
    expect(snap.tasks.nextStep).toContain("muse tasks add");
    expect(snap.tasks.nextStep).not.toMatch(/muse task add/u);
  });

  it("local calendar hint points at `muse calendar add` (not `muse cal add`)", async () => {
    const snap = await collectSetupStatusJson();
    expect(snap.calendar.local.nextStep).toContain("muse calendar add");
    expect(snap.calendar.local.nextStep).not.toMatch(/muse cal add/u);
  });
});
