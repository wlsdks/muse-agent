import { describe, expect, it } from "vitest";

import { MonthlyBudgetTracker } from "../src/observability-detectors.js";

// Direct coverage for the monthly cost-budget tracker (untested module). It's
// money-adjacent (the ok/warning/exceeded status the cost dashboard + any
// budget gate reads), so the threshold semantics, the bad-input guard, and the
// month rollover are pinned with an injected clock.

const clockAt = (ym: string) => () => new Date(`${ym}-15T00:00:00Z`);

describe("MonthlyBudgetTracker", () => {
  it("crosses ok → warning (at warningPercent) → exceeded (at the limit)", () => {
    const t = new MonthlyBudgetTracker({ monthlyLimitUsd: 100, now: clockAt("2026-05"), warningPercent: 80 });
    expect(t.recordCost(50)).toBe("ok");
    expect(t.recordCost(30)).toBe("warning"); // total 80 == warning bar
    expect(t.recordCost(20)).toBe("exceeded"); // total 100 == limit (ratio >= 1)
    expect(t.snapshot()).toMatchObject({ percentUsed: 100, remainingUsd: 0, status: "exceeded", totalCostUsd: 100 });
  });

  it("ignores a non-finite / negative cost (a provider reporting NaN must not corrupt the total)", () => {
    const t = new MonthlyBudgetTracker({ monthlyLimitUsd: 100, now: clockAt("2026-05") });
    t.recordCost(40);
    expect(t.recordCost(Number.NaN)).toBe("ok");
    expect(t.recordCost(-5)).toBe("ok");
    expect(t.currentCost()).toBe(40); // unchanged by the bad inputs
  });

  it("rolls the month over BEFORE the validity check: a NaN cost first in a fresh month reports ok, not last month's exceeded", () => {
    let ym = "2026-05";
    const t = new MonthlyBudgetTracker({ monthlyLimitUsd: 100, now: () => new Date(`${ym}-15T00:00:00Z`) });
    expect(t.recordCost(120)).toBe("exceeded"); // May went over the limit
    ym = "2026-06";
    // First June op is a NaN cost: the month must reset (total → 0) BEFORE the
    // validity returns, so it reports ok for the fresh $0 month — not May's exceeded.
    expect(t.recordCost(Number.NaN)).toBe("ok");
    expect(t.currentCost()).toBe(0);
  });

  it("resets the total when the month rolls over (injected clock)", () => {
    let ym = "2026-05";
    const t = new MonthlyBudgetTracker({ monthlyLimitUsd: 100, now: () => new Date(`${ym}-15T00:00:00Z`) });
    t.recordCost(95);
    expect(t.snapshot().status).toBe("warning");
    ym = "2026-06";
    expect(t.currentCost()).toBe(0); // new month → fresh budget
    expect(t.snapshot().status).toBe("ok");
  });

  it("an unlimited budget (no/zero limit) is always ok and omits percentUsed + remainingUsd", () => {
    const t = new MonthlyBudgetTracker({ now: clockAt("2026-05") });
    expect(t.recordCost(9_999)).toBe("ok");
    const snap = t.snapshot();
    expect(snap.status).toBe("ok");
    expect(snap.percentUsed).toBeUndefined();
    expect(snap.remainingUsd).toBeUndefined();
  });

  it("clamps percentUsed to 100 and remainingUsd to 0 once the limit is overrun", () => {
    const t = new MonthlyBudgetTracker({ monthlyLimitUsd: 10, now: clockAt("2026-05") });
    t.recordCost(25);
    expect(t.snapshot()).toMatchObject({ percentUsed: 100, remainingUsd: 0 });
  });

  it("rejects an invalid monthlyLimitUsd or warningPercent at construction", () => {
    expect(() => new MonthlyBudgetTracker({ monthlyLimitUsd: -1 })).toThrow();
    expect(() => new MonthlyBudgetTracker({ monthlyLimitUsd: Number.NaN })).toThrow();
    expect(() => new MonthlyBudgetTracker({ warningPercent: 0 })).toThrow();
    expect(() => new MonthlyBudgetTracker({ warningPercent: 101 })).toThrow();
  });
});
