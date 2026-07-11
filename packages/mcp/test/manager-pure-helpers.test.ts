import { describe, expect, it } from "vitest";

import {
  computeNextReconnectAt,
  isOnDemandReconnectAllowed,
  summarizePreflightChecks
} from "../src/manager.js";
import type { McpHealthSnapshot, McpPreflightCheck, McpReconnectPolicy } from "../src/index.js";

function makeHealth(overrides: Partial<McpHealthSnapshot> = {}): McpHealthSnapshot {
  return {
    reconnectAttempts: 0,
    serverName: "server",
    status: "unknown",
    toolCount: 0,
    ...overrides
  };
}

describe("computeNextReconnectAt", () => {
  const policy: McpReconnectPolicy = {
    enabled: true,
    initialDelayMs: 100,
    maxAttempts: 3,
    maxDelayMs: 1_000
  };
  const nowMs = 1_767_228_800_000;

  it("returns a Date at the boundary attempts === maxAttempts", () => {
    const result = computeNextReconnectAt(policy, nowMs, 3);
    expect(result).toBeInstanceOf(Date);
    expect(result?.getTime()).toBe(nowMs + policy.initialDelayMs * 2 ** 2);
  });

  it("returns undefined once attempts exceeds maxAttempts", () => {
    expect(computeNextReconnectAt(policy, nowMs, 4)).toBeUndefined();
  });

  it("clamps the delay at maxDelayMs", () => {
    const clampingPolicy: McpReconnectPolicy = { ...policy, maxAttempts: 10, maxDelayMs: 250 };
    const result = computeNextReconnectAt(clampingPolicy, nowMs, 5);
    expect(result?.getTime()).toBe(nowMs + 250);
  });

  it("returns undefined when the policy is disabled", () => {
    expect(computeNextReconnectAt({ ...policy, enabled: false }, nowMs, 1)).toBeUndefined();
  });

  it("grows the delay exponentially: attempt 1 = initialDelayMs, 2 = 2x, 3 = 4x", () => {
    expect(computeNextReconnectAt(policy, nowMs, 1)?.getTime()).toBe(nowMs + 100);
    expect(computeNextReconnectAt(policy, nowMs, 2)?.getTime()).toBe(nowMs + 200);
    expect(computeNextReconnectAt(policy, nowMs, 3)?.getTime()).toBe(nowMs + 400);
  });
});

describe("isOnDemandReconnectAllowed", () => {
  const nowMs = 1_767_228_800_000;

  it("is false when nextReconnectAt is in the future", () => {
    const health = makeHealth({ nextReconnectAt: new Date(nowMs + 1_000) });
    expect(isOnDemandReconnectAllowed(health, nowMs)).toBe(false);
  });

  it("is true when nextReconnectAt is in the past or equal to now", () => {
    expect(isOnDemandReconnectAllowed(makeHealth({ nextReconnectAt: new Date(nowMs - 1_000) }), nowMs)).toBe(true);
    expect(isOnDemandReconnectAllowed(makeHealth({ nextReconnectAt: new Date(nowMs) }), nowMs)).toBe(true);
  });

  it("is true when nextReconnectAt is undefined and reconnectAttempts is 0", () => {
    expect(isOnDemandReconnectAllowed(makeHealth({ reconnectAttempts: 0 }), nowMs)).toBe(true);
  });

  it("is false when nextReconnectAt is undefined and reconnectAttempts is > 0", () => {
    expect(isOnDemandReconnectAllowed(makeHealth({ reconnectAttempts: 1 }), nowMs)).toBe(false);
  });

  it("is true when health itself is undefined", () => {
    expect(isOnDemandReconnectAllowed(undefined, nowMs)).toBe(true);
  });
});

describe("summarizePreflightChecks", () => {
  it("counts pass/warn/fail across a mixed array", () => {
    const checks: readonly McpPreflightCheck[] = [
      { code: "a", message: "ok", status: "pass" },
      { code: "b", message: "ok", status: "pass" },
      { code: "c", message: "meh", status: "warn" },
      { code: "d", message: "bad", status: "fail" }
    ];
    expect(summarizePreflightChecks(checks)).toEqual({ failCount: 1, passCount: 2, warnCount: 1 });
  });

  it("returns all zeros for an empty array", () => {
    expect(summarizePreflightChecks([])).toEqual({ failCount: 0, passCount: 0, warnCount: 0 });
  });
});
