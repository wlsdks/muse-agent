import { describe, expect, it } from "vitest";
import {
  formatCitations,
  formatLocalDate,
  formatLocalDateTime,
  formatLocalTime,
  formatRelativeTime
} from "./human-formatters.js";

describe("formatCitations", () => {
  it("returns empty string when no citations", () => {
    expect(formatCitations(undefined)).toBe("");
    expect(formatCitations([])).toBe("");
  });

  it("renders numbered Sources block", () => {
    const out = formatCitations([
      { url: "https://a.test", title: "A" },
      { url: "https://b.test", title: "B" }
    ]);
    expect(out).toBe("\n\nSources:\n  [1] A — https://a.test\n  [2] B — https://b.test");
  });
});

describe("formatLocalDateTime", () => {
  it("renders a UTC instant in Asia/Seoul (JARVIS UX — '3pm tomorrow' must round-trip)", () => {
    // 2026-12-31T23:59:00Z is 2027-01-01 08:59 KST — a user who said
    // "midnight UTC" should not see 23:59; a user in KST who said
    // "9am" expects "09:00", not "00:00".
    expect(formatLocalDateTime("2026-12-31T23:59:00Z", "Asia/Seoul"))
      .toBe("2027-01-01 08:59");
    expect(formatLocalDateTime("2026-05-14T00:00:00Z", "Asia/Seoul"))
      .toBe("2026-05-14 09:00");
  });

  it("renders identity when the requested zone is UTC", () => {
    expect(formatLocalDateTime("2026-05-14T06:00:00Z", "UTC"))
      .toBe("2026-05-14 06:00");
  });

  it("returns the input unchanged for unparseable strings", () => {
    expect(formatLocalDateTime("not-a-date")).toBe("not-a-date");
    expect(formatLocalDateTime("short")).toBe("short");
  });

  it("zero-pads midnight in the host zone (Intl 'en-CA' quirk: hour can come back as 24)", () => {
    // Midnight in America/Los_Angeles is 2026-05-14T07:00:00Z
    expect(formatLocalDateTime("2026-05-14T07:00:00Z", "America/Los_Angeles"))
      .toBe("2026-05-14 00:00");
  });
});

describe("formatLocalDate / formatLocalTime", () => {
  it("formatLocalDate returns the date slice of the local datetime (crosses date boundary in KST)", () => {
    // 2026-05-13T23:00Z is 2026-05-14 08:00 KST — date differs.
    expect(formatLocalDate("2026-05-13T23:00:00Z", "Asia/Seoul")).toBe("2026-05-14");
    expect(formatLocalDate("2026-05-13T23:00:00Z", "UTC")).toBe("2026-05-13");
  });

  it("formatLocalTime returns HH:MM in the requested zone", () => {
    expect(formatLocalTime("2026-05-14T06:00:00Z", "Asia/Seoul")).toBe("15:00");
    expect(formatLocalTime("2026-05-14T06:00:00Z", "UTC")).toBe("06:00");
  });

  it("returns the input unchanged for unparseable strings", () => {
    expect(formatLocalDate("nope")).toBe("nope");
    expect(formatLocalTime("nope")).toBe("nope");
  });
});

describe("formatRelativeTime", () => {
  const now = new Date("2026-05-18T12:00:00Z");
  const ago = (sec: number): string => new Date(now.getTime() - sec * 1000).toISOString();
  const ahead = (sec: number): string => new Date(now.getTime() + sec * 1000).toISOString();

  it("collapses sub-5s deltas to a friendly phrase (both directions)", () => {
    expect(formatRelativeTime(ago(3), now)).toBe("just now");
    expect(formatRelativeTime(ahead(3), now)).toBe("in a moment");
  });

  it("renders past deltas as 'Ns/Nm/Nh/Nd ago'", () => {
    expect(formatRelativeTime(ago(30), now)).toBe("30s ago");
    expect(formatRelativeTime(ago(300), now)).toBe("5m ago");
    expect(formatRelativeTime(ago(2 * 3600), now)).toBe("2h ago");
    expect(formatRelativeTime(ago(86400), now)).toBe("1d ago");
  });

  it("renders future deltas with an 'in N…' prefix", () => {
    expect(formatRelativeTime(ahead(45), now)).toBe("in 45s");
    expect(formatRelativeTime(ahead(3 * 3600), now)).toBe("in 3h");
    expect(formatRelativeTime(ahead(2 * 86400), now)).toBe("in 2d");
  });

  it("promotes on the rounded value at every tier ceiling", () => {
    expect(formatRelativeTime(ago(59.6), now)).toBe("1m ago");
    // 90 min rounds (1.5h → 2h) rather than reading "90m ago".
    expect(formatRelativeTime(ago(90 * 60), now)).toBe("2h ago");
  });

  it("keeps 'Nd ago' through the full ≤7d window (rounded), not just <7d", () => {
    // Regression: 6.5–7.0d round to day=7; the contract is
    // "≤ 7 d → Nd ago", so these must read "7d ago", NOT an
    // absolute timestamp (every other tier promotes on the round).
    expect(formatRelativeTime(ago(6.4 * 86400), now)).toBe("6d ago");
    expect(formatRelativeTime(ago(6.6 * 86400), now)).toBe("7d ago");
    expect(formatRelativeTime(ago(7.0 * 86400), now)).toBe("7d ago");
    expect(formatRelativeTime(ago(7.4 * 86400), now)).toBe("7d ago");
  });

  it("defers to the absolute formatter beyond 7 days", () => {
    const iso = ago(8 * 86400);
    expect(formatRelativeTime(iso, now)).toBe(formatLocalDateTime(iso));
    expect(formatRelativeTime(iso, now)).not.toMatch(/ago$/u);
  });

  it("returns the raw input for an unparseable timestamp", () => {
    expect(formatRelativeTime("not-a-date", now)).toBe("not-a-date");
  });
});
