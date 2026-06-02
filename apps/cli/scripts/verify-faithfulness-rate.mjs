/**
 * LIVE battery for Muse's SCORED edge — faithfulness + false-refusal RATES over
 * a bundled held-out corpus, on the REAL local stack (nomic-embed-text +
 * the RGV rubric + weak-band MaTTS judge on qwen3:8b). Turns the `fabrication=0`
 * release claim from a handful of anecdotes into two measured numbers the loop
 * can gate on (RAGAS-style faithfulness, arXiv:2309.15217; CRAG refusal
 * framing, arXiv:2401.15884).
 *
 *   - FAITHFULNESS  = of the answers the gate must NOT pass (out-of-corpus +
 *     unfaithful drift), the fraction it catches. Must be >= minFaithfulness.
 *   - FALSE-REFUSAL = of the in-corpus questions, the fraction the gate wrongly
 *     refuses. Must be <= maxFalseRefusal. (loop-v2's GUARD-THE-EDGE metric.)
 *
 *   node apps/cli/scripts/verify-faithfulness-rate.mjs        (nomic + ollama/qwen3:8b)
 *
 * Exit 0 if both rates clear their threshold; exit 1 on a regression; skip
 * (exit 0) when local Ollama / the embed model is unreachable. LOCAL OLLAMA ONLY.
 */
import { createMuseRuntimeAssembly, createOllamaEmbedder } from "@muse/autoconfigure";
import { GROUNDING_EVAL_CORPUS } from "../dist/grounding-eval-corpus.js";
import {
  createQwenReverify,
  GROUNDING_THRESHOLDS,
  renderGroundingEvalReport,
  runGroundingEval
} from "../dist/grounding-eval-runner.js";

const model = process.argv[2] ?? "ollama/qwen3:8b";
if (!model.startsWith("ollama/")) { console.error("LOCAL OLLAMA QWEN ONLY"); process.exit(2); }
const embedModel = process.argv[3] ?? "nomic-embed-text";
const baseUrl = (process.env.OLLAMA_BASE_URL ?? "http://localhost:11434").replace(/\/$/, "");

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
  console.log(`verify-faithfulness-rate skipped — local Ollama not reachable at ${baseUrl}. A skip is not a pass.`);
  process.exit(0);
}

const embed = createOllamaEmbedder(embedModel);
try {
  await embed("probe");
} catch (cause) {
  console.log(`verify-faithfulness-rate skipped — embed model '${embedModel}' unavailable (${cause instanceof Error ? cause.message : String(cause)}). Try: ollama pull ${embedModel}`);
  process.exit(0);
}

process.env.MUSE_DEFAULT_MODEL = model;
const modelProvider = createMuseRuntimeAssembly().modelProvider;
const reverify = createQwenReverify(modelProvider, model);

const result = await runGroundingEval(GROUNDING_EVAL_CORPUS, { embed, reverify });
const report = renderGroundingEvalReport(result, GROUNDING_THRESHOLDS);

console.log(report.text);
console.log(
  report.status === "ok"
    ? `\nPASS — faithfulness ${result.faithfulnessRate.toFixed(2)} >= ${GROUNDING_THRESHOLDS.minFaithfulness}, false-refusal ${result.falseRefusalRate.toFixed(2)} <= ${GROUNDING_THRESHOLDS.maxFalseRefusal} on ${model}`
    : `\nFAIL — a rate regressed below threshold on ${model}`
);
process.exit(report.status === "ok" ? 0 : 1);
