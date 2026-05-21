import { describe, expect, it } from "vitest";

import { parseLimit, parseOffset } from "../src/scheduler-routes.js";

describe("scheduler-routes parseLimit — strict int parse on `?limit=` query so a typo'd / unit-slipped value falls back to the documented default instead of silently honoring the leading digits (sibling-parity with goal 625's CLI strict env-parse)", () => {
  it("parses a well-formed string limit (?limit=20 → 20)", () => {
    expect(parseLimit("20", 50, 100)).toBe(20);
  });

  it("accepts a numeric limit (when fastify already coerces) — `?limit=20` arriving as the number 20 passes through unchanged", () => {
    expect(parseLimit(20, 50, 100)).toBe(20);
  });

  it("caps at the configured max (?limit=999 with max=100 → 100)", () => {
    expect(parseLimit("999", 50, 100)).toBe(100);
  });

  it("falls back to the default when the limit is undefined / empty / zero / negative", () => {
    expect(parseLimit(undefined, 50, 100)).toBe(50);
    expect(parseLimit("", 50, 100)).toBe(50);
    expect(parseLimit("   ", 50, 100)).toBe(50);
    expect(parseLimit("0", 50, 100)).toBe(50);
    expect(parseLimit("-5", 50, 100)).toBe(50);
  });

  it("REJECTS a lenient-prefix typo / unit slip — pre-fix `Number.parseInt('100x')` returned 100 silently; post-fix it falls back to the default", () => {
    expect(parseLimit("100x", 50, 100)).toBe(50);
    expect(parseLimit("20px", 50, 100)).toBe(50);
    expect(parseLimit("7d", 50, 100)).toBe(50);
    expect(parseLimit("50; DROP TABLE", 50, 100)).toBe(50);
    expect(parseLimit("five", 50, 100)).toBe(50);
    expect(parseLimit("1.5", 50, 100)).toBe(50);
    expect(parseLimit("1e3", 50, 100)).toBe(50);
  });

  it("REJECTS hex / octal prefix — `?limit=0x10` is operator-confusing (decimal 16 vs. token-as-typed); strict-parse falls back to the default rather than guessing", () => {
    expect(parseLimit("0x10", 50, 100)).toBe(50);
    expect(parseLimit("0o20", 50, 100)).toBe(50);
  });
});

describe("scheduler-routes parseOffset — strict int parse on `?offset=` query (same defect class as parseLimit, same fix)", () => {
  it("parses a well-formed string offset and a numeric offset", () => {
    expect(parseOffset("10")).toBe(10);
    expect(parseOffset(10)).toBe(10);
  });

  it("returns 0 for undefined / empty / zero / negative", () => {
    expect(parseOffset(undefined)).toBe(0);
    expect(parseOffset("")).toBe(0);
    expect(parseOffset("0")).toBe(0);
    expect(parseOffset("-5")).toBe(0);
  });

  it("REJECTS a lenient-prefix typo / unit slip — `?offset=10x` falls back to 0, not the silently-honored leading 10", () => {
    expect(parseOffset("10x")).toBe(0);
    expect(parseOffset("7d")).toBe(0);
    expect(parseOffset("0x10")).toBe(0);
  });
});
