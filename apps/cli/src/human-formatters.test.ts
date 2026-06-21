import { describe, expect, it } from "vitest";
import {
  formatBytes,
  formatCalendarEvents,
  formatCitations,
  formatLocalDate,
  formatLocalDateTime,
  formatLocalTime,
  formatMemoryShow,
  formatRelativeTime,
  formatTaskList
} from "./human-formatters.js";

describe("formatMemoryShow — splits veto:/goal: preferences into their own headings (audit parity with the persona block)", () => {
  it("renders vetoes and goals under distinct headings with the prefix stripped, leaving plain prefs", () => {
    const out = formatMemoryShow({
      userId: "stark",
      facts: { name: "Stark" },
      preferences: {
        tone: "brief",
        "veto:coffee": "never suggest coffee",
        "goal:fitness": "run 3x a week"
      }
    });
    expect(out).toContain("Preferences:");
    expect(out).toContain("tone: brief");
    expect(out).toContain("Vetoes (never suggest):");
    expect(out).toContain("coffee: never suggest coffee");
    expect(out).toContain("Goals:");
    expect(out).toContain("fitness: run 3x a week");
    // The raw prefixes must NOT leak into the rendered output.
    expect(out).not.toContain("veto:coffee");
    expect(out).not.toContain("goal:fitness");
  });

  it("omits the Vetoes / Goals headings entirely when there are none", () => {
    const out = formatMemoryShow({ userId: "stark", preferences: { tone: "brief" } });
    expect(out).toContain("Preferences:");
    expect(out).not.toContain("Vetoes");
    expect(out).not.toContain("Goals:");
  });
});

describe("formatMemoryShow — surfaces 'what Muse recently learned about you' with provenance", () => {
  it("renders the recently-learned section with each cited line", () => {
    const out = formatMemoryShow({
      userId: "stark",
      facts: { home_city: "Busan" },
      recentlyLearned: [
        'home city: Busan (updated from "Seoul" on 2026-06-21)',
        'role: founder (updated from "student" on 2026-06-20)'
      ]
    });
    expect(out).toContain("Recently learned about you:");
    expect(out).toContain('- home city: Busan (updated from "Seoul" on 2026-06-21)');
    expect(out).toContain('- role: founder (updated from "student" on 2026-06-20)');
  });

  it("omits the section entirely when nothing was recently learned (no false header)", () => {
    const withEmpty = formatMemoryShow({ userId: "stark", facts: { name: "Stark" }, recentlyLearned: [] });
    expect(withEmpty).not.toContain("Recently learned about you:");
    const withAbsent = formatMemoryShow({ userId: "stark", facts: { name: "Stark" } });
    expect(withAbsent).not.toContain("Recently learned about you:");
  });
});

describe("formatTaskList — surfaces the urgent flag", () => {
  it("marks an urgent task with ⚠ and leaves a normal task unmarked", () => {
    const out = formatTaskList({ status: "open", tasks: [
      { id: "t1", title: "Pay rent", urgent: true },
      { id: "t2", title: "Water plants" }
    ], total: 2 });
    expect(out).toContain("⚠ Pay rent");
    expect(out).toMatch(/Water plants(?! )/u); // no ⚠ before a normal task
    expect(out).not.toContain("⚠ Water plants");
  });
});

describe("formatCalendarEvents renders in the local timezone, not UTC", () => {
  it("groups by LOCAL day and shows LOCAL start/end times — a 02:00Z event lands on the previous calendar day in America/Los_Angeles (UTC-7/8), not under its UTC date", () => {
    const out = formatCalendarEvents({
      events: [
        {
          id: "e1",
          startsAtIso: "2026-05-20T02:00:00Z",
          endsAtIso: "2026-05-20T03:00:00Z",
          title: "Late call",
          providerId: "gcal"
        }
      ]
    }, "America/Los_Angeles");
    // 02:00Z on 2026-05-20 == 19:00 PDT on 2026-05-19.
    expect(out).toContain("2026-05-19");
    expect(out).toContain("19:00–20:00  Late call (gcal)");
    expect(out).not.toContain("2026-05-20");
    expect(out).not.toContain("02:00");
  });

  it("shows the local clock with no end when endsAtIso is absent", () => {
    const out = formatCalendarEvents({
      events: [{ id: "e2", startsAtIso: "2026-05-20T16:30:00Z", title: "Standup" }]
    }, "Asia/Seoul");
    // 16:30Z == 01:30 KST next day (2026-05-21).
    expect(out).toContain("2026-05-21");
    expect(out).toContain("01:30  Standup");
    expect(out).not.toContain("01:30–");
  });

  it("renders an all-day / date-only event with its date and no time slot (no UTC-time leakage)", () => {
    const out = formatCalendarEvents({
      events: [{ id: "e3", startsAtIso: "2026-05-20", title: "Holiday" }]
    }, "America/Los_Angeles");
    expect(out).toContain("2026-05-20");
    expect(out).toContain("Holiday");
    // No HH:MM clock for a date-only event.
    expect(out).not.toMatch(/\d{2}:\d{2}/u);
  });

  it("returns the empty-window message for no events", () => {
    expect(formatCalendarEvents({ events: [] })).toBe("Calendar: (no events in window)\n");
  });
});

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

  it("returns the input unchanged for unparseable strings (short AND long)", () => {
    expect(formatLocalDate("nope")).toBe("nope");
    expect(formatLocalTime("nope")).toBe("nope");
    // A LONG unparseable string (>= the old slice thresholds) must
    // pass through whole, not be mangled into "not-a-date" / "strin".
    expect(formatLocalDate("not-a-date-string-here")).toBe("not-a-date-string-here");
    expect(formatLocalTime("not-a-date-string-here")).toBe("not-a-date-string-here");
    // A bare calendar date (no time component) is also not the
    // canonical shape → returned whole, not sliced to a bogus time.
    expect(formatLocalTime("2026-05-20")).toBe("2026-05-20");
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

describe("formatBytes — promotes through B/KB/MB/GB so a multi-GB note doesn't render as '1536.0MB', and guards non-finite / negative values that slipped past a `typeof === 'number'` filter", () => {
  it("promotes to GB at 1024^3 and above — a 1.5GB notes file shows '1.5GB', not '1536.0MB' (the pre-fix MB-bottoms-out symptom)", () => {
    expect(formatBytes(1.5 * 1024 * 1024 * 1024)).toBe("1.5GB");
    expect(formatBytes(1024 * 1024 * 1024)).toBe("1.0GB");
    expect(formatBytes(5 * 1024 * 1024 * 1024)).toBe("5.0GB");
  });

  it("keeps the B / KB / MB tiers exactly as before for sub-GB inputs (regression pin on the pre-existing cap)", () => {
    expect(formatBytes(0)).toBe("0B");
    expect(formatBytes(512)).toBe("512B");
    expect(formatBytes(1024)).toBe("1.0KB");
    expect(formatBytes(1024 * 1024)).toBe("1.0MB");
    expect(formatBytes(500 * 1024 * 1024)).toBe("500.0MB");
  });

  it("returns 'size unknown' for non-finite inputs (NaN / Infinity) — pre-fix `formatNoteSaved({sizeBytes: NaN})` rendered the literal 'NaNMB' on stdout", () => {
    expect(formatBytes(Number.NaN)).toBe("size unknown");
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("size unknown");
    expect(formatBytes(Number.NEGATIVE_INFINITY)).toBe("size unknown");
  });

  it("returns 'size unknown' for negative inputs — fs.stat can't produce them but a stored size with a sign-bit flip would slip past `typeof === 'number'`", () => {
    expect(formatBytes(-1)).toBe("size unknown");
    expect(formatBytes(-1024 * 1024)).toBe("size unknown");
  });
});
