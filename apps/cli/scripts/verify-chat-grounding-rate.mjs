/**
 * LIVE battery for the CONVERSATIONAL surface (`muse chat`) — faithfulness +
 * false-refusal RATES of the sync `gateChatAnswer` path over a held-out corpus,
 * on REAL local retrieval (nomic-embed-text). The desktop companion runs chat
 * exclusively, but the wedge battery (`verify-faithfulness-rate`) only exercises
 * the `muse ask` verify path; this proves chat's DETERMINISTIC number / email
 * value checks hold end-to-end against real embeddings and gates them against
 * regression. No judge — the chat gate is pure/sync by design.
 *
 *   node apps/cli/scripts/verify-chat-grounding-rate.mjs        (nomic-embed-text)
 *
 * Exit 0 if both rates clear their threshold; exit 1 on a regression; skip
 * (exit 0) when local Ollama / the embed model is unreachable. LOCAL OLLAMA ONLY.
 */
import { createOllamaEmbedder } from "@muse/autoconfigure";
import { CHAT_GROUNDING_EVAL_CORPUS, CHAT_GROUNDING_THRESHOLDS, runChatGroundingEval } from "../dist/chat-grounding-eval.js";
import { renderGroundingEvalReport } from "../dist/grounding-eval-runner.js";

const embedModel = process.argv[2] ?? "nomic-embed-text";
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
  console.log(`verify-chat-grounding-rate skipped — local Ollama not reachable at ${baseUrl}. A skip is not a pass.`);
  process.exit(0);
}

const embed = createOllamaEmbedder(embedModel);
try {
  await embed("probe");
} catch (cause) {
  console.log(`verify-chat-grounding-rate skipped — embed model '${embedModel}' unavailable (${cause instanceof Error ? cause.message : String(cause)}). Try: ollama pull ${embedModel}`);
  process.exit(0);
}

const result = await runChatGroundingEval(CHAT_GROUNDING_EVAL_CORPUS, { embed });
const report = renderGroundingEvalReport(result, CHAT_GROUNDING_THRESHOLDS);

console.log(report.text);
console.log(
  report.status === "ok"
    ? `\nPASS — chat gate faithfulness ${result.faithfulnessRate.toFixed(2)} >= ${CHAT_GROUNDING_THRESHOLDS.minFaithfulness}, false-refusal ${result.falseRefusalRate.toFixed(2)} <= ${CHAT_GROUNDING_THRESHOLDS.maxFalseRefusal}`
    : `\nFAIL — a chat-gate rate regressed below threshold`
);
process.exit(report.status === "ok" ? 0 : 1);
