import { describe, expect, it } from "vitest";

import { formatTaskDate } from "./Tasks.js";

describe("formatTaskDate — honors the active UI locale", () => {
  const iso = "2026-06-13T10:00:00Z";

  it("formats in the given locale, not the host default", () => {
    expect(formatTaskDate(iso, "ko-KR")).toBe(new Date(iso).toLocaleDateString("ko-KR"));
    expect(formatTaskDate(iso, "en-US")).toBe(new Date(iso).toLocaleDateString("en-US"));
  });

  it("threads the locale through (ko and en differ)", () => {
    expect(formatTaskDate(iso, "ko-KR")).not.toBe(formatTaskDate(iso, "en-US"));
  });

  it("returns an empty string for an unparseable date — never the literal 'Invalid Date'", () => {
    // Consistency with timeUntil (Today.tsx), which already NaN-guards: a
    // malformed/missing createdAt must not render "Invalid Date" in a task row.
    expect(formatTaskDate("not-a-date", "en-US")).toBe("");
    expect(formatTaskDate("", "en-US")).toBe("");
  });
});
