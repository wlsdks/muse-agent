import { planMemoryConsolidationTick, type MemoryConsolidationTickState, type RecallHitLike } from "@muse/memory";

export interface MemoryConsolidationTickDeps {
  readonly enabled: boolean;
  readonly nowMs: number;
  readonly lastRunMs: number | undefined;
  readonly readHits: () => Promise<readonly RecallHitLike[]>;
  readonly log: (line: string) => void;
  readonly minIntervalMs?: number;
  readonly minNewHits?: number;
  /** Rank the promote/fade plan by ACT-R base-level activation (frequency×spacing
   *  over every access) instead of last-hit recency alone — so the BACKGROUND tick
   *  ranks consistently with the manual `muse memory consolidate` (which sets it).
   *  Sort-order only; the eligibility filter is unchanged. Default off (legacy). */
  readonly useActrRanking?: boolean;
  /** When provided AND the brake passes, actually persist promotions (graduate the
   *  top recalled memories into the persona). Absent ⇒ report-only (just log the plan).
   *  Returns the promoted count for the log. */
  readonly persist?: () => Promise<{ readonly promoted: number }>;
  /** When provided AND the brake passes, persist the COMPUTED fade keys to the
   *  recall down-ranking sidecar — so the background tick keeps fade fresh, not
   *  only when a human runs `muse memory consolidate`. Ranking-only + fail-soft;
   *  independent of `persist` (promotions). Absent ⇒ fade stays report-only. */
  readonly persistFade?: (fadeKeys: readonly string[]) => Promise<void>;
}

/**
 * One background memory-consolidation tick: if enabled, read recall hits and run
 * planMemoryConsolidationTick (brake-gated). When `deps.persist` is provided the
 * brake-passed run persists promotions into the persona; otherwise report-only.
 * Fail-soft (a read/plan/persist error logs nothing / promoted=0 and leaves state
 * unchanged on read/plan errors; persist errors are swallowed but state advances).
 * Returns the next scheduling state for the daemon closure to keep.
 */
export async function runMemoryConsolidationTick(deps: MemoryConsolidationTickDeps): Promise<MemoryConsolidationTickState> {
  if (!deps.enabled) return { lastRunMs: deps.lastRunMs };
  let records: readonly RecallHitLike[];
  try {
    records = await deps.readHits();
  } catch {
    return { lastRunMs: deps.lastRunMs };
  }
  const result = planMemoryConsolidationTick(records, { lastRunMs: deps.lastRunMs }, {
    nowMs: deps.nowMs,
    ...(deps.minIntervalMs !== undefined ? { minIntervalMs: deps.minIntervalMs } : {}),
    ...(deps.minNewHits !== undefined ? { minNewHits: deps.minNewHits } : {}),
    ...(deps.useActrRanking !== undefined ? { useActrRanking: deps.useActrRanking } : {})
  });
  if (result.ran && result.plan) {
    if (deps.persist) {
      let promoted = 0;
      try { promoted = (await deps.persist()).promoted; } catch { /* fail-soft */ }
      deps.log(`[${new Date(deps.nowMs).toISOString()}] consolidate-memory: ${promoted.toString()} promoted (persisted), ${result.plan.fade.length.toString()} fading`);
    } else {
      deps.log(`[${new Date(deps.nowMs).toISOString()}] consolidate-memory: ${result.plan.promote.length.toString()} promotable, ${result.plan.fade.length.toString()} fading (report-only)`);
    }
    if (deps.persistFade) {
      try { await deps.persistFade(result.plan.fade.map((f) => f.key)); } catch { /* fail-soft */ }
    }
  }
  return result.nextState;
}
