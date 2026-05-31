import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  formatLocalDay,
  incrementFollowupLlmBudget,
  isFollowupLlmBudgetExhausted
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
});
