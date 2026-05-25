import { describe, expect, it } from "vitest";

import { formatMetricsSnapshot } from "./commands-metrics.js";

describe("formatMetricsSnapshot", () => {
  it("returns an empty-state line for a non-object snapshot", () => {
    expect(formatMetricsSnapshot(undefined)).toMatch(/empty snapshot/);
    expect(formatMetricsSnapshot(null)).toMatch(/empty snapshot/);
    expect(formatMetricsSnapshot("nope")).toMatch(/empty snapshot/);
  });

  it("renders known sections (slo / drift / token cost / budget) with indented keys", () => {
    const out = formatMetricsSnapshot({
      budget: { remaining: 1.5 },
      drift: { planner: { percent: 12 } },
      slo: { p95Ms: 800, ok: true },
      tokenCost: { todayUsd: 0.42 }
    });
    expect(out).toContain("  slo:");
    expect(out).toContain("    p95Ms: 800");
    expect(out).toContain("    ok: true");
    expect(out).toContain("  drift:");
    expect(out).toContain("  token cost:");
    expect(out).toContain("    todayUsd: 0.42");
    expect(out).toContain("  budget:");
  });

  it("compacts nested objects as JSON and renders null as (none)", () => {
    const out = formatMetricsSnapshot({ slo: { detail: { a: 1 }, missing: null } });
    expect(out).toContain('detail: {"a":1}');
    expect(out).toContain("missing: (none)");
  });

  it("groups unknown top-level keys under 'other'", () => {
    const out = formatMetricsSnapshot({ uptimeSeconds: 99 });
    expect(out).toContain("  other:");
    expect(out).toContain("    uptimeSeconds: 99");
  });
});
