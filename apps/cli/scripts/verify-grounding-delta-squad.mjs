import { errorMessage } from "@muse/shared";
/**
 * eval:grounding-delta:squad — the architectural-delta benchmark on a PUBLIC dataset.
 *
 *   node apps/cli/scripts/verify-grounding-delta-squad.mjs   (nomic + ollama/gemma4:12b)
 *
 * Runs the SQuAD-2.0 slice (vendored, pinned at fixtures/squad-v2-slice.json) through the
 * real recall stack gate-ON vs gate-OFF and writes docs/benchmarks/RESULTS-squad.md. This
 * is the externally-citable companion to the self-authored eval:grounding-delta: the corpus
 * is a public dataset, the answers are DETERMINISTICALLY TEMPLATED from SQuAD spans (no model
 * generation → no maker=judge), and the Δ on the drift cases (a real answer span from another
 * paragraph, cited to the wrong one) is the gate's faithfulness contribution that a bigger
 * model cannot beat without the same gate.
 *
 * Exit 0 when Δ > 0 (the gate adds protection) and RESULTS-squad.md is written; exit 1 if the
 * gate earns nothing (Δ <= 0); skip (exit 0) when local Ollama / the embed model is
 * unreachable. LOCAL OLLAMA ONLY.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createMuseRuntimeAssembly, createOllamaEmbedder } from "@muse/autoconfigure";
import { buildSquadGroundingCorpus, createQwenReverify, renderGroundingDelta, runGroundingEval } from "../dist/grounding-eval-runner.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(here, "../../..");
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
  console.log(`eval:grounding-delta:squad skipped — local Ollama not reachable at ${baseUrl}. A skip is not a pass.`);
  process.exit(0);
}

const embed = createOllamaEmbedder(embedModel);
try {
  await embed("probe");
} catch (cause) {
  console.log(`eval:grounding-delta:squad skipped — embed model '${embedModel}' unavailable (${errorMessage(cause)}).`);
  process.exit(0);
}

const slice = JSON.parse(readFileSync(path.join(here, "fixtures/squad-v2-slice.json"), "utf8"));
const corpus = buildSquadGroundingCorpus(slice);

process.env.MUSE_DEFAULT_MODEL = model;
const modelProvider = createMuseRuntimeAssembly().modelProvider;
const reverify = createQwenReverify(modelProvider, model);

const on = await runGroundingEval(corpus, { embed, gate: "on", reverify });
const off = await runGroundingEval(corpus, { embed, gate: "off", reverify });

const markdown = renderGroundingDelta(on, off, {
  at: nowIso,
  command: "pnpm eval:grounding-delta:squad",
  corpus: `SQuAD-2.0 dev slice (${slice.items.length} paragraphs, pinned ${path.relative(rootDir, path.join(here, "fixtures/squad-v2-slice.json"))}; templated answers, no model-generation) — drift Δ = answer-faithfulness on adversarial public inputs`,
  model
});

const outPath = path.join(rootDir, "docs/benchmarks/RESULTS-squad.md");
mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(outPath, markdown);

console.log(markdown);
const dFaith = on.faithfulnessRate - off.faithfulnessRate;
console.log(
  dFaith > 0
    ? `\nPASS — gate ON adds +${dFaith.toFixed(2)} faithfulness over gate OFF on the PUBLIC SQuAD slice (${model}); wrote ${path.relative(rootDir, outPath)}`
    : `\nFAIL — gate ON adds no faithfulness over gate OFF (Δ=${dFaith.toFixed(2)}) on the SQuAD slice (${model})`
);
process.exit(dFaith > 0 ? 0 : 1);

