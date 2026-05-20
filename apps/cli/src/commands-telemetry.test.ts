import { describe, expect, it } from "vitest";

import { formatRecordedAtIso, parseTelemetryLimit, parseTelemetrySinceMs } from "./commands-telemetry.js";

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

describe("parseTelemetryLimit (strict CLI-side validation, replaces silent passthrough)", () => {
  it("returns the fallback when undefined or empty", () => {
    expect(parseTelemetryLimit(undefined)).toBe(10);
    expect(parseTelemetryLimit("")).toBe(10);
    expect(parseTelemetryLimit("   ")).toBe(10);
    expect(parseTelemetryLimit(undefined, 25)).toBe(25);
  });

  it("accepts a clean integer in [1, 500]", () => {
    expect(parseTelemetryLimit("1")).toBe(1);
    expect(parseTelemetryLimit("  20  ")).toBe(20);
    expect(parseTelemetryLimit("500")).toBe(500);
  });

  it("clamps above 500 to 500", () => {
    expect(parseTelemetryLimit("9999")).toBe(500);
  });

  it("truncates a fractional integer (.5 → integer floor)", () => {
    expect(parseTelemetryLimit("12.7")).toBe(12);
  });

  it("rejects '0', negative, NaN, typos and unit-slips with an actionable error (no silent fallback)", () => {
    expect(() => parseTelemetryLimit("0")).toThrow(/--limit must be an integer >= 1/);
    expect(() => parseTelemetryLimit("-3")).toThrow(/--limit must be an integer >= 1/);
    expect(() => parseTelemetryLimit("10x")).toThrow(/--limit must be an integer >= 1.*'10x'/);
    expect(() => parseTelemetryLimit("nope")).toThrow(/--limit must be an integer >= 1.*'nope'/);
  });
});

describe("parseTelemetrySinceMs (strict CLI-side validation)", () => {
  it("returns undefined when undefined or empty (preserving the optional-flag contract)", () => {
    expect(parseTelemetrySinceMs(undefined)).toBeUndefined();
    expect(parseTelemetrySinceMs("")).toBeUndefined();
    expect(parseTelemetrySinceMs("   ")).toBeUndefined();
  });

  it("accepts 0 and any positive ms (trimmed)", () => {
    expect(parseTelemetrySinceMs("0")).toBe(0);
    expect(parseTelemetrySinceMs("  1700000000000  ")).toBe(1700000000000);
  });

  it("truncates fractional ms", () => {
    expect(parseTelemetrySinceMs("1700000000000.5")).toBe(1700000000000);
  });

  it("rejects negative, NaN, typos with an actionable error", () => {
    expect(() => parseTelemetrySinceMs("-1")).toThrow(/--since-ms must be a non-negative integer/);
    expect(() => parseTelemetrySinceMs("1700000000000x")).toThrow(/--since-ms must be a non-negative integer.*'1700000000000x'/);
    expect(() => parseTelemetrySinceMs("yesterday")).toThrow(/--since-ms must be a non-negative integer.*'yesterday'/);
  });
});
