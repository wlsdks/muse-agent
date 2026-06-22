import { describe, expect, it } from "vitest";

import { formatRainHeadsUp } from "../src/weather.js";

describe("formatRainHeadsUp", () => {
  it("extracts HH:MM from an ISO timestamp and appends the probability", () => {
    expect(formatRainHeadsUp({ atIso: "2026-05-29T14:30:00Z", condition: "light rain", probabilityPct: 80 })).toBe(
      "rain likely ~14:30 (light rain, 80%)",
    );
  });

  it("omits the probability clause when it is undefined", () => {
    expect(formatRainHeadsUp({ atIso: "2026-05-29T14:30:00Z", condition: "showers" })).toBe(
      "rain likely ~14:30 (showers)",
    );
  });

  it("includes an explicit 0% probability (0 is a real value, not absent)", () => {
    expect(formatRainHeadsUp({ atIso: "2026-05-29T09:05:00Z", condition: "drizzle", probabilityPct: 0 })).toBe(
      "rain likely ~09:05 (drizzle, 0%)",
    );
  });

  it("falls back to the raw atIso when there is no T-time component", () => {
    expect(formatRainHeadsUp({ atIso: "soon", condition: "rain" })).toBe("rain likely ~soon (rain)");
    expect(formatRainHeadsUp({ atIso: "2026-05-29", condition: "rain", probabilityPct: 50 })).toBe(
      "rain likely ~2026-05-29 (rain, 50%)",
    );
  });
});
