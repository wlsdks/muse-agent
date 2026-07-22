import { describe, expect, it } from "vitest";

import { DaemonStopSignal } from "./commands-daemon-loop.js";
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
  it("scans not-ready units but claims at most one and rotates fairly", async () => {
    const calls: string[] = [];
    const units: DaemonWorkloadUnit[] = ["reflection", "email-sync", "self-learn"].map((id, index) => ({
      id: id as DaemonWorkloadUnit["id"],
      run: async (claim) => {
        calls.push(id);
        if (index === 0) return daemonWorkloadNotReady("not-due");
        expect(claim()).toBe(true);
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
      expect(claim()).toBe(false);
      return daemonWorkloadCancelled();
    } }]);
    expect(await boundaryGovernor.runAdmittedCycle(signal)).toEqual({ status: "cancelled-before-claim" });
  });

  it("truthfully records completed or failed work when stop arrives after claim", async () => {
    const signal = new DaemonStopSignal();
    const governor = new DaemonWorkloadGovernor([{ id: "reflection", run: async (claim) => {
      expect(claim()).toBe(true);
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
