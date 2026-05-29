import { describe, expect, it } from "vitest";

import { humanizeRelativeMs } from "../src/time-helpers.js";

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

describe("humanizeRelativeMs", () => {
  it("returns 'unknown' for a non-finite delta", () => {
    expect(humanizeRelativeMs(Number.NaN)).toBe("unknown");
    expect(humanizeRelativeMs(Number.POSITIVE_INFINITY)).toBe("unknown");
    expect(humanizeRelativeMs(Number.NEGATIVE_INFINITY)).toBe("unknown");
  });

  it("collapses anything within ±60s to 'now'", () => {
    expect(humanizeRelativeMs(0)).toBe("now");
    expect(humanizeRelativeMs(30_000)).toBe("now");
    expect(humanizeRelativeMs(-30_000)).toBe("now");
    expect(humanizeRelativeMs(59_900)).toBe("now");
  });

  it("renders minutes with past/future direction (60s rounds up to 1 min, in the future)", () => {
    expect(humanizeRelativeMs(60_000)).toBe("in 1 min");
    expect(humanizeRelativeMs(-5 * MIN)).toBe("5 min ago");
    expect(humanizeRelativeMs(5 * MIN)).toBe("in 5 min");
    expect(humanizeRelativeMs(59 * MIN)).toBe("in 59 min");
  });

  it("renders hours, rolling over from minutes once rounding reaches 60 min", () => {
    expect(humanizeRelativeMs(59.5 * MIN)).toBe("in 1h");
    expect(humanizeRelativeMs(-2 * HOUR)).toBe("2h ago");
    expect(humanizeRelativeMs(2 * HOUR)).toBe("in 2h");
    expect(humanizeRelativeMs(23 * HOUR)).toBe("in 23h");
  });

  it("renders days with singular/plural units, rolling over from hours at ~24h", () => {
    expect(humanizeRelativeMs(23.5 * HOUR)).toBe("in 1 day");
    expect(humanizeRelativeMs(-DAY)).toBe("1 day ago");
    expect(humanizeRelativeMs(DAY)).toBe("in 1 day");
    expect(humanizeRelativeMs(-3 * DAY)).toBe("3 days ago");
    expect(humanizeRelativeMs(5 * DAY)).toBe("in 5 days");
    expect(humanizeRelativeMs(30 * DAY)).toBe("in 30 days");
  });
});
