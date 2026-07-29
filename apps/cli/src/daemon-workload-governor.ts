import type { DaemonStopSignal } from "./commands-daemon-loop.js";
import { DAEMON_WORKLOAD_UNIT_IDS, type DaemonWorkloadBoundaryV2, type DaemonWorkloadErrorClass, type DaemonWorkloadUnitId } from "./daemon-resource-receipt.js";

export type DaemonWorkloadNotReadyReason =
  | "disabled"
  | "unconfigured"
  | "not-due"
  | "internal-brake"
  | "local-only-auxiliary-unavailable";
export type DaemonWorkloadTickOutcome =
  | { readonly status: "not-ready"; readonly reason: DaemonWorkloadNotReadyReason }
  | { readonly status: "cancelled-before-claim" }
  | { readonly status: "claimed-completed" }
  | { readonly status: "claimed-failed"; readonly errorClass: DaemonWorkloadErrorClass };

export type DaemonWorkloadClaim = () => boolean;
export type GovernedDaemonTick = (claim?: DaemonWorkloadClaim) => Promise<DaemonWorkloadTickOutcome>;

export type DaemonWorkloadClaimDecision<T> =
  | { readonly status: "admit"; readonly token: T }
  | { readonly status: "defer"; readonly token: T };
export type DaemonWorkloadClaimGate<T> = () => DaemonWorkloadClaimDecision<T>;

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

export type GatedDaemonWorkloadCycleResult<T> =
  | { readonly status: "no-work" }
  | { readonly status: "cancelled-before-claim" }
  | { readonly status: "deferred-before-claim"; readonly claimToken: T }
  | { readonly status: "boundary"; readonly boundary: DaemonWorkloadBoundaryV2; readonly claimToken: T };

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

  runAdmittedCycle(
    signal: DaemonStopSignal,
    excludedUnits?: ReadonlySet<DaemonWorkloadUnitId>
  ): Promise<DaemonWorkloadCycleResult>;
  runAdmittedCycle<T>(
    signal: DaemonStopSignal,
    excludedUnits: ReadonlySet<DaemonWorkloadUnitId>,
    claimGate: DaemonWorkloadClaimGate<T>
  ): Promise<GatedDaemonWorkloadCycleResult<T>>;
  async runAdmittedCycle<T>(
    signal: DaemonStopSignal,
    excludedUnits: ReadonlySet<DaemonWorkloadUnitId> = new Set(),
    claimGate?: DaemonWorkloadClaimGate<T>
  ): Promise<DaemonWorkloadCycleResult | GatedDaemonWorkloadCycleResult<T>> {
    if (this.inFlight) return { status: "no-work" };
    this.inFlight = true;
    try {
      return await this.runExclusiveCycle(signal, excludedUnits, claimGate);
    } finally {
      this.inFlight = false;
    }
  }

  private async runExclusiveCycle<T>(
    signal: DaemonStopSignal,
    excludedUnits: ReadonlySet<DaemonWorkloadUnitId>,
    claimGate: DaemonWorkloadClaimGate<T> | undefined
  ): Promise<DaemonWorkloadCycleResult | GatedDaemonWorkloadCycleResult<T>> {
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
      let claimAdmitted = false;
      let claimDeferred = false;
      let admittedToken: T | undefined;
      let deferredToken: T | undefined;
      const claim: DaemonWorkloadClaim = () => {
        if (claimed) return true;
        if (signal.stopped) return false;
        if (claimDeferred) return false;
        const decision = claimGate?.();
        // A stop raised synchronously while the gate was observing resources
        // outranks resource deferral and retains the existing stop contract.
        if (signal.stopped) return false;
        if (decision?.status === "defer") {
          claimDeferred = true;
          deferredToken = decision.token;
          return false;
        }
        claimAdmitted = true;
        admittedToken = decision?.token;
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
      if (claimDeferred) {
        return { claimToken: deferredToken as T, status: "deferred-before-claim" };
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
      return claimGate && claimAdmitted
        ? { boundary, claimToken: admittedToken as T, status: "boundary" }
        : { boundary, status: "boundary" };
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
