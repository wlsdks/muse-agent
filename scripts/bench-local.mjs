#!/usr/bin/env node
/**
 * bench:local — repeatable latency/throughput measurement for the local
 * model, the regression substrate for speed/efficiency slices.
 *
 * Hits Ollama's NATIVE `/api/generate` (stream:false) so the timing is
 * server-authoritative (no client/network jitter) and includes
 * prompt-eval throughput — the dominant cost on long-prompt paths.
 * Pure scoring + regression logic lives in `lib/bench-metrics.mjs`
 * (unit-tested without Ollama via `pnpm self-eval:test`).
 *
 *   pnpm bench:local                      # measure, print summary
 *   pnpm bench:local -- --write-baseline  # persist a local baseline
 *   MUSE_BENCH_BASELINE=<path> pnpm bench:local   # gate vs a baseline
 *
 * Env: OLLAMA_BASE_URL, MUSE_EVAL_MODEL (default gemma4:12b),
 *      MUSE_BENCH_REPEAT (3), MUSE_BENCH_TOLERANCE (15),
 *      MUSE_BENCH_NUM_PREDICT (128).
 *
 * LOCAL OLLAMA ONLY by policy. Exits 0 with "skipped" when Ollama is
 * unreachable — a skip is NOT a pass, fix the env to get the round-trip.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { detectRegression, sampleFromOllamaTimings, summarizeSamples } from "./lib/bench-metrics.mjs";

const OLLAMA_BASE = (process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434").replace(/\/+$/, "");
const MODEL = process.env.MUSE_EVAL_MODEL ?? "gemma4:12b";
const REPEAT = Math.max(1, Number(process.env.MUSE_BENCH_REPEAT ?? 3));
const TOLERANCE = Number(process.env.MUSE_BENCH_TOLERANCE ?? 15);
const NUM_PREDICT = Math.max(16, Number(process.env.MUSE_BENCH_NUM_PREDICT ?? 128));
const BASELINE_PATH = process.env.MUSE_BENCH_BASELINE ?? "docs/benchmarks/bench-local-baseline.json";
const WRITE_BASELINE = process.argv.includes("--write-baseline");

const PROMPT = "Summarize the benefits of a local-first AI assistant in exactly three sentences.";

async function reachable() {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function oneRun() {
  const res = await fetch(`${OLLAMA_BASE}/api/generate`, {
    body: JSON.stringify({
      model: MODEL,
      options: { num_predict: NUM_PREDICT, temperature: 0 },
      prompt: PROMPT,
      stream: false
    }),
    headers: { "content-type": "application/json" },
    method: "POST"
  });
  if (!res.ok) throw new Error(`ollama /api/generate ${res.status}`);
  return sampleFromOllamaTimings(await res.json());
}

if (!(await reachable())) {
  console.log(`bench:local skipped — local Ollama not reachable at ${OLLAMA_BASE} (a skip is not a pass; cloud APIs are never used).`);
  process.exit(0);
}

console.log(`bench:local — model=${MODEL} runs=${REPEAT} num_predict=${NUM_PREDICT} ollama=${OLLAMA_BASE}`);

// One warm-up (pays the model-load tax) then REPEAT measured runs.
await oneRun();
const samples = [];
for (let i = 0; i < REPEAT; i += 1) {
  samples.push(await oneRun());
  process.stdout.write(`  run ${i + 1}/${REPEAT}\r`);
}

const summary = summarizeSamples(samples);
summary.model = MODEL;
summary.numPredict = NUM_PREDICT;

console.log(`  TTFT p50=${summary.ttftMs.p50.toFixed(0)}ms p95=${summary.ttftMs.p95.toFixed(0)}ms`);
console.log(`  total p50=${summary.totalMs.p50.toFixed(0)}ms p95=${summary.totalMs.p95.toFixed(0)}ms`);
console.log(`  gen ${summary.genTps.mean.toFixed(1)} tok/s (p50 ${summary.genTps.p50.toFixed(1)})  prompt-eval ${summary.promptTps.mean.toFixed(1)} tok/s`);

if (WRITE_BASELINE || !existsSync(BASELINE_PATH)) {
  mkdirSync(dirname(BASELINE_PATH), { recursive: true });
  writeFileSync(BASELINE_PATH, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`  baseline ${WRITE_BASELINE ? "written" : "seeded"} → ${BASELINE_PATH} (machine-specific, gitignored)`);
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
const verdict = detectRegression(baseline, summary, TOLERANCE);
if (verdict.regressed) {
  console.error(`bench:local REGRESSION vs ${BASELINE_PATH}: ${verdict.reasons.join("; ")}`);
  process.exit(1);
}
console.log(`  no speed regression vs baseline (tol ${TOLERANCE}%).`);
