import { describe, expect, it } from "vitest";

import { safeDateTime } from "./datetime.js";

describe("safeDateTime — locale-aware date-time with a malformed-input guard", () => {
  const iso = "2026-06-13T10:00:00Z";

  it("formats a valid ISO in the given locale (same as toLocaleString)", () => {
    expect(safeDateTime(iso, "en-US")).toBe(new Date(iso).toLocaleString("en-US"));
    expect(safeDateTime(iso, "ko-KR")).toBe(new Date(iso).toLocaleString("ko-KR"));
  });

  it("returns '' for a malformed / empty date — never the literal 'Invalid Date'", () => {
    expect(safeDateTime("not-a-date", "en-US")).toBe("");
    expect(safeDateTime("", "en-US")).toBe("");
  });
});
