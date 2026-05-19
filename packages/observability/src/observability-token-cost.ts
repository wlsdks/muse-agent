/**
 * Token-usage + cost-analytics primitives extracted from
 * packages/observability/src/index.ts.
 *
 * Owns the in-memory and Kysely-backed `TokenUsageSink` implementations,
 * the `TokenCostQuery` interface + its in-memory and Kysely
 * implementations (`bySession` runId-prefix lookup, `daily` model-bucketed
 * aggregation, `topExpensive` per-runId sum + DESC-by-cost ranking with
 * limit), and the TokenUsageSink decorator that fans recorded usage
 * events into the `MonthlyBudgetTracker`. All four `TokenCost*Entry`
 * shapes + `TokenCostQueryWindow` type move with the queries.
 *
 * Re-exported from the observability barrel for backwards compatibility.
 */

import type { MuseDatabase } from "@muse/db";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { MonthlyBudgetTracker } from "./observability-detectors.js";
import type {
  QueryableTokenUsageSink,
  TokenUsageRecord,
  TokenUsageSink
} from "./index.js";

// `?? 0` does NOT catch NaN / Infinity. A single corrupt or
// badly-derived `estimatedCostUsd` (tokens × an undefined rate, a
// hand-edited "NaN" DB row) would otherwise poison the WHOLE
// daily / top-expensive / per-session aggregate it sums into AND
// the cost sort comparator (NaN ⇒ spec-undefined order). Same
// guard the scheduler / parseInteger / episode summariser use.
function finiteCostUsd(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export class InMemoryTokenUsageSink implements QueryableTokenUsageSink {
  readonly #events: TokenUsageRecord[] = [];

  async record(event: TokenUsageRecord): Promise<void> {
    this.#events.push(cloneTokenUsageRecord(event));
  }

  list(): readonly TokenUsageRecord[] {
    return this.#events.map(cloneTokenUsageRecord);
  }
}

export class KyselyTokenUsageSink implements TokenUsageSink {
  constructor(private readonly db: Kysely<MuseDatabase>) {}

  async record(event: TokenUsageRecord): Promise<void> {
    await this.db
      .insertInto("metric_token_usage")
      .values({
        completion_tokens: event.completionTokens,
        estimated_cost_usd: event.estimatedCostUsd === undefined ? "0" : String(event.estimatedCostUsd),
        model: event.model,
        prompt_cached_tokens: event.promptCachedTokens ?? 0,
        prompt_tokens: event.promptTokens,
        provider: event.provider,
        reasoning_tokens: event.reasoningTokens ?? 0,
        run_id: event.runId,
        step_type: event.stepType ?? "act",
        time: event.recordedAt ?? new Date(),
        total_tokens: event.totalTokens
      })
      .execute();
  }
}

export interface TokenCostBySessionEntry {
  readonly runId: string;
  readonly model: string;
  readonly provider: string;
  readonly stepType: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly estimatedCostUsd: number;
  readonly time: Date;
}

export interface TokenCostDailyEntry {
  readonly day: string;
  readonly model: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly totalCostUsd: number;
}

export interface TokenCostTopExpensiveEntry {
  readonly runId: string;
  readonly model: string;
  readonly totalTokens: number;
  readonly totalCostUsd: number;
  readonly time: Date;
}

export interface TokenCostQueryWindow {
  readonly from: Date;
  readonly to: Date;
}

export interface TokenCostQuery {
  bySession(runId: string): Promise<readonly TokenCostBySessionEntry[]>;
  daily(window: TokenCostQueryWindow): Promise<readonly TokenCostDailyEntry[]>;
  topExpensive(window: TokenCostQueryWindow & { readonly limit: number }): Promise<readonly TokenCostTopExpensiveEntry[]>;
}

export class InMemoryTokenCostQuery implements TokenCostQuery {
  constructor(private readonly sink: QueryableTokenUsageSink) {}

  async bySession(runId: string): Promise<readonly TokenCostBySessionEntry[]> {
    return this.sink
      .list()
      .filter((event) => event.runId.startsWith(runId))
      .map((event) => ({
        completionTokens: event.completionTokens,
        estimatedCostUsd: finiteCostUsd(event.estimatedCostUsd),
        model: event.model,
        promptTokens: event.promptTokens,
        provider: event.provider,
        runId: event.runId,
        stepType: event.stepType ?? "act",
        time: event.recordedAt ?? new Date(0),
        totalTokens: event.totalTokens
      }))
      .sort((a, b) => a.time.getTime() - b.time.getTime());
  }

  async daily(window: TokenCostQueryWindow): Promise<readonly TokenCostDailyEntry[]> {
    const groups = new Map<string, { day: string; model: string; promptTokens: number; completionTokens: number; totalTokens: number; totalCostUsd: number }>();
    for (const event of this.sink.list()) {
      const at = event.recordedAt;
      if (!at || at < window.from || at >= window.to) {
        continue;
      }
      const day = at.toISOString().slice(0, 10);
      const key = `${day}|${event.model}`;
      const existing = groups.get(key) ?? {
        completionTokens: 0,
        day,
        model: event.model,
        promptTokens: 0,
        totalCostUsd: 0,
        totalTokens: 0
      };
      groups.set(key, {
        completionTokens: existing.completionTokens + event.completionTokens,
        day,
        model: event.model,
        promptTokens: existing.promptTokens + event.promptTokens,
        totalCostUsd: existing.totalCostUsd + finiteCostUsd(event.estimatedCostUsd),
        totalTokens: existing.totalTokens + event.totalTokens
      });
    }
    return [...groups.values()].sort((a, b) => {
      if (a.day === b.day) {
        return b.totalCostUsd - a.totalCostUsd;
      }
      return a.day < b.day ? 1 : -1;
    });
  }

  async topExpensive(input: TokenCostQueryWindow & { readonly limit: number }): Promise<readonly TokenCostTopExpensiveEntry[]> {
    const groups = new Map<string, { runId: string; model: string; totalTokens: number; totalCostUsd: number; time: Date }>();
    for (const event of this.sink.list()) {
      const at = event.recordedAt;
      if (!at || at < input.from || at >= input.to) {
        continue;
      }
      const existing = groups.get(event.runId);
      if (existing) {
        groups.set(event.runId, {
          model: event.model,
          runId: event.runId,
          time: at > existing.time ? at : existing.time,
          totalCostUsd: existing.totalCostUsd + finiteCostUsd(event.estimatedCostUsd),
          totalTokens: existing.totalTokens + event.totalTokens
        });
      } else {
        groups.set(event.runId, {
          model: event.model,
          runId: event.runId,
          time: at,
          totalCostUsd: finiteCostUsd(event.estimatedCostUsd),
          totalTokens: event.totalTokens
        });
      }
    }
    return [...groups.values()]
      // Cost-tie fallback to token volume: a Qwen-only / local-LLM
      // setup has every run at cost 0, which would make this ranking
      // an arbitrary all-ties order. Token count is the meaningful
      // proxy for "most expensive" when the dollar cost is free.
      .sort((a, b) => b.totalCostUsd - a.totalCostUsd || b.totalTokens - a.totalTokens)
      .slice(0, Math.max(0, input.limit));
  }
}

export class KyselyTokenCostQuery implements TokenCostQuery {
  constructor(private readonly db: Kysely<MuseDatabase>) {}

  async bySession(runId: string): Promise<readonly TokenCostBySessionEntry[]> {
    const rows = await this.db
      .selectFrom("metric_token_usage")
      .select([
        "run_id",
        "model",
        "provider",
        "step_type",
        "prompt_tokens",
        "completion_tokens",
        "total_tokens",
        "estimated_cost_usd",
        "time"
      ])
      .where("run_id", "like", `${runId}%`)
      .orderBy("time", "asc")
      .execute();
    return rows.map((row) => ({
      completionTokens: Number(row.completion_tokens),
      estimatedCostUsd: finiteCostUsd(Number(row.estimated_cost_usd ?? 0)),
      model: row.model,
      promptTokens: Number(row.prompt_tokens),
      provider: row.provider,
      runId: row.run_id,
      stepType: row.step_type,
      time: row.time instanceof Date ? row.time : new Date(row.time as unknown as string),
      totalTokens: Number(row.total_tokens)
    }));
  }

  async daily(window: TokenCostQueryWindow): Promise<readonly TokenCostDailyEntry[]> {
    const rows = await sql<{
      day: Date | string;
      model: string;
      prompt_tokens: string | number | null;
      completion_tokens: string | number | null;
      total_tokens: string | number | null;
      total_cost_usd: string | number | null;
    }>`
      SELECT
        DATE(time) AS day,
        model,
        SUM(prompt_tokens)::BIGINT AS prompt_tokens,
        SUM(completion_tokens)::BIGINT AS completion_tokens,
        SUM(total_tokens)::BIGINT AS total_tokens,
        SUM(estimated_cost_usd)::FLOAT8 AS total_cost_usd
      FROM metric_token_usage
      WHERE time >= ${window.from} AND time < ${window.to}
      GROUP BY DATE(time), model
      ORDER BY day DESC, total_cost_usd DESC
    `.execute(this.db);

    return rows.rows.map((row) => ({
      completionTokens: Number(row.completion_tokens ?? 0),
      day: row.day instanceof Date ? row.day.toISOString().slice(0, 10) : String(row.day).slice(0, 10),
      model: row.model,
      promptTokens: Number(row.prompt_tokens ?? 0),
      totalCostUsd: Number(row.total_cost_usd ?? 0),
      totalTokens: Number(row.total_tokens ?? 0)
    }));
  }

  async topExpensive(input: TokenCostQueryWindow & { readonly limit: number }): Promise<readonly TokenCostTopExpensiveEntry[]> {
    const limit = Math.max(0, input.limit);
    const rows = await sql<{
      run_id: string;
      total_tokens: string | number | null;
      total_cost_usd: string | number | null;
      model: string;
      time: Date | string;
    }>`
      SELECT
        run_id,
        SUM(total_tokens)::BIGINT AS total_tokens,
        SUM(estimated_cost_usd)::FLOAT8 AS total_cost_usd,
        MAX(model) AS model,
        MAX(time) AS time
      FROM metric_token_usage
      WHERE time >= ${input.from} AND time < ${input.to}
      GROUP BY run_id
      ORDER BY total_cost_usd DESC, total_tokens DESC
      LIMIT ${limit}
    `.execute(this.db);

    return rows.rows.map((row) => ({
      model: row.model,
      runId: row.run_id,
      time: row.time instanceof Date ? row.time : new Date(row.time as unknown as string),
      totalCostUsd: Number(row.total_cost_usd ?? 0),
      totalTokens: Number(row.total_tokens ?? 0)
    }));
  }
}

/**
 * Wraps a TokenUsageSink so each recorded usage event also feeds a
 * `MonthlyBudgetTracker` (single-bucket monthly accumulation). The current
 * snapshot surfaces via `/api/admin/muse/snapshot.budget`.
 */
export function createBudgetTrackingTokenUsageSink(
  tracker: MonthlyBudgetTracker,
  inner: TokenUsageSink
): TokenUsageSink {
  return wrapTokenUsageSink(inner, async (event) => {
    tracker.recordCost(event.estimatedCostUsd ?? 0);
  });
}

function wrapTokenUsageSink(
  inner: TokenUsageSink,
  onRecord: (event: TokenUsageRecord) => Promise<void> | void
): TokenUsageSink {
  const queryable = (inner as Partial<QueryableTokenUsageSink>).list;
  const base: TokenUsageSink = {
    async record(event) {
      await onRecord(event);
      await inner.record(event);
    }
  };
  if (typeof queryable === "function") {
    return Object.assign(base, {
      list: () => (inner as QueryableTokenUsageSink).list()
    }) as QueryableTokenUsageSink;
  }
  return base;
}

function cloneTokenUsageRecord(event: TokenUsageRecord): TokenUsageRecord {
  return {
    completionTokens: event.completionTokens,
    estimatedCostUsd: event.estimatedCostUsd,
    model: event.model,
    promptCachedTokens: event.promptCachedTokens,
    promptTokens: event.promptTokens,
    provider: event.provider,
    reasoningTokens: event.reasoningTokens,
    recordedAt: event.recordedAt ? new Date(event.recordedAt.getTime()) : undefined,
    runId: event.runId,
    stepType: event.stepType,
    totalTokens: event.totalTokens
  };
}
