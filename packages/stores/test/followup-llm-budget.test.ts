import { mkdtemp, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  formatLocalDay,
  incrementFollowupLlmBudget,
  isFollowupLlmBudgetExhausted,
  readFollowupLlmBudget,
  writeFollowupLlmBudget
} from "../src/personal-followup-llm-budget-store.js";

describe("formatLocalDay", () => {
  it("renders the LOCAL date as zero-padded YYYY-MM-DD", () => {
    expect(formatLocalDay(new Date(2026, 0, 5, 10, 0, 0))).toBe("2026-01-05"); // Jan = month 0 → "01", day padded
    expect(formatLocalDay(new Date(2026, 8, 3, 0, 0, 0))).toBe("2026-09-03"); // single-digit month + day both padded
  });
});

describe("isFollowupLlmBudgetExhausted", () => {
  it("is fail-closed on a non-positive / non-finite cap (a misconfigured cap blocks, never allows infinite)", () => {
    expect(isFollowupLlmBudgetExhausted({ calls: 0, date: "2026-06-01" }, "2026-06-01", 0)).toBe(true);
    expect(isFollowupLlmBudgetExhausted(undefined, "2026-06-01", -1)).toBe(true);
    expect(isFollowupLlmBudgetExhausted(undefined, "2026-06-01", Number.NaN)).toBe(true);
  });

  it("is not exhausted with no record, and only at/over the cap for today's record", () => {
    expect(isFollowupLlmBudgetExhausted(undefined, "2026-06-01", 5)).toBe(false); // fresh install
    expect(isFollowupLlmBudgetExhausted({ calls: 4, date: "2026-06-01" }, "2026-06-01", 5)).toBe(false);
    expect(isFollowupLlmBudgetExhausted({ calls: 5, date: "2026-06-01" }, "2026-06-01", 5)).toBe(true);
  });

  it("treats yesterday's exhausted record as not-exhausted today (the day rolled over)", () => {
    expect(isFollowupLlmBudgetExhausted({ calls: 999, date: "2026-05-31" }, "2026-06-01", 5)).toBe(false);
  });
});

describe("incrementFollowupLlmBudget", () => {
  let file: string;
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "muse-llm-budget-")); file = join(dir, "budget.json"); });
  afterEach(async () => { await rm(dir, { force: true, recursive: true }); });

  it("starts at 1, accumulates within the same day, and RESETS to 1 when the day rolls over", async () => {
    expect(await incrementFollowupLlmBudget(file, "2026-06-01")).toEqual({ calls: 1, date: "2026-06-01" });
    expect(await incrementFollowupLlmBudget(file, "2026-06-01")).toEqual({ calls: 2, date: "2026-06-01" });
    expect(await incrementFollowupLlmBudget(file, "2026-06-02")).toEqual({ calls: 1, date: "2026-06-02" }); // rollover
  });

  it("increments from the latest cross-process state after waiting for the file lock", async () => {
    await incrementFollowupLlmBudget(file, "2026-06-01");
    await writeFile(`${file}.lock`, "external writer", { flag: "wx" });
    const localIncrement = incrementFollowupLlmBudget(file, "2026-06-01");
    await sleep(300);
    await writeFile(file, `${JSON.stringify({ calls: 9, date: "2026-06-01" }, null, 2)}\n`);
    await unlink(`${file}.lock`);

    await expect(localIncrement).resolves.toEqual({ calls: 10, date: "2026-06-01" });
  });
});

describe("writeFollowupLlmBudget — atomic write survives same-millisecond concurrent writers", () => {
  let file: string;
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "muse-llm-budget-atomic-")); file = join(dir, "budget.json"); });
  afterEach(async () => { vi.restoreAllMocks(); await rm(dir, { force: true, recursive: true }); });

  it("two concurrent writes with a frozen clock both resolve and leave no .tmp orphan", async () => {
    // Freeze Date.now so the OLD hand-rolled `tmp-${pid}-${Date.now()}` name collides
    // by construction — the slower rename hit ENOENT and rejected. The shared
    // atomicWriteFile uses a randomUUID tmp, so both writes succeed with no litter.
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    await Promise.all([
      writeFollowupLlmBudget(file, { calls: 1, date: "2026-06-01" }),
      writeFollowupLlmBudget(file, { calls: 2, date: "2026-06-01" })
    ]);
    const persisted = await readFollowupLlmBudget(file);
    expect(persisted?.date).toBe("2026-06-01");
    expect([1, 2]).toContain(persisted?.calls); // one write won; neither crashed on rename
    const leftover = (await readdir(dir)).filter((n) => n.includes(".tmp-"));
    expect(leftover).toEqual([]); // no orphaned tmp litter
  });
});
