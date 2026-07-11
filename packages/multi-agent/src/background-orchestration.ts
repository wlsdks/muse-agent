import type { AgentRunResult } from "@muse/agent-core";
import type { OrchestrationStepResult } from "./index.js";

/**
 * Returned SYNCHRONOUSLY by `MultiAgentOrchestrator.runBackground` — the
 * caller gets the run id + how many sub-agents were dispatched WITHOUT
 * waiting for any of them to finish, so a slow local model never blocks the
 * calling turn (hermes-parity background fan-out).
 */
export interface BackgroundOrchestrationHandle {
  readonly orchestrationId: string;
  readonly subtaskCount: number;
}

/**
 * The consolidated result of a background orchestration, recorded ONCE when
 * the LAST dispatched worker settles. `response`/`results` are present on
 * `"completed"` (the same fan-in shape `MultiAgentOrchestrator.run` returns —
 * built by the SAME `buildOrchestrationResponse`, so a background run and a
 * blocking run never diverge in shape); `error` is present on `"failed"`
 * (every worker failed / threw, or dispatch itself threw) — a failure is
 * always CAPTURED here, never a silently dropped promise.
 */
export type BackgroundOrchestrationRecord =
  | {
      readonly orchestrationId: string;
      readonly status: "completed";
      readonly subtaskCount: number;
      readonly workerIds: readonly string[];
      readonly response: AgentRunResult["response"];
      readonly results: readonly OrchestrationStepResult[];
      readonly finishedAt: Date;
    }
  | {
      readonly orchestrationId: string;
      readonly status: "failed";
      readonly subtaskCount: number;
      readonly workerIds: readonly string[];
      readonly error: string;
      readonly finishedAt: Date;
    };

/**
 * Where a background orchestration's consolidated result lands when it
 * finishes — the re-entry seam a chat surface polls to surface ONE merged
 * entry (never N per-worker entries) once the run is done.
 */
export interface BackgroundOrchestrationStore {
  /**
   * Record the consolidated result. MUST be idempotent per `orchestrationId`
   * — termination is explicit (consolidation fires exactly once) even if a
   * caller's continuation somehow ran twice for the same run; a second call
   * for an id already present is a no-op, never a silent overwrite.
   */
  complete(record: BackgroundOrchestrationRecord): void;
  get(orchestrationId: string): BackgroundOrchestrationRecord | undefined;
  list(): readonly BackgroundOrchestrationRecord[];
}

export class InMemoryBackgroundOrchestrationStore implements BackgroundOrchestrationStore {
  private readonly records = new Map<string, BackgroundOrchestrationRecord>();
  private readonly insertionOrder: string[] = [];

  complete(record: BackgroundOrchestrationRecord): void {
    if (this.records.has(record.orchestrationId)) {
      return;
    }
    this.records.set(record.orchestrationId, record);
    this.insertionOrder.push(record.orchestrationId);
  }

  get(orchestrationId: string): BackgroundOrchestrationRecord | undefined {
    return this.records.get(orchestrationId);
  }

  list(): readonly BackgroundOrchestrationRecord[] {
    return this.insertionOrder.map((id) => this.records.get(id)!);
  }
}
