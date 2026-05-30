/**
 * LIVE battery for COUNCIL deliberation on LOCAL qwen3:8b. Several Muses reason
 * about one question and synthesise an answer from their REASONING (not data),
 * with Muse's edge applied: the synthesis is GROUNDED in the members' reasoning
 * and cites which members it used — it can't invent a council member.
 *
 * Proves on the real local model:
 *   - a participant produces a bounded, non-empty reasoning utterance.
 *   - synthesising 3 members' reasoning yields an answer whose contributors are
 *     ALL real member ids (the grounding invariant), at least one, no invented id.
 *
 *   node apps/cli/scripts/verify-council.mjs   (qwen3:8b)
 *
 * Exit 0 if every case passes; skip (exit 0) if Ollama is unreachable. LOCAL
 * OLLAMA QWEN ONLY.
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createMuseRuntimeAssembly } from "@muse/autoconfigure";
import { produceCouncilReasoning, synthesizeCouncilAnswer } from "@muse/agent-core";

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
  console.log(`verify-council skipped — local Ollama not reachable at ${baseUrl}. A skip is not a pass.`);
  process.exit(0);
}

process.env.HOME = mkdtempSync(path.join(os.tmpdir(), "muse-council-"));
process.env.MUSE_DEFAULT_MODEL = model;
const modelProvider = createMuseRuntimeAssembly().modelProvider;

const question = "Should I rent or buy a home if I might move cities in 3 years?";

let failures = 0;
const fail = (m) => { console.log(`FAIL — ${m}`); failures += 1; };
const pass = (m) => console.log(`PASS — ${m}`);

// 1) A participant produces a bounded, non-empty reasoning utterance.
const reasoning = await produceCouncilReasoning(question, { model, modelProvider });
reasoning.trim().length > 0
  ? pass(`participant produced reasoning (${reasoning.length} chars): "${reasoning.slice(0, 70)}…"`)
  : fail("participant produced empty reasoning");

// 2) Synthesise 3 distinct members' reasoning → answer grounded in real members only.
const utterances = [
  { peerId: "phone", reasoning: "Buying builds equity, but a 3-year horizon rarely beats transaction + selling costs." },
  { peerId: "laptop", reasoning: "Renting keeps you flexible to move and avoids maintenance risk; invest the difference." },
  { peerId: "server", reasoning: "It depends on the local price-to-rent ratio; below ~15 buying can win even short term." }
];
const validIds = new Set(utterances.map((u) => u.peerId));
const answer = await synthesizeCouncilAnswer(question, utterances, { model, modelProvider });

if (!answer) {
  fail("synthesis returned null");
} else {
  const allReal = answer.contributors.length >= 1 && answer.contributors.every((c) => validIds.has(c));
  allReal
    ? pass(`synthesis grounded — contributors all real members: ${JSON.stringify(answer.contributors)}`)
    : fail(`synthesis cited an invented/empty contributor: ${JSON.stringify(answer.contributors)}`);
  answer.answer.trim().length > 0
    ? pass(`synthesised answer: "${answer.answer.slice(0, 80)}…"`)
    : fail("synthesised answer is empty");
}

// 3) SINGLE-member council → the contributor list must be exactly that one real
//    member; the synthesiser must NOT pad it with invented co-contributors to
//    look like a fuller council. STABLE 3/3.
const soloUtterances = [{ peerId: "phone", reasoning: "Renting keeps you flexible to move and avoids maintenance risk; invest the difference." }];
const soloAnswer = await synthesizeCouncilAnswer(question, soloUtterances, { model, modelProvider });
if (!soloAnswer) {
  fail("single-member synthesis returned null");
} else {
  soloAnswer.contributors.length >= 1 && soloAnswer.contributors.every((c) => c === "phone")
    ? pass(`single-member council credits only the real member: ${JSON.stringify(soloAnswer.contributors)}`)
    : fail(`single-member synthesis padded/invented a contributor: ${JSON.stringify(soloAnswer.contributors)}`);
}

console.log(failures === 0 ? `\nALL PASS on ${model}` : `\n${failures} FAILED on ${model}`);
process.exit(failures === 0 ? 0 : 1);
