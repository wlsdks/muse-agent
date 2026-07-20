import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  InMemoryOrchestrationHistoryStore,
  type OrchestrationHistoryEntry,
  type OrchestrationHistoryStore,
  type OrchestrationHistorySummary
} from "@muse/multi-agent";
import { isJsonValue, type JsonObject } from "@muse/shared";

/**
 * Durable orchestration history: the in-memory store's exact semantics
 * (ordering, summary math) with a JSON file underneath, so `muse
 * orchestrate list` and the web agents view survive a server restart.
 * Delegation keeps one source of truth for the semantics; this class
 * only owns load/persist. Bounded to the newest entries so a chatty
 * daemon can't grow the file without limit.
 */

const MAX_PERSISTED_ENTRIES = 200;
const ORCHESTRATION_MODES = ["parallel", "race", "sequential"] as const;
const ORCHESTRATION_STATUSES = ["completed", "failed"] as const;

export function defaultOrchestrationHistoryFile(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.MUSE_ORCHESTRATION_HISTORY_FILE?.trim();
  if (override && override.length > 0) {
    return override;
  }
  const injectedHome = env.HOME?.trim() || env.USERPROFILE?.trim();
  return join(injectedHome && injectedHome.length > 0 ? injectedHome : homedir(), ".muse", "orchestration-history.json");
}

export class FileOrchestrationHistoryStore implements OrchestrationHistoryStore {
  private readonly memory = new InMemoryOrchestrationHistoryStore();

  constructor(private readonly file: string = defaultOrchestrationHistoryFile()) {
    for (const entry of this.load()) {
      this.memory.record(entry);
    }
  }

  record(entry: OrchestrationHistoryEntry): void {
    this.memory.record(entry);
    this.persist();
  }

  list(limit?: number): readonly OrchestrationHistoryEntry[] {
    return limit === undefined ? this.memory.list() : this.memory.list(limit);
  }

  getByRunId(runId: string): OrchestrationHistoryEntry | undefined {
    return this.memory.getByRunId(runId);
  }

  summary(): OrchestrationHistorySummary {
    return this.memory.summary();
  }

  clear(): void {
    this.memory.clear();
    this.persist();
  }

  private load(): readonly OrchestrationHistoryEntry[] {
    let raw: string;
    try {
      raw = readFileSync(this.file, "utf8");
    } catch {
      return [];
    }
    try {
      const parsed = JSON.parse(raw) as { entries?: unknown };
      if (!Array.isArray(parsed.entries)) {
        return [];
      }
      const entries: OrchestrationHistoryEntry[] = [];
      for (const rawEntry of parsed.entries) {
        if (!rawEntry || typeof rawEntry !== "object") {
          continue;
        }
        const entry = revivePersistedEntry(rawEntry as Record<string, unknown>);
        if (entry) {
          entries.push(entry);
        }
      }
      return entries;
    } catch {
      // A corrupt history file must not take the server down — start fresh.
      return [];
    }
  }

  private persist(): void {
    const entries = this.memory.list(MAX_PERSISTED_ENTRIES);
    const payload = `${JSON.stringify({ entries, version: 1 })}\n`;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid.toString()}`;
    writeFileSync(tmp, payload, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

function revivePersistedEntry(value: Record<string, unknown>): OrchestrationHistoryEntry | undefined {
  const startedAt = reviveDate(value.startedAt);
  const finishedAt = reviveDate(value.finishedAt);
  if (
    typeof value.runId !== "string" ||
    value.runId.length === 0 ||
    !isOrchestrationMode(value.mode) ||
    !isOrchestrationStatus(value.status) ||
    !isNonNegativeSafeInteger(value.workerCount) ||
    !isNonNegativeSafeInteger(value.completedCount) ||
    !isNonNegativeSafeInteger(value.failedCount) ||
    !isNonNegativeSafeInteger(value.durationMs) ||
    !startedAt ||
    !finishedAt ||
    finishedAt < startedAt ||
    (value.error !== undefined && typeof value.error !== "string") ||
    (value.conversation !== undefined && !isPersistedConversation(value.conversation)) ||
    (value.conflicts !== undefined && !isStringArray(value.conflicts)) ||
    (value.redundancies !== undefined && !isStringArray(value.redundancies)) ||
    (value.verificationSatisfied !== undefined && typeof value.verificationSatisfied !== "boolean")
  ) {
    return undefined;
  }

  return {
    ...(value.error === undefined ? {} : { error: value.error }),
    ...(value.conversation === undefined ? {} : { conversation: reviveConversation(value.conversation) }),
    ...(value.conflicts === undefined ? {} : { conflicts: value.conflicts }),
    ...(value.redundancies === undefined ? {} : { redundancies: value.redundancies }),
    ...(value.verificationSatisfied === undefined ? {} : { verificationSatisfied: value.verificationSatisfied }),
    completedCount: value.completedCount,
    durationMs: value.durationMs,
    failedCount: value.failedCount,
    finishedAt,
    mode: value.mode,
    runId: value.runId,
    startedAt,
    status: value.status,
    workerCount: value.workerCount
  };
}

function reviveConversation(value: readonly unknown[]): OrchestrationHistoryEntry["conversation"] {
  return value.map((message) => {
    const persisted = message as Record<string, unknown>;
    return {
      ...(persisted.metadata === undefined ? {} : { metadata: persisted.metadata as JsonObject }),
      ...(persisted.targetAgentId === undefined ? {} : { targetAgentId: persisted.targetAgentId as string }),
      content: persisted.content as string,
      sourceAgentId: persisted.sourceAgentId as string,
      timestamp: reviveDate(persisted.timestamp)!
    };
  });
}

function isPersistedConversation(value: unknown): value is readonly unknown[] {
  return Array.isArray(value) && value.every(isPersistedMessage);
}

function isPersistedMessage(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return false;
  }
  const message = value as Record<string, unknown>;
  return (
    typeof message.sourceAgentId === "string" &&
    typeof message.content === "string" &&
    reviveDate(message.timestamp) !== undefined &&
    (message.targetAgentId === undefined || typeof message.targetAgentId === "string") &&
    (message.metadata === undefined || isJsonObject(message.metadata))
  );
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && isJsonValue(value);
}

function reviveDate(value: unknown): Date | undefined {
  const date = new Date(typeof value === "string" ? value : "");
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isOrchestrationMode(value: unknown): value is OrchestrationHistoryEntry["mode"] {
  return typeof value === "string" && ORCHESTRATION_MODES.includes(value as OrchestrationHistoryEntry["mode"]);
}

function isOrchestrationStatus(value: unknown): value is OrchestrationHistoryEntry["status"] {
  return typeof value === "string" && ORCHESTRATION_STATUSES.includes(value as OrchestrationHistoryEntry["status"]);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
