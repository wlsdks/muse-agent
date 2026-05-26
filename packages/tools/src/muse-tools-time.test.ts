import type { JsonObject } from "@muse/shared";
import { describe, expect, it } from "vitest";

import {
  createCronForDatetimeTool,
  createNextWeekdayTool,
  createTimeAddTool,
  createTimeDiffTool,
  createTimeNowTool,
  createTimeRelativeTool
} from "./muse-tools-time.js";

const ctx = { runId: "test" } as const;
const NOW = () => new Date("2026-01-15T12:00:00.000Z"); // a Thursday
const call = (tool: { execute: (a: JsonObject, c: typeof ctx) => unknown }, args: JsonObject) =>
  tool.execute(args, ctx) as Record<string, unknown>;

describe("time_now", () => {
  it("reports ISO/epoch/timezone and a weekday for a valid IANA zone", () => {
    const out = call(createTimeNowTool(NOW), { timezone: "Asia/Seoul" });
    expect(out["iso"]).toBe("2026-01-15T12:00:00.000Z");
    expect(out["epochMs"]).toBe(NOW().getTime());
    expect(out["timezone"]).toBe("Asia/Seoul");
    expect(out["dayOfWeek"]).toBe("Thursday"); // 21:00 KST, still Thursday
    expect(typeof out["formatted"]).toBe("string");
  });

  it("defaults to UTC and rejects an unsupported timezone", () => {
    expect(call(createTimeNowTool(NOW), {})["timezone"]).toBe("UTC");
    expect(call(createTimeNowTool(NOW), { timezone: "Mars/Phobos" })["error"]).toContain("unsupported timezone");
  });
});

describe("time_diff", () => {
  it("computes a signed duration with a humanized string", () => {
    expect(call(createTimeDiffTool(), { from: "2026-01-15T00:00:00Z", to: "2026-01-15T01:30:00Z" }))
      .toEqual({ humanized: "1h 30m", milliseconds: 5_400_000 });
    expect(call(createTimeDiffTool(), { from: "2026-01-15T01:30:00Z", to: "2026-01-15T00:00:00Z" }))
      .toEqual({ humanized: "-1h 30m", milliseconds: -5_400_000 });
  });

  it("rejects a non-ISO input", () => {
    expect(call(createTimeDiffTool(), { from: "nope", to: "2026-01-15T00:00:00Z" })["error"]).toContain("ISO-8601");
  });
});

describe("time_add", () => {
  it("sums signed offsets onto the base", () => {
    expect(call(createTimeAddTool(), { base: "2026-01-15T00:00:00Z", days: 1, hours: 2 }))
      .toEqual({ iso: "2026-01-16T02:00:00.000Z", offsetMs: 93_600_000 });
    expect(call(createTimeAddTool(), { base: "2026-01-15T00:00:00Z", minutes: -90 })["iso"])
      .toBe("2026-01-14T22:30:00.000Z");
  });

  it("rejects a bad base", () => {
    expect(call(createTimeAddTool(), { base: "later" })["error"]).toContain("base must be");
  });
});

describe("time_relative", () => {
  it("describes future/past/now relative to the injected clock", () => {
    expect(call(createTimeRelativeTool(NOW), { at: "2026-01-15T14:00:00Z" }))
      .toMatchObject({ direction: "future", humanized: "in 2h" });
    expect(call(createTimeRelativeTool(NOW), { at: "2026-01-15T09:00:00Z" }))
      .toMatchObject({ direction: "past", humanized: "3h ago" });
    expect(call(createTimeRelativeTool(NOW), { at: "2026-01-15T12:00:00Z" })["direction"]).toBe("now");
  });

  it("honours an explicit reference and rejects a bad one", () => {
    expect(call(createTimeRelativeTool(NOW), { at: "2026-01-16T12:00:00Z", reference: "2026-01-15T12:00:00Z" }))
      .toMatchObject({ direction: "future", humanized: "in 1d" });
    expect(call(createTimeRelativeTool(NOW), { at: "2026-01-15T12:00:00Z", reference: "bad" })["error"]).toContain("reference");
  });
});

describe("next_weekday_date", () => {
  it("resolves the strictly-next occurrence (full name + abbreviation, case-insensitive)", () => {
    // reference Thu 2026-01-15
    expect(call(createNextWeekdayTool(NOW), { weekday: "friday" })["iso"]).toBe("2026-01-16");
    expect(call(createNextWeekdayTool(NOW), { weekday: "MON" })["iso"]).toBe("2026-01-19");
    // same weekday as the reference → one week later, never "today"
    expect(call(createNextWeekdayTool(NOW), { weekday: "thursday" })["iso"]).toBe("2026-01-22");
  });

  it("rejects an unknown weekday", () => {
    expect(call(createNextWeekdayTool(NOW), { weekday: "funday" })["error"]).toContain("weekday must be one of");
  });
});

describe("cron_for_datetime", () => {
  it("builds per-mode cron expressions from an ISO datetime", () => {
    const iso = "2026-03-15T09:30:00Z";
    expect(call(createCronForDatetimeTool(), { iso })["cron"]).toBe("30 9 15 3 *"); // once → yearly on that date
    expect(call(createCronForDatetimeTool(), { iso, mode: "daily" })["cron"]).toBe("30 9 * * *");
    expect(call(createCronForDatetimeTool(), { iso, mode: "monthly" })["cron"]).toBe("30 9 15 * *");
    expect(call(createCronForDatetimeTool(), { iso, mode: "weekly" })["cron"]).toMatch(/^30 9 \* \* [0-6]$/u);
  });

  it("warns that a monthly day > 28 won't fire every month", () => {
    const out = call(createCronForDatetimeTool(), { iso: "2026-01-30T08:00:00Z", mode: "monthly" });
    expect(out["cron"]).toBe("0 8 30 * *");
    expect(out["warning"]).toContain("will not fire");
  });

  it("rejects a bad mode or a bad ISO", () => {
    expect(call(createCronForDatetimeTool(), { iso: "2026-01-30T08:00:00Z", mode: "hourly" })["error"]).toContain("mode must be");
    expect(call(createCronForDatetimeTool(), { iso: "whenever" })["error"]).toContain("invalid ISO-8601");
  });
});
