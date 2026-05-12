#!/usr/bin/env node
/**
 * Dogfood a local Ollama-served model end-to-end through Muse.
 *
 * Usage:
 *   node scripts/dogfood-local-llm.mjs <ollama-model>
 *
 * Example:
 *   node scripts/dogfood-local-llm.mjs qwen2.5:1.5b-instruct
 *   node scripts/dogfood-local-llm.mjs qwen2.5:7b-instruct
 *
 * What it measures:
 *   1. Raw Ollama probe — first-token latency + tokens/sec against the
 *      naked /v1/chat/completions endpoint. Establishes the upper bound
 *      of what this machine can do with this model.
 *   2. Muse `/api/chat` probe — same prompt routed through Muse's
 *      OllamaProvider + agent runtime. Confirms the integration works
 *      and surfaces any adapter overhead.
 *   3. Korean quality — sends a Korean message, asserts a Korean
 *      response comes back (not just English fallback).
 *
 * Designed to be the single command a user runs to know "does this
 * local model give me a usable JARVIS surface on this hardware?"
 */

import { performance } from "node:perf_hooks";

const ROOT = new URL("../", import.meta.url);

const model = (process.argv[2] ?? "").trim();
if (!model) {
  console.error("usage: dogfood-local-llm <ollama-model> (e.g. qwen2.5:7b-instruct)");
  process.exit(2);
}

const OLLAMA_URL = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";

// ── 0. Sanity: Ollama running + model present ───────────────────────
async function ensureModel() {
  let tags;
  try {
    const resp = await fetch(`${OLLAMA_URL}/api/tags`);
    tags = await resp.json();
  } catch (cause) {
    console.error(`Ollama not reachable at ${OLLAMA_URL}. Start it with 'ollama serve'.`);
    process.exit(2);
  }
  const names = (tags.models ?? []).map((m) => m.name);
  if (!names.includes(model)) {
    console.error(`Model '${model}' not pulled. Run: ollama pull ${model}`);
    console.error(`Installed: ${names.join(", ") || "(none)"}`);
    process.exit(2);
  }
}

await ensureModel();
console.log(`dogfood:local — model=${model} ollama=${OLLAMA_URL}`);

// ── 1. Raw Ollama probe ─────────────────────────────────────────────
async function rawOllamaProbe(prompt) {
  const body = {
    messages: [{ content: prompt, role: "user" }],
    model,
    stream: true
  };
  const start = performance.now();
  let firstTokenAt;
  let tokens = 0;
  let text = "";
  const resp = await fetch(`${OLLAMA_URL}/v1/chat/completions`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST"
  });
  if (!resp.body) throw new Error("no stream body");
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    for (;;) {
      const i = buf.indexOf("\n");
      if (i === -1) break;
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const ev = JSON.parse(payload);
        const delta = ev.choices?.[0]?.delta?.content;
        if (delta) {
          if (firstTokenAt === undefined) firstTokenAt = performance.now();
          tokens += 1;
          text += delta;
        }
      } catch { /* swallow */ }
    }
  }
  const totalMs = performance.now() - start;
  const firstMs = firstTokenAt ? firstTokenAt - start : totalMs;
  const genMs = totalMs - firstMs;
  const tps = genMs > 0 ? (tokens / (genMs / 1000)) : 0;
  return { firstMs, genMs, text, tokens, totalMs, tps };
}

console.log("  probe 1: raw Ollama /v1/chat/completions");
const koMsg = "안녕! 너 어떤 모델이야? 두 문장으로 짧게 한국어로 답해줘.";
const raw = await rawOllamaProbe(koMsg);
console.log(`    first-token: ${raw.firstMs.toFixed(0)}ms, total: ${raw.totalMs.toFixed(0)}ms`);
console.log(`    ~${raw.tps.toFixed(1)} tok/s, ${raw.tokens} chunks`);
console.log(`    reply: ${raw.text.slice(0, 160).replace(/\n/g, " ")}${raw.text.length > 160 ? "..." : ""}`);

// Korean-character heuristic: at least one Hangul codepoint in reply.
const hangul = /[가-힯]/;
const koOk = hangul.test(raw.text);
if (!koOk) {
  console.error(`    WARN — reply has no Hangul; model may have ignored language directive.`);
}

// ── 2. Muse /api/chat integration probe ─────────────────────────────
console.log("  probe 2: Muse /api/chat (OllamaProvider integration)");

process.env.MUSE_MODEL = `ollama/${model}`;
process.env.MUSE_MODEL_PROVIDER_ID = "ollama";

const { buildServer } = await import(new URL("./apps/api/dist/server.js", ROOT).href);
const { createApiServerOptions } = await import(new URL("./packages/autoconfigure/dist/index.js", ROOT).href);

const options = createApiServerOptions();
if (!options.agentRuntime) {
  console.error("FAIL — agentRuntime not configured (model resolution failed). Check MUSE_MODEL env.");
  process.exit(1);
}
const server = buildServer(options);

const museStart = performance.now();
const chatResponse = await server.inject({
  body: JSON.stringify({
    message: "한 문장으로 답해줘. 1 + 1은 몇이야?",
    metadata: { sessionId: `dogfood-local-${Date.now()}`, userId: "dogfood-local-llm" }
  }),
  headers: { "content-type": "application/json" },
  method: "POST",
  url: "/api/chat"
});
const museMs = performance.now() - museStart;

await server.close();

let museOk = chatResponse.statusCode === 200;
let museBody;
try {
  museBody = chatResponse.json();
} catch {
  museBody = null;
}

if (!museOk || !museBody?.success) {
  console.error(`    FAIL /api/chat — status=${chatResponse.statusCode} body=${JSON.stringify(museBody)?.slice(0, 200)}`);
  process.exit(1);
}

const museText = museBody.content ?? "";
console.log(`    /api/chat ok in ${museMs.toFixed(0)}ms`);
console.log(`    reply: ${museText.slice(0, 160).replace(/\n/g, " ")}${museText.length > 160 ? "..." : ""}`);

const has2 = /2|두|이/.test(museText);
if (!has2) {
  console.error(`    WARN — reply doesn't contain '2' for "1+1?". Model output quality is borderline.`);
}

// ── 3. Verdict ──────────────────────────────────────────────────────
console.log("---");
const verdict = {
  firstTokenMs: Math.round(raw.firstMs),
  koreanReplyOk: koOk,
  museApiOk: museOk && museBody?.success === true,
  museRoundtripMs: Math.round(museMs),
  rawTokensPerSec: Number(raw.tps.toFixed(1))
};
console.log(`VERDICT for ${model}:`);
for (const [k, v] of Object.entries(verdict)) {
  console.log(`  ${k}: ${v}`);
}

// Tier classification (rough heuristic for the setup-local guide):
//   first-token <500ms + tps > 30 + ko_ok + muse_ok → "JARVIS-fit"
//   first-token <1500ms + tps > 15 + muse_ok       → "usable"
//   else                                            → "needs more hardware"
const tier =
  verdict.firstTokenMs < 500 && verdict.rawTokensPerSec > 30 && verdict.koreanReplyOk && verdict.museApiOk
    ? "JARVIS-fit"
    : verdict.firstTokenMs < 1500 && verdict.rawTokensPerSec > 15 && verdict.museApiOk
      ? "usable"
      : "needs more hardware";
console.log(`  tier: ${tier}`);

console.log(`PASS  ${model} works through Muse end-to-end.`);
