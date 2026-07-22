import type { DaemonStopSignal } from "./commands-daemon-loop.js";
import { DAEMON_WORKLOAD_UNIT_IDS, type DaemonWorkloadBoundaryV2, type DaemonWorkloadErrorClass, type DaemonWorkloadUnitId } from "./daemon-resource-receipt.js";

export type DaemonWorkloadNotReadyReason = "disabled" | "unconfigured" | "not-due" | "internal-brake";
export type DaemonWorkloadTickOutcome =
  | { readonly status: "not-ready"; readonly reason: DaemonWorkloadNotReadyReason }
  | { readonly status: "cancelled-before-claim" }
  | { readonly status: "claimed-completed" }
  | { readonly status: "claimed-failed"; readonly errorClass: DaemonWorkloadErrorClass };

export type DaemonWorkloadClaim = () => boolean;
export type GovernedDaemonTick = (claim?: DaemonWorkloadClaim) => Promise<DaemonWorkloadTickOutcome>;

export interface DaemonWorkloadUnit {
  readonly id: DaemonWorkloadUnitId;
  readonly run: GovernedDaemonTick;
}

export interface DaemonWorkloadMetrics {
  readonly cpuMicros: () => number;
  readonly monotonicMs: () => number;
  readonly nowIso: () => string;
  readonly rssBytes: () => number;
}

export type DaemonWorkloadCycleResult =
  | { readonly status: "no-work" }
  | { readonly status: "cancelled-before-claim" }
  | { readonly status: "boundary"; readonly boundary: DaemonWorkloadBoundaryV2 };

export class DaemonWorkloadGovernor {
  private cursor = 0;
  private inFlight = false;

  constructor(
    private readonly units: readonly DaemonWorkloadUnit[],
    private readonly metrics: DaemonWorkloadMetrics = defaultMetrics()
  ) {
    if (units.length > DAEMON_WORKLOAD_UNIT_IDS.length) throw new Error(`daemon workload governor supports at most ${DAEMON_WORKLOAD_UNIT_IDS.length.toString()} units`);
    if (new Set(units.map((unit) => unit.id)).size !== units.length) throw new Error("daemon workload unit ids must be unique");
  }

  get queueDepth(): number {
    return this.units.length;
  }

  async runAdmittedCycle(
    signal: DaemonStopSignal,
    excludedUnits: ReadonlySet<DaemonWorkloadUnitId> = new Set()
  ): Promise<DaemonWorkloadCycleResult> {
    if (this.inFlight) return { status: "no-work" };
    this.inFlight = true;
    try {
      return await this.runExclusiveCycle(signal, excludedUnits);
    } finally {
      this.inFlight = false;
    }
  }

  private async runExclusiveCycle(
    signal: DaemonStopSignal,
    excludedUnits: ReadonlySet<DaemonWorkloadUnitId>
  ): Promise<DaemonWorkloadCycleResult> {
    if (signal.stopped) return { status: "cancelled-before-claim" };
    const total = this.units.length;
    if (total === 0) return { status: "no-work" };

    for (let offset = 0; offset < total; offset += 1) {
      if (signal.stopped) return { status: "cancelled-before-claim" };
      const index = (this.cursor + offset) % total;
      const unit = this.units[index]!;
      if (excludedUnits.has(unit.id)) continue;
      let claimed = false;
      let claimAtMs = 0;
      let cpuBefore = 0;
      let rssBefore = 0;
      const claim: DaemonWorkloadClaim = () => {
        if (claimed) return true;
        if (signal.stopped) return false;
        claimed = true;
        claimAtMs = this.metrics.monotonicMs();
        cpuBefore = this.metrics.cpuMicros();
        rssBefore = this.metrics.rssBytes();
        return true;
      };

      let outcome: DaemonWorkloadTickOutcome;
      try {
        outcome = await unit.run(claim);
      } catch {
        outcome = claimed ? { errorClass: "unknown", status: "claimed-failed" } : { reason: "internal-brake", status: "not-ready" };
      }
      if (outcome.status === "not-ready") {
        if (claimed) throw new Error(`daemon workload unit ${unit.id} claimed then reported not-ready`);
        continue;
      }
      if (outcome.status === "cancelled-before-claim") {
        if (claimed) throw new Error(`daemon workload unit ${unit.id} claimed then reported cancellation`);
        return { status: "cancelled-before-claim" };
      }
      if (!claimed) throw new Error(`daemon workload unit ${unit.id} reported a boundary without claiming`);

      const endedAtMs = this.metrics.monotonicMs();
      const stopRequestedDuring = signal.requestedAtMs !== undefined && signal.requestedAtMs >= claimAtMs;
      const boundary: DaemonWorkloadBoundaryV2 = {
        at: this.metrics.nowIso(),
        ...(stopRequestedDuring ? { boundaryLatencyMs: boundedDuration(endedAtMs - signal.requestedAtMs!) } : {}),
        cpuDeltaMicros: boundedCounter(this.metrics.cpuMicros() - cpuBefore),
        durationMs: boundedDuration(endedAtMs - claimAtMs),
        ...(outcome.status === "claimed-failed" ? { errorClass: outcome.errorClass } : {}),
        queueDepth: Math.max(0, total - 1),
        rssAfterBytes: boundedCounter(this.metrics.rssBytes()),
        rssBeforeBytes: boundedCounter(rssBefore),
        status: outcome.status === "claimed-failed" ? "failed" : "completed",
        stopRequestedDuring,
        unit: unit.id
      };
      this.cursor = (index + 1) % total;
      return { boundary, status: "boundary" };
    }
    return { status: "no-work" };
  }
}

export const daemonWorkloadNotReady = (reason: DaemonWorkloadNotReadyReason): DaemonWorkloadTickOutcome => ({ reason, status: "not-ready" });
export const daemonWorkloadCompleted = (): DaemonWorkloadTickOutcome => ({ status: "claimed-completed" });
export const daemonWorkloadFailed = (errorClass: DaemonWorkloadErrorClass = "unknown"): DaemonWorkloadTickOutcome => ({ errorClass, status: "claimed-failed" });
export const daemonWorkloadCancelled = (): DaemonWorkloadTickOutcome => ({ status: "cancelled-before-claim" });

function defaultMetrics(): DaemonWorkloadMetrics {
  return {
    cpuMicros: () => { const usage = process.cpuUsage(); return usage.user + usage.system; },
    monotonicMs: () => performance.now(),
    nowIso: () => new Date().toISOString(),
    rssBytes: () => process.memoryUsage().rss
  };
}

function boundedDuration(value: number): number {
  return Math.max(0, Math.min(86_400_000, Math.round(Number.isFinite(value) ? value : 0)));
}
function boundedCounter(value: number): number {
  return Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.round(Number.isFinite(value) ? value : 0)));
}
