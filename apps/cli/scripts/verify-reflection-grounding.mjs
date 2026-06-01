/**
 * LIVE battery for RGV extended to the REFLECTION surface (slice 4) on LOCAL
 * Qwen. The reflection synthesiser already drops insights that cite invented
 * ids; this proves the SUBTLER honesty gate the id-check can't see — a
 * confabulated insight that cites REAL but unrelated episodes. A one-shot Qwen
 * judge re-checks each insight against the TEXT of its cited sources and drops
 * the unsupported one, keeping the genuinely-grounded one.
 *
 *   node apps/cli/scripts/verify-reflection-grounding.mjs        (ollama/qwen3:8b)
 *
 * Exit 0 if every case passes; skip (exit 0) if Ollama is unreachable.
 * LOCAL OLLAMA QWEN ONLY.
 */
import {
  buildGroundingReverifyPrompt,
  parseGroundingReverifyVerdict,
  REVERIFY_SYSTEM_PROMPT,
  verifyReflectionsGrounding
} from "@muse/agent-core";
import { createMuseRuntimeAssembly } from "@muse/autoconfigure";

const model = process.argv[2] ?? "ollama/qwen3:8b";
if (!model.startsWith("ollama/")) { console.error("LOCAL OLLAMA QWEN ONLY"); process.exit(2); }
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
  console.log(`verify-reflection-grounding skipped — local Ollama not reachable at ${baseUrl}. A skip is not a pass.`);
  process.exit(0);
}

process.env.MUSE_DEFAULT_MODEL = model;
const modelProvider = createMuseRuntimeAssembly().modelProvider;

const reverify = async ({ answer, evidence, query }) => {
  const judged = await modelProvider.generate({
    maxOutputTokens: 8,
    messages: [
      { content: REVERIFY_SYSTEM_PROMPT, role: "system" },
      { content: buildGroundingReverifyPrompt({ answer, evidence, query }), role: "user" }
    ],
    model,
    temperature: 0
  });
  return parseGroundingReverifyVerdict(judged.output ?? "");
};

const sources = new Map([
  ["ep-1", "Left work at 4pm to make the kids' school recital."],
  ["ep-2", "Declined the Saturday on-call shift to keep the weekend free for family."]
]);

const supported = { insight: "Tends to protect family and personal time over work demands", sourceIds: ["ep-1", "ep-2"], supportCount: 2 };
const confabulated = { insight: "Is training for a competitive marathon", sourceIds: ["ep-1", "ep-2"], supportCount: 2 };

const kept = await verifyReflectionsGrounding([supported, confabulated], sources, reverify);
const insights = kept.map((r) => r.insight);

const keptSupported = insights.includes(supported.insight);
const droppedConfab = !insights.includes(confabulated.insight);

console.log(`${keptSupported ? "PASS" : "FAIL"} — grounded insight kept: "${supported.insight}"`);
console.log(`${droppedConfab ? "PASS" : "FAIL"} — confabulated insight dropped (cited real but unrelated sources)`);

const ok = keptSupported && droppedConfab;
console.log(ok ? `\nALL PASS (2) on ${model}` : `\nFAILED on ${model} — kept: [${insights.join(", ")}]`);
process.exit(ok ? 0 : 1);
