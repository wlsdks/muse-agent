import { describe, expect, it } from "vitest";

import { comparePreviewEntriesByWhen, type PreviewEntry } from "./commands-scheduler-setup.js";

const entry = (when: string, label: string, kind: PreviewEntry["kind"] = "reminder"): PreviewEntry =>
  ({ kind, label, when });

describe("comparePreviewEntriesByWhen — `muse scheduler next` orders by instant, not lexicographic `when`", () => {
  it("orders a timezone-offset reminder dueAt by its real instant (a lexicographic sort would invert it)", () => {
    // a: 2026-05-22T23:00:00-05:00 == 2026-05-23T04:00:00Z (LATER instant)
    // b: 2026-05-23T01:00:00Z (EARLIER instant)
    // Lexicographically "2026-05-22T23…" < "2026-05-23T01…" → a would sort first; by instant b is sooner.
    const a = entry("2026-05-22T23:00:00-05:00", "later");
    const b = entry("2026-05-23T01:00:00Z", "earlier");
    expect([a, b].sort(comparePreviewEntriesByWhen).map((e) => e.label)).toEqual(["earlier", "later"]);
  });

  it("mixes a job nextRunAt and a reminder dueAt in true soonest-first order", () => {
    const job = entry("2026-05-23T02:00:00.000Z", "digest job", "job");
    const rem = entry("2026-05-22T22:30:00-05:00", "buy milk"); // == 2026-05-23T03:30Z (after the job)
    expect([rem, job].sort(comparePreviewEntriesByWhen).map((e) => e.label)).toEqual(["digest job", "buy milk"]);
  });

  it("keeps a deterministic order for equal instants (label tiebreak) and unparseable values", () => {
    const same = "2026-05-23T09:00:00.000Z";
    expect([entry(same, "zebra"), entry(same, "apple")].sort(comparePreviewEntriesByWhen).map((e) => e.label))
      .toEqual(["apple", "zebra"]);
    const x = entry("not-a-date", "x");
    const y = entry("also-bad", "y");
    expect([x, y].sort(comparePreviewEntriesByWhen)).toHaveLength(2);
  });
});
