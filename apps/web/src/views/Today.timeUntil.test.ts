import { describe, expect, it } from "vitest";

import { timeUntil } from "./Today.js";

import type { Translate } from "../i18n/index.js";

// Stub Translate: echo the key (plus n) so assertions are deterministic and
// locale-independent — we're testing the bucket choice, not the wording.
const t = ((key: string, vars?: { readonly n?: number }) =>
  vars?.n === undefined ? key : `${key}:${String(vars.n)}`) as unknown as Translate;

describe("timeUntil — sub-minute future events read as 'now', not 'in 0m'", () => {
  it("an event ~20s away is 'now' (was the bogus 'in 0m')", () => {
    const iso = new Date(Date.now() + 20_000).toISOString();
    expect(timeUntil(iso, t)).toBe("rel.now");
  });

  it("an event happening now is 'now'", () => {
    expect(timeUntil(new Date().toISOString(), t)).toBe("rel.now");
  });

  it("still buckets real minutes / hours / days correctly", () => {
    expect(timeUntil(new Date(Date.now() + 5 * 60_000).toISOString(), t)).toBe("rel.inMinutes:5");
    expect(timeUntil(new Date(Date.now() + 3 * 3_600_000).toISOString(), t)).toBe("rel.inHours:3");
    expect(timeUntil(new Date(Date.now() + 2 * 86_400_000).toISOString(), t)).toBe("rel.inDays:2");
  });

  it("returns empty for an unparseable timestamp", () => {
    expect(timeUntil("not-a-date", t)).toBe("");
  });
});

describe("timeUntil — overdue (past) items get a magnitude label, not a blanket 'now'", () => {
  const cases: ReadonlyArray<{ readonly label: string; readonly deltaMs: number; readonly expected: string }> = [
    { label: "-35d", deltaMs: -35 * 86_400_000, expected: "rel.overdueDays:35" },
    { label: "-2h", deltaMs: -2 * 3_600_000, expected: "rel.overdueHours:2" },
    { label: "-3m", deltaMs: -3 * 60_000, expected: "rel.overdueMinutes:3" },
    { label: "-10s", deltaMs: -10_000, expected: "rel.now" },
    { label: "+10s", deltaMs: 10_000, expected: "rel.now" },
    { label: "+3m", deltaMs: 3 * 60_000, expected: "rel.inMinutes:3" },
    { label: "+2h", deltaMs: 2 * 3_600_000, expected: "rel.inHours:2" },
    { label: "+35d", deltaMs: 35 * 86_400_000, expected: "rel.inDays:35" }
  ];

  for (const { label, deltaMs, expected } of cases) {
    it(`${label} ⇒ ${expected}`, () => {
      const iso = new Date(Date.now() + deltaMs).toISOString();
      expect(timeUntil(iso, t)).toBe(expected);
    });
  }

  it("a reminder over a month overdue (real repro: due 2026-06-08) is NOT 'now'", () => {
    const iso = new Date(Date.now() - 33 * 86_400_000).toISOString();
    expect(timeUntil(iso, t)).toBe("rel.overdueDays:33");
  });
});
