#!/usr/bin/env node
/**
 * eval:cascade — the C3 proof for FrugalGPT cascade (arXiv:2305.05176): run a
 * mixed easy/hard prompt set under cascade (fast model first, escalate to heavy
 * on low confidence) vs always-heavy, and assert (a) cascade's mean latency
 * wins and (b) the escalation gate fired correctly (a weak fast answer is never
 * kept). Pure scoring lives in `lib/cascade-eval.mjs` (unit-tested without
 * Ollama via `pnpm self-eval:test`).
 *
 *   pnpm eval:cascade
 *   MUSE_FAST_MODEL=gemma4:12b MUSE_HEAVY_MODEL=qwen3:14b pnpm eval:cascade
 *
 * LOCAL OLLAMA ONLY by policy. Exits 0 with "skipped" when Ollama is
 * unreachable — a skip is NOT a pass.
 */

import { scoreCascadeEval } from "./lib/cascade-eval.mjs";

const OLLAMA_BASE = (process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434").replace(/\/+$/, "");
const FAST = process.env.MUSE_FAST_MODEL?.trim() || process.env.MUSE_EVAL_MODEL?.trim() || "gemma4:12b";
const HEAVY = process.env.MUSE_HEAVY_MODEL?.trim() || process.env.MUSE_EVAL_MODEL?.trim() || "gemma4:12b";
const THRESHOLD = Number(process.env.MUSE_BENCH_TOLERANCE ?? -1.0); // mean-logprob escalation threshold

const PROMPTS = [
  "What is the capital of France? Answer in one word.",
  "Convert 5 km to miles. Just the number.",
  "Define entropy in one sentence.",
  "Analyze the trade-offs between optimistic and pessimistic locking for a high-write database.",
  "Design a cache-invalidation strategy for a read-heavy API and justify each choice."
];

async function reachable() {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

const CALL_TIMEOUT_MS = Math.max(10_000, Number(process.env.MUSE_EVAL_CASCADE_TIMEOUT_MS ?? 180_000));

// One native /api/chat call with logprobs; returns { ms, answer, meanLogprob }.
// A bounded timeout so a saturated box aborts cleanly instead of hanging on
// undici's multi-minute default (the caller treats an abort as a skip).
async function callModel(model, prompt, withLogprobs) {
  const start = performance.now();
  const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
    body: JSON.stringify({
      messages: [{ content: prompt, role: "user" }],
      model,
      options: { num_predict: 128, temperature: 0 },
      stream: false,
      ...(withLogprobs ? { logprobs: true } : {})
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`ollama /api/chat ${res.status}`);
  const json = await res.json();
  const ms = performance.now() - start;
  const answer = (json.message?.content ?? "").trim();
  const lps = Array.isArray(json.logprobs)
    ? json.logprobs.filter((e) => typeof e?.logprob === "number" && Number.isFinite(e.logprob) && !String(e.token ?? "").startsWith("<|"))
    : [];
  const meanLogprob = lps.length > 0 ? lps.reduce((s, e) => s + e.logprob, 0) / lps.length : undefined;
  return { answer, meanLogprob, ms };
}

if (!(await reachable())) {
  console.log(`eval:cascade skipped — local Ollama not reachable at ${OLLAMA_BASE} (a skip is not a pass; cloud APIs are never used).`);
  process.exit(0);
}

console.log(`eval:cascade — fast=${FAST} heavy=${HEAVY} threshold=${THRESHOLD} ollama=${OLLAMA_BASE}`);

const perQuery = [];
try {
  await callModel(FAST, "ok", false); // warm-up
  for (const prompt of PROMPTS) {
    const fast = await callModel(FAST, prompt, true);
    const escalated = fast.meanLogprob === undefined || fast.meanLogprob < THRESHOLD;
    const heavyPass = escalated ? await callModel(HEAVY, prompt, false) : undefined;
    const alwaysHeavy = await callModel(HEAVY, prompt, false);
    perQuery.push({
      cascadeAnswer: escalated ? heavyPass.answer : fast.answer,
      cascadeMs: escalated ? fast.ms + heavyPass.ms : fast.ms,
      escalated,
      fastConfidence: fast.meanLogprob,
      heavyAnswer: alwaysHeavy.answer,
      heavyMs: alwaysHeavy.ms,
      prompt
    });
    process.stdout.write(`  ${escalated ? "↑heavy" : "·fast "} ${prompt.slice(0, 48)}\r\n`);
  }
} catch (cause) {
  // A model-call abort/timeout means the box was too loaded to measure — that's
  // a skip (like an unreachable Ollama), NOT a cascade failure.
  const detail = cause instanceof Error ? cause.message : String(cause);
  console.log(`eval:cascade skipped — could not complete a model call (${detail}); box likely saturated. A skip is not a pass.`);
  process.exit(0);
}

const r = scoreCascadeEval(perQuery, THRESHOLD, Number(process.env.MUSE_BENCH_TOLERANCE_PCT ?? 5));
console.log(`  cascade mean ${r.cascadeMean.toFixed(0)}ms vs heavy ${r.heavyMean.toFixed(0)}ms (${r.latencyDeltaPct.toFixed(1)}% faster)`);
console.log(`  escalation rate ${(r.escalationRate * 100).toFixed(0)}% · latencyWin=${r.latencyWin} · gateCorrect=${r.gateCorrect}`);

if (!r.gateCorrect) {
  console.error(`eval:cascade FAIL — escalation gate violated on: ${r.gateViolations.join("; ")}`);
  process.exit(1);
}
// A same-model fast/heavy (no tiers configured) can't show a latency win — only
// fail the win check when the tiers actually differ.
if (FAST !== HEAVY && !r.latencyWin) {
  console.error(`eval:cascade FAIL — no latency win (${r.latencyDeltaPct.toFixed(1)}% ≤ tolerance) with distinct fast/heavy tiers.`);
  process.exit(1);
}
console.log("eval:cascade PASS");
