import { describe, expect, it } from "vitest";

import { isoDateHeadRoundTrips } from "../src/loopback-relative-time.js";

describe("isoDateHeadRoundTrips — shared rollover guard for the date parsers", () => {
  it("accepts a real calendar date (round-trips through Date.UTC unchanged)", () => {
    expect(isoDateHeadRoundTrips(2026, 2, 28)).toBe(true);
    expect(isoDateHeadRoundTrips(2024, 2, 29)).toBe(true); // leap day
    expect(isoDateHeadRoundTrips(2026, 12, 31)).toBe(true);
    expect(isoDateHeadRoundTrips(2026, 1, 1)).toBe(true);
  });

  it("rejects an impossible date that silently rolls over", () => {
    expect(isoDateHeadRoundTrips(2026, 2, 30)).toBe(false); // Feb 30 → Mar 2
    expect(isoDateHeadRoundTrips(2025, 2, 29)).toBe(false); // non-leap Feb 29
    expect(isoDateHeadRoundTrips(2026, 4, 31)).toBe(false); // Apr 31 → May 1
    expect(isoDateHeadRoundTrips(2026, 13, 1)).toBe(false); // month 13 → next year
  });
});
