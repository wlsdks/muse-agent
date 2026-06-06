import { describe, expect, it } from "vitest";

import { dailyCounts, mostAnomalousDays, type DayCount } from "../src/activity-anomaly.js";

const DAY_MS = 24 * 60 * 60_000;
const day = (iso: string): number => Date.parse(`${iso}T12:00:00Z`);

describe("dailyCounts — bucket timestamps per day, zero-filling gaps", () => {
  it("counts per UTC day and fills the quiet days between", () => {
    const counts = dailyCounts([day("2026-05-01"), day("2026-05-01"), day("2026-05-03")]);
    expect(counts).toEqual([
      { count: 2, date: "2026-05-01" },
      { count: 0, date: "2026-05-02" }, // zero-filled gap → a quiet day is visible
      { count: 1, date: "2026-05-03" }
    ]);
  });

  it("returns [] for no timestamps", () => {
    expect(dailyCounts([])).toEqual([]);
  });
});

describe("mostAnomalousDays — robust (median + MAD) per-day outliers", () => {
  // 14 typical days of ~3/day, then one spike day of 30 and one silent day of 0.
  const baseline: DayCount[] = Array.from({ length: 14 }, (_, i) => ({ count: 3 + (i % 2), date: `2026-05-${String(i + 1).padStart(2, "0")}` }));
  const withSpike: DayCount[] = [...baseline, { count: 30, date: "2026-05-20" }, { count: 0, date: "2026-05-22" }];

  it("flags the spike day as a HIGH anomaly, most-extreme first", () => {
    const anomalies = mostAnomalousDays(withSpike);
    expect(anomalies[0]!.date).toBe("2026-05-20");
    expect(anomalies[0]!.direction).toBe("high");
    expect(anomalies.find((a) => a.date === "2026-05-22")?.direction).toBe("low");
  });

  it("returns [] when there's too little history", () => {
    expect(mostAnomalousDays([{ count: 1, date: "a" }, { count: 9, date: "b" }])).toEqual([]); // < minDays 7
  });

  it("returns [] when every day is identical (no spread)", () => {
    const flat: DayCount[] = Array.from({ length: 10 }, (_, i) => ({ count: 5, date: `d${i}` }));
    expect(mostAnomalousDays(flat)).toEqual([]);
  });

  it("a steady series with one clear spike: only the spike clears the threshold", () => {
    const steady: DayCount[] = Array.from({ length: 20 }, (_, i) => ({ count: 4, date: `2026-06-${String(i + 1).padStart(2, "0")}` }));
    steady[10] = { count: 40, date: "2026-06-11" };
    const anomalies = mostAnomalousDays(steady);
    expect(anomalies.map((a) => a.date)).toEqual(["2026-06-11"]);
  });

  it("integration: a real timestamp stream → dailyCounts → anomaly flags the busy day", () => {
    const stamps: number[] = [];
    const base = Date.parse("2026-05-01T00:00:00Z");
    for (let d = 0; d < 14; d++) for (let k = 0; k < 2; k++) stamps.push(base + d * DAY_MS + k * 3_600_000); // 2/day
    for (let k = 0; k < 25; k++) stamps.push(base + 7 * DAY_MS + k * 60_000); // 25 on day 7
    const anomalies = mostAnomalousDays(dailyCounts(stamps));
    expect(anomalies[0]!.date).toBe("2026-05-08");
    expect(anomalies[0]!.direction).toBe("high");
  });
});
