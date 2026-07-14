import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  InMemoryOrchestrationHistoryStore,
  type OrchestrationHistoryEntry,
  type OrchestrationHistoryStore,
  type OrchestrationHistorySummary
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
      const parsed = JSON.parse(raw) as { entries?: unknown };
      if (!Array.isArray(parsed.entries)) {
        return [];
      }
      const entries: OrchestrationHistoryEntry[] = [];
      for (const rawEntry of parsed.entries) {
        if (!rawEntry || typeof rawEntry !== "object") {
          continue;
        }
        const entry = reviveDates(rawEntry as Record<string, unknown>);
        if (typeof entry.runId === "string" && entry.startedAt instanceof Date && !Number.isNaN(entry.startedAt.getTime())) {
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

function reviveDates(e: Record<string, unknown>): OrchestrationHistoryEntry {
  // conversation timestamps must come back as Dates too — the detail
  // route calls .toISOString() on them.
  const conversation = Array.isArray(e.conversation)
    ? e.conversation
        .filter((m): m is Record<string, unknown> => Boolean(m) && typeof m === "object")
        .map((m) => ({ ...m, timestamp: new Date(String(m.timestamp)) }))
    : undefined;
  return {
    ...e,
    ...(conversation ? { conversation } : {}),
    finishedAt: new Date(String(e.finishedAt)),
    startedAt: new Date(String(e.startedAt))
  } as OrchestrationHistoryEntry;
}
