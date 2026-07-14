import { describe, expect, it } from "vitest";

import { parseCadence } from "./cadence-parser.js";

describe("parseCadence — deterministic KO+EN cadence → cron expression", () => {
  const cases: ReadonlyArray<[string, string]> = [
    ["매일 09:00", "0 9 * * *"],
    ["daily 9am", "0 9 * * *"],
    ["every day at 09:00", "0 9 * * *"],
    ["매일 아침 9시", "0 9 * * *"],
    ["매일 오후 3시", "0 15 * * *"],
    ["매주 월요일 9시", "0 9 * * 1"],
    ["every monday 9am", "0 9 * * 1"],
    ["every Friday 6:30pm", "30 18 * * 5"],
    ["평일 9시", "0 9 * * 1-5"],
    ["weekdays 9am", "0 9 * * 1-5"],
    ["매시간", "0 * * * *"],
    ["hourly", "0 * * * *"],
    ["30분마다", "*/30 * * * *"],
    ["every 15 minutes", "*/15 * * * *"],
    ["every 5 mins", "*/5 * * * *"]
  ];

  it.each(cases)("parses %s -> %s", (raw, expectedCron) => {
    const result = parseCadence(raw);
    expect(result).not.toBeInstanceOf(Error);
    expect((result as { cronExpression: string }).cronExpression).toBe(expectedCron);
  });

  it("rejects an unrecognized cadence with a fail-close error listing accepted forms", () => {
    const result = parseCadence("whenever I feel like it");
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain("Accepted forms");
  });

  it("rejects a daily/weekly cadence missing a time-of-day (no guessing)", () => {
    const result = parseCadence("매일");
    expect(result).toBeInstanceOf(Error);
  });

  it("rejects a minute interval out of the 1-59 cron range", () => {
    const result = parseCadence("every 90 minutes");
    expect(result).toBeInstanceOf(Error);
  });

  it("rejects blank input", () => {
    expect(parseCadence("")).toBeInstanceOf(Error);
    expect(parseCadence("   ")).toBeInstanceOf(Error);
  });

  it("KO noon/midnight edge: 오전 12시 -> 0, 오후 12시 -> 12", () => {
    expect((parseCadence("매일 오전 12시") as { cronExpression: string }).cronExpression).toBe("0 0 * * *");
    expect((parseCadence("매일 오후 12시") as { cronExpression: string }).cronExpression).toBe("0 12 * * *");
  });

  it("KO colloquial midnight: 밤/저녁 12시 -> 0, not noon", () => {
    expect((parseCadence("매일 밤 12시") as { cronExpression: string }).cronExpression).toBe("0 0 * * *");
    expect((parseCadence("매일 저녁 12시") as { cronExpression: string }).cronExpression).toBe("0 0 * * *");
    expect((parseCadence("매일 밤 11시") as { cronExpression: string }).cronExpression).toBe("0 23 * * *");
  });
});
