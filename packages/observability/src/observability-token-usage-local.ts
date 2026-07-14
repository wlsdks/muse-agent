/**
 * Local-first token-usage persistence. The Kysely sink keeps usage in Postgres,
 * but the DEFAULT product runs local-only with no DB, where usage went to an
 * InMemory sink and died with the process — so `muse cost` (an /api/admin/* wrapper)
 * showed the local user nothing. This sink appends each model call's usage to a
 * local JSONL file so token/cost history survives across processes, and the pure
 * reader + aggregator below let a fresh `muse cost` summarize it with no server.
 *
 * Best-effort by design: a usage-log write NEVER breaks a turn (telemetry is not
 * load-bearing), and a corrupt line is skipped, never thrown.
 */

import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { isRecord } from "@muse/shared";
import type { QueryableTokenUsageSink, TokenUsageRecord } from "./index.js";

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function serializeRecord(event: TokenUsageRecord): Record<string, unknown> {
  return {
    completionTokens: event.completionTokens,
    estimatedCostUsd: event.estimatedCostUsd,
    model: event.model,
    promptCachedTokens: event.promptCachedTokens,
    promptTokens: event.promptTokens,
    provider: event.provider,
    reasoningTokens: event.reasoningTokens,
    runId: event.runId,
    stepType: event.stepType,
    totalTokens: event.totalTokens,
    ...(event.recordedAt ? { recordedAt: event.recordedAt.toISOString() } : {})
  };
}

function deserializeRecord(raw: unknown): TokenUsageRecord {
  const source = isRecord(raw) ? raw : {};
  const recordedAt = typeof source.recordedAt === "string" ? new Date(source.recordedAt) : undefined;
  return {
    completionTokens: finite(source.completionTokens),
    model: typeof source.model === "string" ? source.model : "unknown",
    promptTokens: finite(source.promptTokens),
    provider: typeof source.provider === "string" ? source.provider : "unknown",
    totalTokens: finite(source.totalTokens),
    ...(typeof source.stepType === "string" ? { stepType: source.stepType } : {}),
    ...(source.promptCachedTokens !== undefined ? { promptCachedTokens: finite(source.promptCachedTokens) } : {}),
    ...(source.reasoningTokens !== undefined ? { reasoningTokens: finite(source.reasoningTokens) } : {}),
    ...(source.estimatedCostUsd !== undefined ? { estimatedCostUsd: finite(source.estimatedCostUsd) } : {}),
    ...(recordedAt && !Number.isNaN(recordedAt.getTime()) ? { recordedAt } : {}),
    runId: typeof source.runId === "string" ? source.runId : "unknown"
  };
}

/** Appends each usage record to `filePath` (JSONL) AND mirrors in memory so the
 *  in-process TokenCostQuery still works. mkdir is lazy + cached.
 *
 *  Bounded: the in-memory mirror is a ring buffer (a long-lived server process
 *  can't leak heap), and the JSONL file is amortized-trimmed to the last `maxRows`
 *  so it can't grow forever (it was append-only with no retention). */
export class JsonlTokenUsageSink implements QueryableTokenUsageSink {
  readonly #events: TokenUsageRecord[] = [];
  readonly #maxRows: number;
  #ensuredDir = false;
  #appendsSinceTrim = 0;

  constructor(private readonly filePath: string, maxRows = 50_000) {
    this.#maxRows = Math.max(1, maxRows);
  }

  async record(event: TokenUsageRecord): Promise<void> {
    this.#events.push({ ...event });
    if (this.#events.length > this.#maxRows) this.#events.splice(0, this.#events.length - this.#maxRows);
    try {
      if (!this.#ensuredDir) {
        await mkdir(dirname(this.filePath), { recursive: true });
        this.#ensuredDir = true;
      }
      await appendFile(this.filePath, `${JSON.stringify(serializeRecord(event))}\n`, "utf8");
      // Amortized retention: every 500 appends, rewrite the file to the last maxRows.
      this.#appendsSinceTrim += 1;
      if (this.#appendsSinceTrim >= 500) {
        this.#appendsSinceTrim = 0;
        await this.#trimFile();
      }
    } catch {
      /* telemetry is best-effort — a usage-log write must never break a turn */
    }
  }

  async #trimFile(): Promise<void> {
    try {
      const lines = (await readFile(this.filePath, "utf8")).split("\n").filter((l) => l.trim().length > 0);
      if (lines.length <= this.#maxRows) return;
      const tmp = `${this.filePath}.tmp`;
      await writeFile(tmp, `${lines.slice(-this.#maxRows).join("\n")}\n`, "utf8");
      await rename(tmp, this.filePath);
    } catch {
      /* best-effort retention */
    }
  }

  list(): readonly TokenUsageRecord[] {
    return this.#events.map((event) => ({ ...event }));
  }
}

/** Read + parse the local usage JSONL (tolerant: a missing file → [], a corrupt
 *  line → skipped). For a fresh `muse cost` process with no DB. */
export async function readLocalTokenUsage(filePath: string): Promise<TokenUsageRecord[]> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return [];
  }
  const out: TokenUsageRecord[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRecord(parsed)) {
        out.push(deserializeRecord(parsed));
      }
    } catch {
      /* a half-written / corrupt line carries no signal — skip, never throw */
    }
  }
  return out;
}

export interface TokenUsageGroup {
  readonly key: string;
  readonly calls: number;
  readonly totalTokens: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly estimatedCostUsd: number;
}

export interface TokenUsageSummary {
  readonly calls: number;
  readonly totalTokens: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly reasoningTokens: number;
  readonly estimatedCostUsd: number;
  readonly byModel: readonly TokenUsageGroup[];
  readonly byRun: readonly TokenUsageGroup[];
  readonly byDay: readonly TokenUsageGroup[];
}

function groupBy(records: readonly TokenUsageRecord[], key: (r: TokenUsageRecord) => string | undefined): TokenUsageGroup[] {
  const map = new Map<string, TokenUsageGroup>();
  for (const r of records) {
    const k = key(r);
    if (k === undefined) continue;
    const prev = map.get(k) ?? { calls: 0, completionTokens: 0, estimatedCostUsd: 0, key: k, promptTokens: 0, totalTokens: 0 };
    map.set(k, {
      calls: prev.calls + 1,
      completionTokens: prev.completionTokens + finite(r.completionTokens),
      estimatedCostUsd: prev.estimatedCostUsd + finite(r.estimatedCostUsd),
      key: k,
      promptTokens: prev.promptTokens + finite(r.promptTokens),
      totalTokens: prev.totalTokens + finite(r.totalTokens)
    });
  }
  // Most-tokens first — the user wants the heaviest model / run / day on top.
  return [...map.values()].sort((a, b) => b.totalTokens - a.totalTokens);
}

/** Pure aggregation of usage records into totals + per-model / per-run / per-day
 *  breakdowns. NaN/Infinity-guarded so one corrupt row can't poison the sums. */
export function aggregateTokenUsage(records: readonly TokenUsageRecord[]): TokenUsageSummary {
  let totalTokens = 0, promptTokens = 0, completionTokens = 0, reasoningTokens = 0, estimatedCostUsd = 0;
  for (const r of records) {
    totalTokens += finite(r.totalTokens);
    promptTokens += finite(r.promptTokens);
    completionTokens += finite(r.completionTokens);
    reasoningTokens += finite(r.reasoningTokens);
    estimatedCostUsd += finite(r.estimatedCostUsd);
  }
  return {
    byDay: groupBy(records, (r) => r.recordedAt ? r.recordedAt.toISOString().slice(0, 10) : undefined),
    byModel: groupBy(records, (r) => r.model),
    byRun: groupBy(records, (r) => r.runId),
    calls: records.length,
    completionTokens,
    estimatedCostUsd,
    promptTokens,
    reasoningTokens,
    totalTokens
  };
}
