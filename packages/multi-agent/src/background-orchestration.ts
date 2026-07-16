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

function snapshotRecord(record: BackgroundOrchestrationRecord): BackgroundOrchestrationRecord {
  // Fast path preserves every cloneable provider payload. Model `raw` fields
  // are intentionally `unknown`, however, and may contain SDK objects or
  // functions. A completed run must not become a failed run merely because an
  // opaque diagnostic value cannot be cloned.
  try {
    return structuredClone(record);
  } catch {
    return clonePlainData(record) as BackgroundOrchestrationRecord;
  }
}

function clonePlainData(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
  if (value === null || typeof value !== "object") {
    return typeof value === "function" ? undefined : value;
  }
  if (value instanceof Date) {
    return new Date(value);
  }
  const existing = seen.get(value);
  if (existing !== undefined) {
    return existing;
  }
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    copy.push(...value.map((item) => clonePlainData(item, seen)));
    return copy;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return undefined;
  }
  const copy: Record<string, unknown> = {};
  seen.set(value, copy);
  for (const [key, item] of Object.entries(value)) {
    copy[key] = clonePlainData(item, seen);
  }
  return copy;
}

export class InMemoryBackgroundOrchestrationStore implements BackgroundOrchestrationStore {
  private readonly records = new Map<string, BackgroundOrchestrationRecord>();
  private readonly insertionOrder: string[] = [];

  complete(record: BackgroundOrchestrationRecord): void {
    if (this.records.has(record.orchestrationId)) {
      return;
    }
    this.records.set(record.orchestrationId, snapshotRecord(record));
    this.insertionOrder.push(record.orchestrationId);
  }

  get(orchestrationId: string): BackgroundOrchestrationRecord | undefined {
    const record = this.records.get(orchestrationId);
    return record ? snapshotRecord(record) : undefined;
  }

  list(): readonly BackgroundOrchestrationRecord[] {
    return this.insertionOrder.map((id) => snapshotRecord(this.records.get(id)!));
  }
}
