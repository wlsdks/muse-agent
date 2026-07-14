import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { isRecord, type JsonObject, type JsonValue } from "@muse/shared";
import {
  InMemoryOrchestrationHistoryStore,
  type AgentMessage,
  type OrchestrationHistoryEntry,
  type OrchestrationHistoryStore,
  type OrchestrationHistorySummary,
  type OrchestrationMode
} from "@muse/multi-agent";

/**
 * Durable orchestration history: the in-memory store's exact semantics
 * (ordering, summary math) with a JSON file underneath, so `muse
 * orchestrate list` and the web agents view survive a server restart.
 * Delegation keeps one source of truth for the semantics; this class
 * only owns load/persist. Bounded to the newest entries so a chatty
 * daemon can't grow the file without limit.
 */

const MAX_PERSISTED_ENTRIES = 200;

export function defaultOrchestrationHistoryFile(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.MUSE_ORCHESTRATION_HISTORY_FILE?.trim();
  if (override && override.length > 0) {
    return override;
  }
  return join(homedir(), ".muse", "orchestration-history.json");
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
      const parsed = parseOrchestrationHistoryPayload(JSON.parse(raw));
      if (parsed === undefined) {
        return [];
      }

      const entries: OrchestrationHistoryEntry[] = [];
      for (const rawEntry of parsed) {
        const entry = parseOrchestrationHistoryEntry(rawEntry);
        if (entry !== undefined) {
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

function parseOrchestrationHistoryPayload(raw: unknown): readonly unknown[] | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  return Array.isArray(raw.entries) ? raw.entries : undefined;
}

function parseOrchestrationHistoryEntry(rawEntry: unknown): OrchestrationHistoryEntry | undefined {
  if (!isRecord(rawEntry)) {
    return undefined;
  }

  const runId = typeof rawEntry.runId === "string" && rawEntry.runId.length > 0 ? rawEntry.runId : undefined;
  if (runId === undefined) {
    return undefined;
  }

  const mode = rawEntry.mode;
  if (!isOrchestrationMode(mode)) {
    return undefined;
  }

  const status = rawEntry.status;
  if (!isOrchestrationStatus(status)) {
    return undefined;
  }

  const startedAt = toDate(rawEntry.startedAt);
  const finishedAt = toDate(rawEntry.finishedAt);
  if (startedAt === undefined || finishedAt === undefined) {
    return undefined;
  }

  const workerCount = toFiniteInteger(rawEntry.workerCount);
  const completedCount = toFiniteInteger(rawEntry.completedCount);
  const failedCount = toFiniteInteger(rawEntry.failedCount);
  const durationMs = toFiniteNumber(rawEntry.durationMs);
  if (
    workerCount === undefined
    || completedCount === undefined
    || failedCount === undefined
    || durationMs === undefined
  ) {
    return undefined;
  }

  const conversation = parseConversation(rawEntry.conversation);
  const conflicts = toStringArray(rawEntry.conflicts);
  const redundancies = toStringArray(rawEntry.redundancies);
  const verificationSatisfied = typeof rawEntry.verificationSatisfied === "boolean"
    ? rawEntry.verificationSatisfied
    : undefined;
  const error = typeof rawEntry.error === "string" ? rawEntry.error : undefined;

  return {
    ...toConversationField(conversation),
    completedCount,
    ...(conflicts !== undefined ? { conflicts } : {}),
    ...(error !== undefined ? { error } : {}),
    durationMs,
    failedCount,
    finishedAt,
    mode,
    ...(verificationSatisfied !== undefined ? { verificationSatisfied } : {}),
    ...(redundancies !== undefined ? { redundancies } : {}),
    runId,
    startedAt,
    status,
    workerCount
  };
}

function isOrchestrationMode(value: unknown): value is OrchestrationMode {
  return value === "parallel" || value === "race" || value === "sequential";
}

function isOrchestrationStatus(value: unknown): value is OrchestrationHistoryEntry["status"] {
  return value === "completed" || value === "failed";
}

function toFiniteInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function toFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function toDate(value: unknown): Date | undefined {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value;
  }
  if (typeof value !== "string" && typeof value !== "number") {
    return undefined;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function toConversation(value: unknown): readonly AgentMessage[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const out: AgentMessage[] = [];
  for (const rawMessage of value) {
    const message = parseAgentMessage(rawMessage);
    if (message !== undefined) {
      out.push(message);
    }
  }
  return out;
}

function parseAgentMessage(rawMessage: unknown): AgentMessage | undefined {
  if (!isRecord(rawMessage)) {
    return undefined;
  }

  const sourceAgentId = typeof rawMessage.sourceAgentId === "string" && rawMessage.sourceAgentId.length > 0
    ? rawMessage.sourceAgentId
    : undefined;
  const content = typeof rawMessage.content === "string" ? rawMessage.content : undefined;
  const timestamp = toDate(rawMessage.timestamp);
  if (sourceAgentId === undefined || content === undefined || timestamp === undefined) {
    return undefined;
  }

  const targetAgentId = typeof rawMessage.targetAgentId === "string" && rawMessage.targetAgentId.length > 0
    ? rawMessage.targetAgentId
    : undefined;
  const metadata = parseJsonObject(rawMessage.metadata);

  return {
    content,
    sourceAgentId,
    timestamp,
    ...(metadata !== undefined ? { metadata } : {}),
    ...(targetAgentId !== undefined ? { targetAgentId } : {})
  };
}

function toConversationField(conversation: readonly AgentMessage[] | undefined): Pick<OrchestrationHistoryEntry, "conversation"> {
  return conversation === undefined || conversation.length === 0 ? {} : { conversation };
}

function toStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === "string")) {
    return undefined;
  }
  return value;
}

function parseJsonObject(value: unknown): JsonObject | undefined {
  const parsed = parseJsonValue(value);
  if (parsed === undefined || !isJsonRecord(parsed)) {
    return undefined;
  }
  return parsed;
}

function parseJsonValue(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((entry) => parseJsonValue(entry))
      .filter((entry): entry is JsonValue => entry !== undefined);
  }
  if (isRecord(value)) {
    const out: JsonObject = {};
    for (const [key, raw] of Object.entries(value)) {
      const parsed = parseJsonValue(raw);
      if (parsed !== undefined) {
        out[key] = parsed;
      }
    }
    return out;
  }
  return undefined;
}

function isJsonRecord(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
