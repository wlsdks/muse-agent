/**
 * LIVE battery for RGV extended to the COUNCIL surface (slice 5) on LOCAL Qwen.
 * parseCouncilAnswer drops contributor ids the council didn't include; this
 * proves the subtler honesty gate that can't see — a synthesis that drifts into
 * a "consensus" none of the members actually reasoned. A one-shot Qwen judge
 * re-checks the synthesis against the members' reasoning TEXT and drops the
 * unsupported one, keeping the faithful one.
 *
 *   node apps/cli/scripts/verify-council-grounding.mjs        (ollama/qwen3:8b)
 *
 * Exit 0 if every case passes; skip (exit 0) if Ollama is unreachable.
 * LOCAL OLLAMA QWEN ONLY.
 */
import {
  buildGroundingReverifyPrompt,
  parseGroundingReverifyVerdict,
  REVERIFY_SYSTEM_PROMPT,
  verifyCouncilGrounding
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
  console.log(`verify-council-grounding skipped — local Ollama not reachable at ${baseUrl}. A skip is not a pass.`);
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

const question = "How should we launch the new feature?";
const utterances = [
  { peerId: "phone", reasoning: "Prefer a phased rollout: ship to 10% of users first and watch error rates before going wider." },
  { peerId: "laptop", reasoning: "Agree — stage it behind a feature flag and only flip to everyone once metrics look clean." }
];

const faithful = { answer: "Launch gradually behind a feature flag, starting around 10% and widening as metrics stay clean.", contributors: ["phone", "laptop"] };
const confabulated = { answer: "Cancel the launch entirely and issue refunds to all existing customers.", contributors: ["phone", "laptop"] };

const keptFaithful = await verifyCouncilGrounding(faithful, question, utterances, reverify);
const keptConfab = await verifyCouncilGrounding(confabulated, question, utterances, reverify);

const okFaithful = keptFaithful !== null;
const okConfab = keptConfab === null;
console.log(`${okFaithful ? "PASS" : "FAIL"} — faithful synthesis kept`);
console.log(`${okConfab ? "PASS" : "FAIL"} — confabulated "consensus" dropped (no member reasoned it)`);

const ok = okFaithful && okConfab;
console.log(ok ? `\nALL PASS (2) on ${model}` : `\nFAILED on ${model}`);
process.exit(ok ? 0 : 1);
