import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MessagingProviderRegistry } from "@muse/messaging";
import { afterEach, describe, expect, it, vi } from "vitest";

const mockedDomainTools = vi.hoisted(() => ({ runDueSituationalBriefing: vi.fn() }));

vi.mock("@muse/domain-tools", () => ({ runDueSituationalBriefing: mockedDomainTools.runDueSituationalBriefing }));

import { createBriefingRuntimeStatusStore } from "../src/briefing-runtime-status.js";
import { startSituationalBriefingTick } from "../src/situational-briefing-tick.js";

const NOW = new Date("2026-08-08T01:02:03.000Z");
const RESOLVED_ROUTE = {
  destination: "owner-a",
  localOnly: false,
  providerId: "telegram",
  reason: null,
  source: "explicit-config" as const,
  status: "resolved" as const
};

function start(options: { readonly runtimeStatus: ReturnType<typeof createBriefingRuntimeStatusStore>; readonly resolveRoute?: () => unknown; readonly quietHours?: { readonly endHour: number; readonly startHour: number }; readonly errorLogger?: (message: string) => void }) {
  const root = mkdtempSync(join(tmpdir(), "muse-brief-runtime-status-"));
  return startSituationalBriefingTick({
    errorLogger: options.errorLogger,
    now: () => NOW,
    objectivesFile: join(root, "objectives.json"),
    quietHours: options.quietHours,
    registry: new MessagingProviderRegistry([]),
    resolveRoute: options.resolveRoute as (() => typeof RESOLVED_ROUTE | undefined) | undefined,
    runtimeStatus: options.runtimeStatus,
    sidecarFile: join(root, "briefing-fired.json"),
    windowMs: 0
  });
}

afterEach(() => {
  mockedDomainTools.runDueSituationalBriefing.mockReset();
});

describe("startSituationalBriefingTick runtime status", () => {
  it.each([
    ["nothing-to-say", { delivered: 0, reason: "nothing-to-say" }],
    ["in-window", { delivered: 0, reason: "in-window" }],
    ["delivered", { delivered: 1 }]
  ] as const)("records the %s terminal decision", async (expectedDecision, summary) => {
    mockedDomainTools.runDueSituationalBriefing.mockResolvedValueOnce(summary);
    const runtimeStatus = createBriefingRuntimeStatusStore();
    const handle = start({ resolveRoute: () => RESOLVED_ROUTE, runtimeStatus });

    try {
      await handle.tickOnce();
      expect(runtimeStatus.get()).toMatchObject({
        lastDecision: expectedDecision,
        lastDeliveredCount: summary.delivered,
        lastErrorCount: 0,
        lastImminentCount: 0,
        lastObservedAtIso: NOW.toISOString(),
        lastRoute: RESOLVED_ROUTE
      });
    } finally {
      handle.stop();
    }
  });

  it.each([
    ["missing route", () => undefined],
    ["blocked route", () => ({
      destination: "owner-a",
      localOnly: true,
      providerId: "telegram",
      reason: "remote-route-blocked-by-local-only",
      source: "explicit-config",
      status: "blocked-local-only"
    })],
    ["malformed route", () => ({ route: "not-a-route" })]
  ] as const)("records route-unavailable for %s without entering briefing core", async (_label, resolveRoute) => {
    const runtimeStatus = createBriefingRuntimeStatusStore();
    const handle = start({ resolveRoute, runtimeStatus });

    try {
      await handle.tickOnce();
      expect(mockedDomainTools.runDueSituationalBriefing).not.toHaveBeenCalled();
      expect(runtimeStatus.get()?.lastDecision).toBe("route-unavailable");
      expect(runtimeStatus.get()?.lastRoute.status).not.toBe("resolved");
    } finally {
      handle.stop();
    }
  });

  it("records a resolver throw as route-unavailable without exposing its error", async () => {
    const errors: string[] = [];
    const runtimeStatus = createBriefingRuntimeStatusStore();
    const handle = start({
      errorLogger: (message) => errors.push(message),
      resolveRoute: () => { throw new Error("secret route detail"); },
      runtimeStatus
    });

    try {
      await handle.tickOnce();
      expect(mockedDomainTools.runDueSituationalBriefing).not.toHaveBeenCalled();
      expect(runtimeStatus.get()).toMatchObject({
        lastDecision: "route-unavailable",
        lastRoute: {
          destination: null,
          providerId: null,
          reason: "paired-route-inspection-unavailable",
          status: "unconfigured"
        }
      });
      expect(errors).toEqual(["situational-briefing-tick: route-unavailable"]);
      expect(JSON.stringify(runtimeStatus.get())).not.toContain("secret route detail");
    } finally {
      handle.stop();
    }
  });

  it("records quiet-hours and already-running terminal decisions", async () => {
    const quietStatus = createBriefingRuntimeStatusStore();
    const quietHandle = start({
      quietHours: { endHour: 23, startHour: 0 },
      runtimeStatus: quietStatus
    });
    try {
      await quietHandle.tickOnce();
      expect(quietStatus.get()?.lastDecision).toBe("quiet-hours");
    } finally {
      quietHandle.stop();
    }

    let release!: (summary: { readonly delivered: 1 }) => void;
    mockedDomainTools.runDueSituationalBriefing.mockReturnValueOnce(new Promise((resolve) => {
      release = resolve;
    }));
    const runningStatus = createBriefingRuntimeStatusStore();
    const runningHandle = start({ resolveRoute: () => RESOLVED_ROUTE, runtimeStatus: runningStatus });
    try {
      const first = runningHandle.tickOnce();
      await runningHandle.tickOnce();
      expect(runningStatus.get()?.lastDecision).toBe("already-running");
      release({ delivered: 1 });
      await first;
      expect(runningStatus.get()?.lastDecision).toBe("delivered");
    } finally {
      runningHandle.stop();
    }
  });

  it("records a delivery/core throw as error with the attempted route", async () => {
    mockedDomainTools.runDueSituationalBriefing.mockRejectedValueOnce(new Error("secret delivery detail"));
    const runtimeStatus = createBriefingRuntimeStatusStore();
    const handle = start({ resolveRoute: () => RESOLVED_ROUTE, runtimeStatus });

    try {
      await handle.tickOnce();
      expect(runtimeStatus.get()).toMatchObject({
        lastDecision: "error",
        lastDeliveredCount: 0,
        lastErrorCount: 1,
        lastRoute: RESOLVED_ROUTE
      });
      expect(JSON.stringify(runtimeStatus.get())).not.toContain("secret delivery detail");
    } finally {
      handle.stop();
    }
  });
});
