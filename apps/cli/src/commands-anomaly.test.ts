import { describe, expect, it } from "vitest";

import { formatAnomaly } from "./commands-anomaly.js";

describe("formatAnomaly — the muse anomaly readout", () => {
  it("says so when there's too little history", () => {
    expect(formatAnomaly([], 3)).toContain("Not enough history");
  });

  it("all-clear over enough history", () => {
    expect(formatAnomaly([], 20)).toContain("No unusual days");
  });

  it("labels a busy day and a quiet day with the σ deviation", () => {
    const out = formatAnomaly([
      { date: "2026-05-08", count: 25, median: 3, modZScore: 16, direction: "high" },
      { date: "2026-05-12", count: 0, median: 3, modZScore: -4, direction: "low" }
    ], 20);
    expect(out).toContain("much busier than usual");
    expect(out).toContain("much quieter than usual");
    expect(out).toContain("16.0σ");
    expect(out).toContain("2026-05-08");
  });
});
