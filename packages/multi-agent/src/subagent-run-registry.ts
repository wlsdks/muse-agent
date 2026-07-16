/**
 * Tracks LIVE lifecycle of spawned sub-agent runs: run id, parent→child
 * relationship, status, timeout, and liveness/heartbeat. Distinct from
 * `OrchestrationHistory`, which records only FINISHED runs for audit —
 * this registry tracks RUNNING runs so orphaned/stalled child runs are
 * detectable before they complete.
 *
 * Reimplements the openclaw subagent-registry lifecycle mechanism (MIT,
 * no code copied — clean Muse implementation).
 */

export type SubAgentRunStatus = "running" | "completed" | "failed" | "timed-out" | "cancelled";

export interface SubAgentRunRecord {
  readonly runId: string;
  readonly parentRunId?: string;
  readonly status: SubAgentRunStatus;
  readonly startedAt: Date;
  readonly lastHeartbeatAt: Date;
  readonly timeoutMs: number;
  readonly finishedAt?: Date;
  readonly outcome?: string;
  readonly error?: string;
}

export interface SubAgentRunRegistryOptions {
  readonly now?: () => Date;
  readonly defaultTimeoutMs?: number;
}

export interface RegisterRunArgs {
  readonly runId: string;
  readonly parentRunId?: string;
  readonly timeoutMs?: number;
}

interface MutableRunRecord {
  runId: string;
  parentRunId?: string;
  status: SubAgentRunStatus;
  startedAt: Date;
  lastHeartbeatAt: Date;
  timeoutMs: number;
  finishedAt?: Date;
  outcome?: string;
  error?: string;
}

const TERMINAL_STATUSES = new Set<SubAgentRunStatus>(["completed", "failed", "timed-out", "cancelled"]);

function freeze(record: MutableRunRecord): SubAgentRunRecord {
  return Object.freeze({
    ...record,
    ...(record.finishedAt ? { finishedAt: new Date(record.finishedAt) } : {}),
    lastHeartbeatAt: new Date(record.lastHeartbeatAt),
    startedAt: new Date(record.startedAt)
  });
}

function normalizeStallTimeoutMs(timeoutMs: number, name: string): number {
  if (timeoutMs <= 0) {
    return 0;
  }
  if (!Number.isSafeInteger(timeoutMs)) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return timeoutMs;
}

export class SubAgentRunRegistry {
  private readonly records = new Map<string, MutableRunRecord>();
  private readonly insertionOrder: string[] = [];
  private readonly now: () => Date;
  private readonly defaultTimeoutMs: number;

  constructor(options: SubAgentRunRegistryOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.defaultTimeoutMs = normalizeStallTimeoutMs(options.defaultTimeoutMs ?? 0, "defaultTimeoutMs");
  }

  private currentTime(): Date {
    return new Date(this.now());
  }

  register(args: RegisterRunArgs): SubAgentRunRecord {
    const { runId, parentRunId, timeoutMs } = args;

    if (!runId || runId.trim() === "") {
      throw new RangeError("runId must be a non-empty string");
    }

    if (this.records.has(runId)) {
      throw new Error(`run id already registered: "${runId}" — duplicate run id is a coordination bug`);
    }

    if (parentRunId !== undefined && !this.records.has(parentRunId)) {
      throw new Error(`parentRunId "${parentRunId}" is not registered — a child must attach to a known parent`);
    }

    const now = this.currentTime();
    const record: MutableRunRecord = {
      lastHeartbeatAt: now,
      runId,
      startedAt: now,
      status: "running",
      timeoutMs: normalizeStallTimeoutMs(timeoutMs ?? this.defaultTimeoutMs, "timeoutMs")
    };

    if (parentRunId !== undefined) {
      record.parentRunId = parentRunId;
    }

    this.records.set(runId, record);
    this.insertionOrder.push(runId);

    return freeze(record);
  }

  heartbeat(runId: string): boolean {
    const record = this.records.get(runId);

    if (record === undefined || record.status !== "running") {
      return false;
    }

    record.lastHeartbeatAt = this.currentTime();
    return true;
  }

  complete(runId: string, outcome?: string): boolean {
    const record = this.records.get(runId);

    if (record === undefined || TERMINAL_STATUSES.has(record.status)) {
      return false;
    }

    record.status = "completed";
    record.finishedAt = this.currentTime();
    record.outcome = outcome;
    return true;
  }

  fail(runId: string, error?: string): boolean {
    const record = this.records.get(runId);

    if (record === undefined || TERMINAL_STATUSES.has(record.status)) {
      return false;
    }

    record.status = "failed";
    record.finishedAt = this.currentTime();
    record.error = error;
    return true;
  }

  markTimedOut(runId: string, error?: string): boolean {
    const record = this.records.get(runId);

    if (record === undefined || TERMINAL_STATUSES.has(record.status)) {
      return false;
    }

    record.status = "timed-out";
    record.finishedAt = this.currentTime();
    record.error = error;
    return true;
  }

  /**
   * User-requested stop. Terminal like fail/timeout, but recorded as its
   * own status so an operator can tell "I stopped it" from "it broke".
   * The orchestrator polls for this between worker steps (cooperative) —
   * an in-flight model call still settles, but its run stays cancelled
   * (terminal statuses are never overwritten).
   */
  cancel(runId: string, reason = "cancelled by user"): boolean {
    const record = this.records.get(runId);

    if (record === undefined || TERMINAL_STATUSES.has(record.status)) {
      return false;
    }

    record.status = "cancelled";
    record.finishedAt = this.currentTime();
    record.error = reason;
    return true;
  }

  get(runId: string): SubAgentRunRecord | undefined {
    const record = this.records.get(runId);
    return record === undefined ? undefined : freeze(record);
  }

  list(): readonly SubAgentRunRecord[] {
    return this.insertionOrder.map((id) => freeze(this.records.get(id)!));
  }

  children(parentRunId: string): readonly SubAgentRunRecord[] {
    return this.insertionOrder
      .map((id) => this.records.get(id)!)
      .filter((record) => record.parentRunId === parentRunId)
      .map(freeze);
  }

  activeCount(): number {
    let count = 0;
    for (const record of this.records.values()) {
      if (record.status === "running") count++;
    }
    return count;
  }

  detectStalled(): readonly SubAgentRunRecord[] {
    const now = this.currentTime();
    return this.insertionOrder
      .map((id) => this.records.get(id)!)
      .filter((record) => {
        if (record.status !== "running" || record.timeoutMs <= 0) return false;
        return now.getTime() - record.lastHeartbeatAt.getTime() > record.timeoutMs;
      })
      .map(freeze);
  }

  markStalledAsTimedOut(): readonly SubAgentRunRecord[] {
    const stalled = this.detectStalled();
    const now = this.currentTime();
    const transitioned: SubAgentRunRecord[] = [];

    for (const frozen of stalled) {
      const record = this.records.get(frozen.runId)!;
      record.status = "timed-out";
      record.finishedAt = now;
      transitioned.push(freeze(record));
    }

    return transitioned;
  }

  detectOrphaned(): readonly SubAgentRunRecord[] {
    return this.insertionOrder
      .map((id) => this.records.get(id)!)
      .filter((record) => {
        if (record.status !== "running" || record.parentRunId === undefined) return false;
        const parent = this.records.get(record.parentRunId);
        return parent !== undefined && TERMINAL_STATUSES.has(parent.status);
      })
      .map(freeze);
  }

  recoverOrphaned(error?: string): readonly SubAgentRunRecord[] {
    const orphaned = this.detectOrphaned();
    const now = this.currentTime();
    const recovered: SubAgentRunRecord[] = [];

    for (const frozen of orphaned) {
      const record = this.records.get(frozen.runId)!;
      record.status = "failed";
      record.finishedAt = now;
      record.error = error;
      recovered.push(freeze(record));
    }

    return recovered;
  }
}
