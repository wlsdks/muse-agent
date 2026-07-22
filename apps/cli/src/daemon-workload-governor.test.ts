import { describe, expect, it } from "vitest";

import { DaemonStopSignal } from "./commands-daemon-loop.js";
import { DAEMON_WORKLOAD_UNIT_IDS } from "./daemon-resource-receipt.js";
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
