/**
 * Pure scoring for the cascade eval (`eval:cascade`) — the C3 proof for the
 * FrugalGPT cascade (arXiv:2305.05176): does opt-in cascade save latency vs
 * always running the heavy model, WITHOUT downgrading a hard query?
 *
 * No I/O — the live runner (`scripts/eval-cascade.mjs`) feeds these the
 * per-prompt timings + the fast-pass confidence + whether it escalated, so the
 * verdict logic is unit-tested without Ollama.
 */

export function meanMs(latencies) {
  const nums = latencies.filter((n) => typeof n === "number" && Number.isFinite(n));
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

export function escalationRate(outcomes) {
  if (!Array.isArray(outcomes) || outcomes.length === 0) return 0;
  return outcomes.filter((o) => o.escalated).length / outcomes.length;
}

/**
 * Two dimensions, both required for cascade to be a real win:
 *  - latencyWin: cascade's MEAN latency beats always-heavy by more than
 *    `tolerancePct` (the saving comes from fast-accepted easy queries).
 *  - gateCorrect: the escalation gate fired correctly on EVERY query — a
 *    low/undefined fast-confidence (< `threshold`) escalated, a high one did
 *    not. This is the accuracy guard: a weak fast answer is never silently
 *    kept (it escalates to heavy), and a confident one is never needlessly
 *    escalated. A gate violation names the prompt.
 */
export function scoreCascadeEval(perQuery, threshold = -1.0, tolerancePct = 5) {
  if (!Array.isArray(perQuery) || perQuery.length === 0) {
    throw new Error("scoreCascadeEval requires at least one per-query result");
  }
  const cascadeMean = meanMs(perQuery.map((q) => q.cascadeMs));
  const heavyMean = meanMs(perQuery.map((q) => q.heavyMs));
  const latencyDeltaPct = heavyMean > 0 ? ((heavyMean - cascadeMean) / heavyMean) * 100 : 0;
  const gateViolations = perQuery.filter((q) => {
    const lowConfidence = q.fastConfidence === undefined || !Number.isFinite(q.fastConfidence) || q.fastConfidence < threshold;
    return lowConfidence !== Boolean(q.escalated); // escalated iff low-confidence
  });
  return {
    cascadeMean,
    heavyMean,
    latencyDeltaPct,
    latencyWin: latencyDeltaPct > tolerancePct,
    gateCorrect: gateViolations.length === 0,
    escalationRate: escalationRate(perQuery),
    gateViolations: gateViolations.map((q) => q.prompt)
  };
}
