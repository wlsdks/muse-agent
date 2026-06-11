/**
 * ACT-R base-level activation (Anderson & Schooler 1991, "Reflections of the
 * Environment in Memory"): the probability a memory is needed next tracks a
 * power law over its FULL access history — frequency and spacing, not just the
 * last touch. `B = ln(Σ tᵢ^−d)` with tᵢ the age of each access and d≈0.5.
 * A single half-life decay (what this replaces where access logs exist)
 * discards exactly the two signals that separate a durable memory from a
 * one-off.
 */
const DAY_MS = 86_400_000;
const DEFAULT_DECAY = 0.5;
/** Ages clamp to ~15 minutes so a just-touched item cannot yield t^-d → ∞. */
const MIN_AGE_DAYS = 0.01;

export function baseLevelActivation(
  accessTimesMs: readonly number[],
  nowMs: number,
  decay: number = DEFAULT_DECAY
): number {
  let sum = 0;
  for (const accessMs of accessTimesMs) {
    if (!Number.isFinite(accessMs)) {
      continue;
    }
    const ageDays = Math.max(MIN_AGE_DAYS, (nowMs - accessMs) / DAY_MS);
    sum += Math.pow(ageDays, -decay);
  }
  return sum === 0 ? Number.NEGATIVE_INFINITY : Math.log(sum);
}

/**
 * Map activation onto a bounded additive boost comparable to the legacy
 * recency boost: `weight · σ(B)`. σ keeps it in (0, weight) for any history;
 * an empty history contributes nothing.
 */
export function computeActivationBoost(
  accessTimesMs: readonly number[],
  nowMs: number,
  weight: number,
  decay: number = DEFAULT_DECAY
): number {
  if (weight <= 0) {
    return 0;
  }
  const activation = baseLevelActivation(accessTimesMs, nowMs, decay);
  if (activation === Number.NEGATIVE_INFINITY) {
    return 0;
  }
  return weight / (1 + Math.exp(-activation));
}

export interface RecallHitStats {
  readonly hits: number;
  readonly lastHitMs: number;
  readonly createdMs: number;
}

/**
 * Base-level activation from COUNT + WINDOW when the full access history
 * isn't stored (the recall-hits ledger keeps `hits` and `lastHitMs` only):
 * synthesize uniformly-spaced access times from creation to the last hit —
 * ACT-R's standard optimized-learning approximation (Petrov 2006; Anderson &
 * Lebiere 1998) — and reuse the exact activation sum. Frequency and overall
 * recency are preserved; only the true spacing pattern is idealized.
 */
export function approximateActivationBoost(
  stats: RecallHitStats,
  nowMs: number,
  weight: number,
  decay?: number
): number {
  if (!Number.isFinite(stats.createdMs) || !Number.isFinite(stats.lastHitMs) || stats.hits <= 0) {
    return 0;
  }
  const first = Math.min(stats.createdMs, stats.lastHitMs);
  const last = stats.lastHitMs;
  const count = Math.max(1, Math.trunc(stats.hits));
  const times: number[] = [];
  if (count === 1) {
    times.push(last);
  } else {
    const step = (last - first) / (count - 1);
    for (let index = 0; index < count; index += 1) {
      times.push(first + step * index);
    }
  }
  return computeActivationBoost(times, nowMs, weight, decay);
}
