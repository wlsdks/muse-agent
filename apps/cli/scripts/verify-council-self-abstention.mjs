/**
 * LIVE battery for COUNCIL SELF-ABSTENTION on LOCAL qwen3:8b + nomic-embed-text.
 * Extends the fabrication=0 grounding invariant to a FIFTH surface (the peer
 * DRAFT) at the COLONY level: a council member grounds its OWN take against its
 * OWN corpus and ABSTAINS when it has no confident evidence for the question, so
 * an ignorant peer stays silent instead of injecting a confident-but-ungrounded
 * opinion the synthesiser might fold in.
 *
 * Proves on the real local model + real embeddings:
 *   - ABSTAIN: a member whose corpus has no confident evidence for the question
 *     produces empty reasoning (abstains).
 *   - CONTROL/SELECTIVITY: a member WITH confident corpus evidence does NOT
 *     abstain and DOES produce reasoning — the gate is selective, not blanket
 *     silence (the over-abstention tripwire).
 *   - EXCLUSION: in a council, the abstainer is absent from the synthesised
 *     answer's contributors while the knowledgeable member is present.
 *
 *   node apps/cli/scripts/verify-council-self-abstention.mjs   (qwen3:8b)
 *
 * Exit 0 if every case passes; skip (exit 0) if Ollama is unreachable. LOCAL
 * OLLAMA QWEN ONLY.
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createMuseRuntimeAssembly } from "@muse/autoconfigure";
import {
  classifyRetrievalConfidence,
  produceGroundedCouncilReasoning,
  synthesizeCouncilAnswer
} from "@muse/agent-core";

const model = process.argv[2] ?? "ollama/gemma4:12b";
if (!model.startsWith("ollama/")) { console.error("LOCAL OLLAMA ONLY"); process.exit(2); }
const baseUrl = (process.env.OLLAMA_BASE_URL ?? "http://localhost:11434").replace(/\/$/, "");
const EMBED_MODEL = "nomic-embed-text";

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
  console.log(`verify-council-self-abstention skipped — local Ollama not reachable at ${baseUrl}. A skip is not a pass.`);
  process.exit(0);
}

async function embed(text) {
  const r = await fetch(`${baseUrl}/api/embeddings`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, prompt: text })
  });
  return (await r.json()).embedding;
}
function cosine(a, b) { let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return d / (Math.sqrt(na) * Math.sqrt(nb)); }

// The member's private corpus (its own notes) — never crosses the wire.
const corpus = [
  "The office VPN uses an MTU of 1380 for stability on the satellite uplink.",
  "Project Apollo's hard deadline is March 15; Maria is the lead engineer.",
  "Our AWS production region is eu-central-1 (Frankfurt)."
];
const corpusVecs = await Promise.all(corpus.map(embed));
async function matchesFor(question) {
  const qv = await embed(question);
  return corpus
    .map((text, i) => { const c = cosine(qv, corpusVecs[i]); return { source: `notes/n${i}.md`, text, cosine: c, score: c }; })
    .sort((a, b) => b.cosine - a.cosine);
}

process.env.HOME = mkdtempSync(path.join(os.tmpdir(), "muse-council-abstain-"));
process.env.MUSE_DEFAULT_MODEL = model;
const modelProvider = createMuseRuntimeAssembly().modelProvider;

let failures = 0;
const fail = (m) => { console.log(`FAIL — ${m}`); failures += 1; };
const pass = (m) => console.log(`PASS — ${m}`);

const inCorpusQ = "What MTU should the office VPN use?";
const offCorpusQ = "What is the best recipe for a sourdough bread starter?";

const inMatches = await matchesFor(inCorpusQ);
const offMatches = await matchesFor(offCorpusQ);
console.log(`retrieval: in-corpus top cosine ${inMatches[0].cosine.toFixed(3)} (${classifyRetrievalConfidence(inMatches)}), off-corpus top ${offMatches[0].cosine.toFixed(3)} (${classifyRetrievalConfidence(offMatches)})`);

// CONTROL — a member with confident corpus evidence speaks (selectivity tripwire).
const spoke = await produceGroundedCouncilReasoning(inCorpusQ, inMatches, { model, modelProvider });
spoke.trim().length > 0
  ? pass(`knowledgeable member SPOKE on an in-corpus question: "${spoke.slice(0, 70)}…"`)
  : fail("knowledgeable member wrongly ABSTAINED on an in-corpus question (over-abstention — the gate is too strict)");

// ABSTAIN — a member with no confident corpus evidence stays silent.
const abstained = await produceGroundedCouncilReasoning(offCorpusQ, offMatches, { model, modelProvider });
abstained.trim().length === 0
  ? pass("ignorant member ABSTAINED on an off-corpus question (no confident evidence)")
  : fail(`ignorant member spoke despite no confident corpus: "${abstained.slice(0, 70)}…"`);

// EXCLUSION — in a council on the in-corpus question, the abstainer is absent
// from the synthesised contributors; the knowledgeable member is present.
const aliceReasoning = await produceGroundedCouncilReasoning(inCorpusQ, inMatches, { model, modelProvider });
const bobReasoning = await produceGroundedCouncilReasoning(inCorpusQ, offMatches, { model, modelProvider }); // bob lacks corpus → abstains
const utterances = [
  ...(aliceReasoning.trim() ? [{ peerId: "alice", reasoning: aliceReasoning }] : []),
  ...(bobReasoning.trim() ? [{ peerId: "bob", reasoning: bobReasoning }] : [])
];
if (!utterances.some((u) => u.peerId === "alice")) {
  fail("alice (knowledgeable) abstained — can't test exclusion");
} else if (utterances.some((u) => u.peerId === "bob")) {
  fail("bob (ignorant) did NOT abstain — exclusion premise broken");
} else {
  const answer = await synthesizeCouncilAnswer(inCorpusQ, utterances, { model, modelProvider });
  if (!answer) {
    fail("synthesis returned null");
  } else if (answer.contributors.includes("bob")) {
    fail(`synthesis credited the abstainer bob: ${JSON.stringify(answer.contributors)}`);
  } else if (!answer.contributors.includes("alice")) {
    fail(`synthesis dropped the only contributing member alice: ${JSON.stringify(answer.contributors)}`);
  } else {
    pass(`council synthesised only from the grounded member: contributors ${JSON.stringify(answer.contributors)} (bob abstained, excluded)`);
  }
}

console.log(failures === 0 ? `\nALL PASS on ${model}` : `\n${failures} FAILED on ${model}`);
process.exit(failures === 0 ? 0 : 1);
