// Pin the zone BEFORE importing anything that touches Date, so the DST-boundary
// assertion is deterministic regardless of the runner's local zone. (`process`
// is declared locally — @muse/web is browser-typed and has no @types/node, but
// the vitest runner is node so the assignment takes effect at runtime.)
declare const process: { env: Record<string, string | undefined> };
process.env.TZ = "America/Los_Angeles";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dayLabel } from "./Calendar.js";

import type { Translate } from "../i18n/index.js";

const t = ((key: string) => key) as unknown as Translate;

describe("dayLabel — 'tomorrow' is the real next calendar day, not now + 24h", () => {
  afterEach(() => vi.useRealTimers());

  describe("on a spring-forward eve (Sun 2026-03-08 is a 23h day in PT)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-03-07T23:30:00-08:00")); // late Sat eve, PST
    });

    it("labels the genuine next day (Sun Mar 8) as tomorrow", () => {
      expect(dayLabel("2026-03-08T10:00:00-08:00", t, "en-US")).toBe("calendar.tomorrow");
    });

    it("does NOT label the day-after (Mon Mar 9) as tomorrow", () => {
      expect(dayLabel("2026-03-09T10:00:00-07:00", t, "en-US")).not.toBe("calendar.tomorrow");
    });
  });

  it("still labels a normal (non-DST) next day as tomorrow", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-13T12:00:00-07:00"));
    expect(dayLabel("2026-06-14T09:00:00-07:00", t, "en-US")).toBe("calendar.tomorrow");
    expect(dayLabel("2026-06-13T18:00:00-07:00", t, "en-US")).toBe("calendar.today");
  });

  it("returns an empty string for an unparseable date — never an 'Invalid Date' group header", () => {
    // Consistency with timeUntil + formatTaskDate (which NaN-guard): a malformed
    // startsAtIso must not become an "Invalid Date" day-group header.
    expect(dayLabel("not-a-date", t, "en-US")).toBe("");
    expect(dayLabel("", t, "en-US")).toBe("");
  });
});
