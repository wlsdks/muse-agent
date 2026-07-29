import { describe, expect, it } from "vitest";

import { DaemonStopSignal } from "./commands-daemon-loop.js";
import {
  assessDaemonResourceAdmission,
  type DaemonResourceSnapshot
} from "./daemon-resource-admission.js";
import {
  DAEMON_WORKLOAD_UNIT_IDS,
  workloadDecisionReceipt
} from "./daemon-resource-receipt.js";
import {
  emptyDaemonWorkloadProfile,
  recordDaemonWorkloadReceipt
} from "./daemon-workload-profile.js";
import {
  DaemonWorkloadGovernor,
  daemonWorkloadCancelled,
  daemonWorkloadCompleted,
  daemonWorkloadFailed,
  daemonWorkloadNotReady,
  type DaemonWorkloadMetrics,
  type DaemonWorkloadUnit
} from "./daemon-workload-governor.js";

function metrics(values: number[]): DaemonWorkloadMetrics {
  return {
    cpuMicros: () => values.shift() ?? 0,
    monotonicMs: () => values.shift() ?? 0,
    nowIso: () => "2026-07-22T00:00:00.000Z",
    rssBytes: () => values.shift() ?? 0
  };
}

describe("DaemonWorkloadGovernor", () => {
  it("claims every continuously-ready unit within one full admitted rotation", async () => {
    const ids = DAEMON_WORKLOAD_UNIT_IDS;
    const claimed: string[] = [];
    const governor = new DaemonWorkloadGovernor(ids.map((id) => ({
      id,
      run: async (claim) => {
        expect(claim).toBeDefined();
        expect(claim!()).toBe(true);
        claimed.push(id);
        return daemonWorkloadCompleted();
      }
    })));
    for (let cycle = 0; cycle < ids.length; cycle += 1) {
      expect((await governor.runAdmittedCycle(new DaemonStopSignal())).status).toBe("boundary");
    }
    expect(claimed).toEqual(ids);
  });

  it("does not claim a unit twice when a batch excludes completed boundaries", async () => {
    const claimed: string[] = [];
    const governor = new DaemonWorkloadGovernor(["pattern", "browsing-sync"].map((id) => ({
      id: id as DaemonWorkloadUnit["id"],
      run: async (claim) => {
        expect(claim!()).toBe(true);
        claimed.push(id);
        return daemonWorkloadCompleted();
      }
    })));
    const completed = new Set<DaemonWorkloadUnit["id"]>();
    for (let index = 0; index < 2; index += 1) {
      const result = await governor.runAdmittedCycle(new DaemonStopSignal(), completed);
      expect(result.status).toBe("boundary");
      if (result.status === "boundary") completed.add(result.boundary.unit);
    }
    expect(await governor.runAdmittedCycle(new DaemonStopSignal(), completed)).toEqual({ status: "no-work" });
    expect(claimed).toEqual(["pattern", "browsing-sync"]);
  });

  it("rejects an overlapping cycle while a claimed unit remains in flight", async () => {
    let release!: () => void;
    let started!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    let starts = 0;
    let concurrent = 0;
    let maxConcurrent = 0;
    const governor = new DaemonWorkloadGovernor([{
      id: "reflection",
      run: async (claim) => {
        expect(claim).toBeDefined();
        expect(claim!()).toBe(true);
        starts += 1;
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        started();
        await held;
        concurrent -= 1;
        return daemonWorkloadCompleted();
      }
    }]);
    const first = governor.runAdmittedCycle(new DaemonStopSignal());
    await didStart;
    expect(await governor.runAdmittedCycle(new DaemonStopSignal())).toEqual({ status: "no-work" });
    expect({ maxConcurrent, starts }).toEqual({ maxConcurrent: 1, starts: 1 });
    release();
    expect((await first).status).toBe("boundary");
  });

  it("scans not-ready units but claims at most one and rotates fairly", async () => {
    const calls: string[] = [];
    const units: DaemonWorkloadUnit[] = ["reflection", "email-sync", "self-learn"].map((id, index) => ({
      id: id as DaemonWorkloadUnit["id"],
      run: async (claim) => {
        calls.push(id);
        if (index === 0) return daemonWorkloadNotReady("not-due");
        expect(claim).toBeDefined();
        expect(claim!()).toBe(true);
        return daemonWorkloadCompleted();
      }
    }));
    const governor = new DaemonWorkloadGovernor(units, metrics([10, 20, 100, 30, 120, 110, 40, 200, 50, 220]));
    expect((await governor.runAdmittedCycle(new DaemonStopSignal())).status).toBe("boundary");
    expect(calls).toEqual(["reflection", "email-sync"]);
    calls.length = 0;
    expect((await governor.runAdmittedCycle(new DaemonStopSignal())).status).toBe("boundary");
    expect(calls).toEqual(["self-learn"]);
  });

  it("starts nothing when stopped before or at the claim boundary", async () => {
    let work = 0;
    const stopped = new DaemonStopSignal(); stopped.stop(5);
    const governor = new DaemonWorkloadGovernor([{ id: "reflection", run: async () => { work += 1; return daemonWorkloadCompleted(); } }]);
    expect(await governor.runAdmittedCycle(stopped)).toEqual({ status: "cancelled-before-claim" });
    expect(work).toBe(0);

    const signal = new DaemonStopSignal();
    const boundaryGovernor = new DaemonWorkloadGovernor([{ id: "reflection", run: async (claim) => {
      signal.stop(10);
      expect(claim).toBeDefined();
      expect(claim!()).toBe(false);
      return daemonWorkloadCancelled();
    } }]);
    expect(await boundaryGovernor.runAdmittedCycle(signal)).toEqual({ status: "cancelled-before-claim" });
  });

  it("distinguishes an exact claim-gate deferral from process stop without advancing fairness", async () => {
    const calls: string[] = [];
    const governor = new DaemonWorkloadGovernor(["pattern", "browsing-sync"].map((id) => ({
      id: id as DaemonWorkloadUnit["id"],
      run: async (claim) => {
        calls.push(id);
        if (!claim!()) return daemonWorkloadCancelled();
        return daemonWorkloadCompleted();
      }
    })));
    const token = { observation: "active-at-claim" };

    expect(await governor.runAdmittedCycle(
      new DaemonStopSignal(),
      new Set(),
      () => ({ status: "defer", token })
    )).toEqual({ claimToken: token, status: "deferred-before-claim" });

    const admitted = await governor.runAdmittedCycle(
      new DaemonStopSignal(),
      new Set(),
      () => ({ status: "admit", token: { observation: "idle-at-claim" } })
    );
    expect(admitted).toMatchObject({
      boundary: { unit: "pattern" },
      claimToken: { observation: "idle-at-claim" },
      status: "boundary"
    });
    expect(calls).toEqual(["pattern", "pattern"]);
  });

  it("keeps background work unclaimed and records deferral under foreground user pressure", async () => {
    const foregroundPressure: DaemonResourceSnapshot = {
      cpuCount: 8,
      freeMemoryBytes: 4 * 1024 * 1024 * 1024,
      idleMs: 1_000,
      load1: 1,
      onAcPower: true,
      platform: "darwin",
      processCpuSystemMicros: 10,
      processCpuUserMicros: 20,
      residentMemoryBytes: 256 * 1024 * 1024,
      thermalState: "nominal"
    };
    const idleHeadroom: DaemonResourceSnapshot = {
      ...foregroundPressure,
      idleMs: 300_000
    };
    let backgroundClaims = 0;
    let backgroundEffects = 0;
    const governor = new DaemonWorkloadGovernor([{
      id: "pattern",
      run: async (claim) => {
        if (!claim!()) return daemonWorkloadCancelled();
        backgroundClaims += 1;
        backgroundEffects += 1;
        return daemonWorkloadCompleted();
      }
    }]);
    const deferredAdmission = assessDaemonResourceAdmission({}, foregroundPressure);
    const deferredReceipt = workloadDecisionReceipt(
      deferredAdmission,
      foregroundPressure,
      governor.queueDepth,
      "2026-07-29T00:00:00.000Z"
    );

    const deferred = await governor.runAdmittedCycle(
      new DaemonStopSignal(),
      new Set(),
      () => ({ status: "defer", token: deferredReceipt })
    );

    expect(deferredAdmission).toEqual({ reason: "active-user", status: "defer" });
    expect(deferred).toEqual({
      claimToken: deferredReceipt,
      status: "deferred-before-claim"
    });
    expect({ backgroundClaims, backgroundEffects }).toEqual({
      backgroundClaims: 0,
      backgroundEffects: 0
    });
    expect(recordDaemonWorkloadReceipt(
      emptyDaemonWorkloadProfile("2026-07-29T00:00:00.000Z"),
      deferredReceipt
    )).toMatchObject({
      admitted: 0,
      boundaries: 0,
      deferred: 1
    });

    const admittedAdmission = assessDaemonResourceAdmission({}, idleHeadroom);
    const admittedReceipt = workloadDecisionReceipt(
      admittedAdmission,
      idleHeadroom,
      governor.queueDepth,
      "2026-07-29T00:01:00.000Z"
    );
    const admitted = await governor.runAdmittedCycle(
      new DaemonStopSignal(),
      new Set(),
      () => ({ status: "admit", token: admittedReceipt })
    );

    expect(admittedAdmission).toEqual({ status: "admit" });
    expect(admitted).toMatchObject({
      boundary: { unit: "pattern" },
      claimToken: admittedReceipt,
      status: "boundary"
    });
    expect({ backgroundClaims, backgroundEffects }).toEqual({
      backgroundClaims: 1,
      backgroundEffects: 1
    });
  });

  it.each(["admit", "defer"] as const)("lets synchronous stop outrank a %s gate decision", async (status) => {
    const signal = new DaemonStopSignal();
    const governor = new DaemonWorkloadGovernor([{
      id: "reflection",
      run: async (claim) => {
        expect(claim!()).toBe(false);
        return daemonWorkloadCancelled();
      }
    }]);

    expect(await governor.runAdmittedCycle(signal, new Set(), () => {
      signal.stop(10);
      return { status, token: "must-not-escape" };
    })).toEqual({ status: "cancelled-before-claim" });
  });

  it("carries an undefined gate token without treating it as missing state", async () => {
    const governor = new DaemonWorkloadGovernor([{
      id: "pattern",
      run: async (claim) => claim!() ? daemonWorkloadCompleted() : daemonWorkloadCancelled()
    }]);

    expect(await governor.runAdmittedCycle(
      new DaemonStopSignal(),
      new Set(),
      () => ({ status: "defer", token: undefined })
    )).toEqual({ claimToken: undefined, status: "deferred-before-claim" });

    const admitted = await governor.runAdmittedCycle(
      new DaemonStopSignal(),
      new Set(),
      () => ({ status: "admit", token: undefined })
    );
    expect(admitted).toMatchObject({ boundary: { unit: "pattern" }, claimToken: undefined, status: "boundary" });
  });

  it("truthfully records completed or failed work when stop arrives after claim", async () => {
    const signal = new DaemonStopSignal();
    const governor = new DaemonWorkloadGovernor([{ id: "reflection", run: async (claim) => {
      expect(claim).toBeDefined();
      expect(claim!()).toBe(true);
      signal.stop(12);
      return daemonWorkloadFailed("model");
    } }], metrics([10, 100, 1_000, 20, 130, 1_100]));
    const result = await governor.runAdmittedCycle(signal);
    expect(result).toMatchObject({
      boundary: { boundaryLatencyMs: 8, errorClass: "model", status: "failed", stopRequestedDuring: true },
      status: "boundary"
    });
  });
});
