import { describe, expect, it } from "vitest";

import { formatRecordedAtIso } from "./commands-telemetry.js";

describe("formatRecordedAtIso (telemetry render-path defence against corrupt ms)", () => {
  it("converts a normal ms to ISO-8601", () => {
    expect(formatRecordedAtIso(1700000000000)).toBe(new Date(1700000000000).toISOString());
    expect(formatRecordedAtIso(0)).toBe(new Date(0).toISOString());
  });

  it("falls back to (invalid) when ms is NaN, Infinity or -Infinity (would crash toISOString)", () => {
    expect(formatRecordedAtIso(Number.NaN)).toBe("(invalid)");
    expect(formatRecordedAtIso(Number.POSITIVE_INFINITY)).toBe("(invalid)");
    expect(formatRecordedAtIso(Number.NEGATIVE_INFINITY)).toBe("(invalid)");
  });

  it("falls back to (invalid) when ms exceeds the Date range (RangeError defence — protects the whole telemetry render from a single corrupt event)", () => {
    expect(formatRecordedAtIso(9e15 + 1)).toBe("(invalid)");
    expect(formatRecordedAtIso(-9e15 - 1)).toBe("(invalid)");
  });

  it("falls back to (invalid) when ms is the wrong type (defensive against an API drift in the SummaryResponse / RecentResponse contract)", () => {
    expect(formatRecordedAtIso(undefined as unknown as number)).toBe("(invalid)");
    expect(formatRecordedAtIso("1700000000000" as unknown as number)).toBe("(invalid)");
    expect(formatRecordedAtIso(null as unknown as number)).toBe("(invalid)");
  });
});
