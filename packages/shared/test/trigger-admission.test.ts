import { describe, expect, it } from "vitest";

import { admitTrigger, createTriggerEnvelope } from "../src/index.js";

const NOW = new Date("2026-07-30T12:00:00.000Z");

function envelope(overrides: Partial<Parameters<typeof createTriggerEnvelope>[0]> = {}) {
  return createTriggerEnvelope({
    generation: "g1",
    occurredAt: NOW,
    receivedAt: NOW,
    source: "cron",
    sourceId: "daily-brief",
    ...overrides
  });
}

describe("admitTrigger", () => {
  it("executes a fresh unique event when no policy signal withholds it", () => {
    expect(admitTrigger({
      envelope: envelope(),
      maxAgeMs: 60_000,
      now: NOW
    })).toMatchObject({ action: "execute", reasons: [] });
  });

  it.each([
    ["invalid", { envelope: { source: "cron" } }],
    ["duplicate", { seenDedupKeys: new Set([envelope().dedupKey]) }],
    ["future", { envelope: envelope({ occurredAt: "2026-07-30T12:01:00.000Z" }) }],
    ["stale", { envelope: envelope({ occurredAt: "2026-07-30T11:58:00.000Z" }), maxAgeMs: 60_000 }],
    ["paused", { paused: true }],
    ["cooldown-active", { cooldownUntil: new Date("2026-07-30T12:01:00.000Z") }]
  ] as const)("rejects %s before execution", (reason, overrides) => {
    const decision = admitTrigger({
      envelope: envelope(),
      maxAgeMs: 60_000,
      now: NOW,
      ...overrides
    });
    expect(decision.action).toBe("reject");
    expect(decision.reasons).toContain(reason);
  });

  it("collects inspectable shadow reasons without authorizing delivery", () => {
    expect(admitTrigger({
      budgetAvailable: false,
      deliveryBrakeEngaged: true,
      envelope: envelope(),
      focus: "unknown",
      now: NOW,
      shadowOnly: true
    })).toEqual({
      action: "shadow",
      dedupKey: envelope().dedupKey,
      reasons: ["focus-unknown", "budget-exhausted", "delivery-brake", "shadow-only"]
    });
  });

  it("treats focus not-applicable as neutral for owner-scheduled events", () => {
    expect(admitTrigger({
      envelope: envelope({ source: "reminder", sourceId: "rem-1" }),
      focus: "not-applicable",
      now: NOW
    }).action).toBe("execute");
  });
});
