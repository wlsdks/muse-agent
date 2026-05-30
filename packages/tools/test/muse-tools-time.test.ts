import type { JsonObject } from "@muse/shared";
import { describe, expect, it } from "vitest";

import {
  createCronForDatetimeTool,
  createNextWeekdayTool,
  createTimeAddTool,
  createTimeDiffTool,
  createTimeNowTool,
  createTimeRelativeTool
} from "../src/muse-tools-time.js";

// Direct OUTPUT-correctness coverage for the built-in time/date/scheduling
// tools (untested module). `eval:tools` proves the local model SELECTS these,
// but nothing asserted the HANDLER returns the right answer — and a wrong
// duration / weekday / cron is a confident wrong answer the agent hands the
// user. All known-answer with an injected clock (no real wall-clock flake).

const FIXED = new Date("2026-05-30T12:34:56.000Z"); // a Saturday
const now = (): Date => FIXED;
const run = (tool: { execute: (a: JsonObject) => JsonObject }, args: JsonObject): JsonObject => tool.execute(args);

describe("time_now", () => {
  it("returns the injected instant as ISO / epoch / day-of-week / timezone", () => {
    expect(run(createTimeNowTool(now), {})).toEqual({
      dayOfWeek: "Saturday",
      epochMs: FIXED.getTime(),
      formatted: "2026-05-30, 12:34:56 p.m. UTC",
      iso: "2026-05-30T12:34:56.000Z",
      timezone: "UTC"
    });
  });

  it("errors (does not throw) on an unsupported timezone", () => {
    expect(run(createTimeNowTool(now), { timezone: "Mars/Phobos" })).toEqual({ error: "unsupported timezone: Mars/Phobos" });
  });
});

describe("time_diff", () => {
  it("computes a signed duration + humanized string", () => {
    expect(run(createTimeDiffTool(), { from: "2026-01-01T00:00:00Z", to: "2026-01-01T01:30:00Z" }))
      .toEqual({ humanized: "1h 30m", milliseconds: 5_400_000 });
  });

  it("returns a NEGATIVE duration when `to` precedes `from`", () => {
    expect(run(createTimeDiffTool(), { from: "2026-01-01T01:00:00Z", to: "2026-01-01T00:00:00Z" }))
      .toEqual({ humanized: "-1h", milliseconds: -3_600_000 });
  });

  it("errors on a non-ISO timestamp", () => {
    expect(run(createTimeDiffTool(), { from: "nope", to: "2026-01-01T00:00:00Z" }))
      .toEqual({ error: "from/to must be valid ISO-8601 strings" });
  });
});

describe("time_add", () => {
  it("sums all offset fields onto the base", () => {
    expect(run(createTimeAddTool(), { base: "2026-01-01T00:00:00Z", days: 1, hours: 2 }))
      .toEqual({ iso: "2026-01-02T02:00:00.000Z", offsetMs: 93_600_000 });
  });

  it("accepts a negative offset and a base-only call (zero offset)", () => {
    expect(run(createTimeAddTool(), { base: "2026-01-01T00:00:00Z", minutes: -30 }))
      .toEqual({ iso: "2025-12-31T23:30:00.000Z", offsetMs: -1_800_000 });
    expect(run(createTimeAddTool(), { base: "2026-01-01T00:00:00Z" }))
      .toEqual({ iso: "2026-01-01T00:00:00.000Z", offsetMs: 0 });
  });

  it("errors on an invalid base", () => {
    expect(run(createTimeAddTool(), { base: "xx" })).toEqual({ error: "base must be a valid ISO-8601 string" });
  });
});

describe("time_relative", () => {
  it("describes a future / past / now delta with the right direction", () => {
    expect(run(createTimeRelativeTool(now), { at: "2026-05-30T14:34:56Z" }))
      .toEqual({ deltaMs: 7_200_000, direction: "future", humanized: "in 2h" });
    expect(run(createTimeRelativeTool(now), { at: "2026-05-27T12:34:56Z" }))
      .toEqual({ deltaMs: -259_200_000, direction: "past", humanized: "3d ago" });
    expect(run(createTimeRelativeTool(now), { at: "2026-05-30T12:34:56.500Z" }))
      .toEqual({ deltaMs: 500, direction: "now", humanized: "just now" }); // sub-second → "now"
  });

  it("pins the comparison to an explicit reference when given", () => {
    expect(run(createTimeRelativeTool(now), { at: "2026-01-02T00:00:00Z", reference: "2026-01-01T00:00:00Z" }))
      .toEqual({ deltaMs: 86_400_000, direction: "future", humanized: "in 1d" });
  });

  it("errors on an invalid `at` or `reference`", () => {
    expect(run(createTimeRelativeTool(now), { at: "xx" })).toEqual({ error: "at must be a valid ISO-8601 string" });
    expect(run(createTimeRelativeTool(now), { at: "2026-01-01T00:00:00Z", reference: "xx" }))
      .toEqual({ error: "reference must be a valid ISO-8601 string" });
  });
});

describe("next_weekday_date", () => {
  it("resolves the NEXT upcoming occurrence (strictly future) of a named weekday", () => {
    expect(run(createNextWeekdayTool(now), { weekday: "monday" })).toEqual({ iso: "2026-06-01", weekday: "monday" });
  });

  it("returns the occurrence ONE WEEK later when the reference is itself that weekday", () => {
    // FIXED is a Saturday — asking for Saturday must skip today and land next week.
    expect(run(createNextWeekdayTool(now), { weekday: "sat" })).toEqual({ iso: "2026-06-06", weekday: "saturday" });
  });

  it("honors a 3-letter abbreviation and an explicit reference", () => {
    expect(run(createNextWeekdayTool(now), { weekday: "wed", reference: "2026-05-30T00:00:00Z" }))
      .toEqual({ iso: "2026-06-03", weekday: "wednesday" });
  });

  it("errors on an unknown weekday or invalid reference", () => {
    expect(run(createNextWeekdayTool(now), { weekday: "funday" }))
      .toEqual({ error: "weekday must be one of: sunday, monday, tuesday, wednesday, thursday, friday, saturday" });
    expect(run(createNextWeekdayTool(now), { weekday: "monday", reference: "xx" }))
      .toEqual({ error: "reference must be a valid ISO-8601 string" });
  });
});

describe("cron_for_datetime", () => {
  it("builds the right expression per mode (UTC fields)", () => {
    const tool = createCronForDatetimeTool();
    expect(run(tool, { iso: "2026-05-30T09:05:00Z" })).toEqual({ cron: "5 9 30 5 *", iso: "2026-05-30T09:05:00.000Z", mode: "once" });
    expect(run(tool, { iso: "2026-05-30T09:05:00Z", mode: "daily" })).toEqual({ cron: "5 9 * * *", iso: "2026-05-30T09:05:00.000Z", mode: "daily" });
    expect(run(tool, { iso: "2026-05-30T09:05:00Z", mode: "weekly" })).toEqual({ cron: "5 9 * * 6", iso: "2026-05-30T09:05:00.000Z", mode: "weekly" }); // Sat = 6
    expect(run(tool, { iso: "2026-05-15T09:05:00Z", mode: "monthly" })).toEqual({ cron: "5 9 15 * *", iso: "2026-05-15T09:05:00.000Z", mode: "monthly" });
  });

  it("warns when a monthly day-of-month > 28 (would silently skip short months)", () => {
    const out = run(createCronForDatetimeTool(), { iso: "2026-05-31T09:05:00Z", mode: "monthly" });
    expect(out).toMatchObject({ cron: "5 9 31 * *", mode: "monthly" });
    expect(out.warning).toContain("will not fire in months without that day");
  });

  it("errors on an unknown mode or invalid / missing iso", () => {
    const tool = createCronForDatetimeTool();
    expect(run(tool, { iso: "2026-05-30T09:05:00Z", mode: "hourly" }))
      .toEqual({ error: "mode must be one of: once, daily, weekly, monthly (got 'hourly')" });
    expect(run(tool, { iso: "nope" })).toEqual({ error: "invalid ISO-8601 datetime: 'nope'" });
    expect(run(tool, { iso: "   " })).toEqual({ error: "iso is required" });
  });
});
