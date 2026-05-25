import { describe, expect, it } from "vitest";

import { planActivityPrune, planTimestampedLinePrune } from "./commands-maintenance.js";

const DAY = 24 * 60 * 60 * 1000;

describe("planTimestampedLinePrune", () => {
  const now = 100 * DAY;
  it("keeps recent lines, drops older + undateable, skips blanks", () => {
    const lines = ["recent", "old", "", "undateable"];
    const extractTsMs = (line: string): number =>
      line === "recent" ? now - DAY : line === "old" ? now - 40 * DAY : Number.NaN;

    const plan = planTimestampedLinePrune(lines, now, 30, extractTsMs);

    expect(plan.keptLines).toEqual(["recent"]);
    expect(plan.kept).toBe(1);
    // "old" (too old) + "undateable" (NaN) dropped; "" is skipped, not counted.
    expect(plan.dropped).toBe(2);
  });
});

describe("planActivityPrune", () => {
  it("reads tsIso from each JSON line and prunes by age, dropping malformed lines", () => {
    const now = 100 * DAY;
    const recent = JSON.stringify({ tsIso: new Date(now - DAY).toISOString(), event: "a" });
    const old = JSON.stringify({ tsIso: new Date(now - 60 * DAY).toISOString(), event: "b" });

    const plan = planActivityPrune([recent, old, "{not valid json"], now, 30);

    expect(plan.keptLines).toEqual([recent]);
    expect(plan.kept).toBe(1);
    expect(plan.dropped).toBe(2);
  });
});
