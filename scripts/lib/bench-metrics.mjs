/**
 * Pure latency/throughput metrics for the local-model speed bench.
 *
 * No I/O — deterministic functions over recorded samples so the bench's
 * scoring + regression-guard logic is unit-testable without Ollama.
 * The live runner (`scripts/bench-local.mjs`) feeds these the raw
 * Ollama `/api/generate` timing object; future speed slices reuse
 * `detectRegression` as the bench's regression gate.
 */

const NS_PER_MS = 1e6;

export function nsToMs(ns) {
  const n = Number(ns);
  return Number.isFinite(n) && n > 0 ? n / NS_PER_MS : 0;
}

export function tokensPerSecond(tokens, durationMs) {
  const t = Number(tokens);
  const ms = Number(durationMs);
  if (!Number.isFinite(t) || !Number.isFinite(ms) || t <= 0 || ms <= 0) return 0;
  return t / (ms / 1000);
}

/**
 * Normalize one Ollama native `/api/generate` (stream:false) response's
 * server-authoritative timing fields (nanoseconds) into one sample.
 * TTFT is `load + prompt_eval` — the user-felt time before the first
 * generated token.
 */
export function sampleFromOllamaTimings(resp) {
  const loadMs = nsToMs(resp?.load_duration);
  const promptEvalMs = nsToMs(resp?.prompt_eval_duration);
  const genMs = nsToMs(resp?.eval_duration);
  const totalMs = nsToMs(resp?.total_duration);
  const promptTokens = Number(resp?.prompt_eval_count) || 0;
  const genTokens = Number(resp?.eval_count) || 0;
  return {
    loadMs,
    promptEvalMs,
    genMs,
    totalMs,
    ttftMs: loadMs + promptEvalMs,
    promptTokens,
    genTokens,
    promptTps: tokensPerSecond(promptTokens, promptEvalMs),
    genTps: tokensPerSecond(genTokens, genMs)
  };
}

export function percentile(values, p) {
  const nums = values
    .filter((v) => typeof v === "number" && Number.isFinite(v))
    .slice()
    .sort((a, b) => a - b);
  if (nums.length === 0) return 0;
  if (nums.length === 1) return nums[0];
  const rank = (p / 100) * (nums.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return nums[lo];
  return nums[lo] + (nums[hi] - nums[lo]) * (rank - lo);
}

export function mean(values) {
  const nums = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

/**
 * Reduce N samples to latency percentiles + throughput stats. Throwing
 * on an empty set is deliberate: a "summary" of zero runs is a bug in
 * the caller, not a 0-valued result to silently propagate.
 */
export function summarizeSamples(samples) {
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new Error("summarizeSamples requires at least one sample");
  }
  const ttft = samples.map((s) => s.ttftMs);
  const total = samples.map((s) => s.totalMs);
  const genTps = samples.map((s) => s.genTps);
  const promptTps = samples.map((s) => s.promptTps);
  return {
    runs: samples.length,
    ttftMs: { p50: percentile(ttft, 50), p95: percentile(ttft, 95), min: Math.min(...ttft), max: Math.max(...ttft) },
    totalMs: { p50: percentile(total, 50), p95: percentile(total, 95), min: Math.min(...total), max: Math.max(...total) },
    genTps: { mean: mean(genTps), p50: percentile(genTps, 50), min: Math.min(...genTps) },
    promptTps: { mean: mean(promptTps), p50: percentile(promptTps, 50), min: Math.min(...promptTps) }
  };
}

/**
 * Regression guard: `current` is a regression vs `baseline` when median
 * throughput drops, or p95 latency rises, by more than `tolerancePct`.
 * A FAIL names the concrete metric + magnitude (never a vague "slower").
 */
export function detectRegression(baseline, current, tolerancePct = 15) {
  const tol = tolerancePct / 100;
  const reasons = [];

  const drop = (base, cur) => (base > 0 ? (base - cur) / base : 0);
  const rise = (base, cur) => (base > 0 ? (cur - base) / base : 0);

  const genDrop = drop(baseline.genTps.p50, current.genTps.p50);
  if (genDrop > tol) {
    reasons.push(
      `gen throughput p50 dropped ${(genDrop * 100).toFixed(1)}% ` +
        `(${baseline.genTps.p50.toFixed(1)}→${current.genTps.p50.toFixed(1)} tok/s, tol ${tolerancePct}%)`
    );
  }

  const promptDrop = drop(baseline.promptTps.p50, current.promptTps.p50);
  if (promptDrop > tol) {
    reasons.push(
      `prompt-eval throughput p50 dropped ${(promptDrop * 100).toFixed(1)}% ` +
        `(${baseline.promptTps.p50.toFixed(1)}→${current.promptTps.p50.toFixed(1)} tok/s, tol ${tolerancePct}%)`
    );
  }

  const ttftRise = rise(baseline.ttftMs.p95, current.ttftMs.p95);
  if (ttftRise > tol) {
    reasons.push(
      `TTFT p95 rose ${(ttftRise * 100).toFixed(1)}% ` +
        `(${baseline.ttftMs.p95.toFixed(0)}→${current.ttftMs.p95.toFixed(0)} ms, tol ${tolerancePct}%)`
    );
  }

  return { regressed: reasons.length > 0, reasons, tolerancePct };
}
