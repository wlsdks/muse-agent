/**
 * eval:grounding-delta — the architectural-delta benchmark.
 *
 *   node apps/cli/scripts/verify-grounding-delta.mjs    (nomic + ollama/gemma4:12b)
 *
 * Runs the SAME corpus through the REAL recall stack TWICE — gate ON (Muse's
 * deterministic grounding gate) and gate OFF (the same retrieval, no verdict) —
 * and writes docs/benchmarks/RESULTS.md with the DELTA table. The Δ isolates the
 * gate's contribution from the model: a fixed ~12B local model cannot win an
 * absolute-faithfulness leaderboard (a 70B beats it), but it CAN show that its
 * deterministic gate lifts faithfulness by Δ on the same model — the one "best"
 * claim a fixed local model cannot be beaten on by swapping in a bigger model.
 *
 * The gate-OFF arm lives ONLY in the eval harness (a no-op verify injected into
 * runGroundingEval), never as a production bypass — the fail-closed seam keeps
 * no opt-out.
 *
 * Exit 0 when the Δ is positive (the gate demonstrably adds protection) and
 * RESULTS.md is written; exit 1 if the gate adds nothing (Δ <= 0 — a real
 * regression); skip (exit 0) when local Ollama / the embed model is unreachable.
 * LOCAL OLLAMA ONLY.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createMuseRuntimeAssembly, createOllamaEmbedder } from "@muse/autoconfigure";
import { GROUNDING_EVAL_CORPUS } from "../dist/grounding-eval-corpus.js";
import { createQwenReverify, renderGroundingDelta, runGroundingEval } from "../dist/grounding-eval-runner.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const model = process.argv[2] ?? "ollama/gemma4:12b";
if (!model.startsWith("ollama/")) { console.error("LOCAL OLLAMA ONLY"); process.exit(2); }
const embedModel = process.argv[3] ?? "nomic-embed-text";
const baseUrl = (process.env.OLLAMA_BASE_URL ?? "http://localhost:11434").replace(/\/$/, "");
const nowIso = process.env.MUSE_DELTA_AT ?? new Date().toISOString();

async function reachable() {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 3_000);
    const r = await fetch(`${baseUrl}/api/tags`, { signal: c.signal });
    clearTimeout(t);
    return r.ok;
  } catch { return false; }
}
if (!(await reachable())) {
  console.log(`eval:grounding-delta skipped — local Ollama not reachable at ${baseUrl}. A skip is not a pass.`);
  process.exit(0);
}

const embed = createOllamaEmbedder(embedModel);
try {
  await embed("probe");
} catch (cause) {
  console.log(`eval:grounding-delta skipped — embed model '${embedModel}' unavailable (${cause instanceof Error ? cause.message : String(cause)}). Try: ollama pull ${embedModel}`);
  process.exit(0);
}

process.env.MUSE_DEFAULT_MODEL = model;
const modelProvider = createMuseRuntimeAssembly().modelProvider;
const reverify = createQwenReverify(modelProvider, model);

const on = await runGroundingEval(GROUNDING_EVAL_CORPUS, { embed, gate: "on", reverify });
const off = await runGroundingEval(GROUNDING_EVAL_CORPUS, { embed, gate: "off", reverify });

const markdown = renderGroundingDelta(on, off, {
  at: nowIso,
  command: "pnpm eval:grounding-delta",
  corpus: "bundled grounding corpus (self-authored — a public-dataset arm is the next slice)",
  model
});

const outPath = path.join(rootDir, "docs/benchmarks/RESULTS.md");
mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(outPath, markdown);

console.log(markdown);
const dFaith = on.faithfulnessRate - off.faithfulnessRate;
console.log(
  dFaith > 0
    ? `\nPASS — gate ON adds +${dFaith.toFixed(2)} faithfulness over gate OFF on ${model}; wrote ${path.relative(rootDir, outPath)}`
    : `\nFAIL — gate ON adds no faithfulness over gate OFF (Δ=${dFaith.toFixed(2)}) on ${model} — the gate is not earning its place`
);
process.exit(dFaith > 0 ? 0 : 1);
