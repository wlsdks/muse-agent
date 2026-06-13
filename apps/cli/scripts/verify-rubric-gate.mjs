/**
 * LIVE battery for the RUBRIC-GATED grounding verifier (RGV) — the output-side
 * half of Muse's "shows its work" edge, run on REAL local embeddings. Where
 * verify-cited-recall proves the RETRIEVAL gate (confident vs refuse), this
 * proves the ANSWER gate: given the passages a query really retrieves,
 * `verifyGrounding` must classify a candidate answer as
 * grounded | weak | ungrounded — and a drifting, fabricated-citation, or
 * out-of-corpus answer must NEVER reach `grounded` (fabrication = 0 by code).
 *
 * Drives the real path (rankKnowledgeChunks → verifyGrounding) against a tiny
 * personal corpus with REAL nomic embeddings — NOT the smoke:live API server.
 *
 *   node apps/cli/scripts/verify-rubric-gate.mjs        (nomic-embed-text)
 *
 * Exit 0 if every case passes; skip (exit 0) if Ollama / the embed model is
 * unreachable. LOCAL OLLAMA ONLY.
 */
import { createOllamaEmbedder } from "@muse/autoconfigure";
import { rankKnowledgeChunks, verifyGrounding } from "@muse/agent-core";

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
  console.log(`verify-rubric-gate skipped — local Ollama not reachable at ${baseUrl}. A skip is not a pass.`);
  process.exit(0);
}

const embed = createOllamaEmbedder(embedModel);
try {
  await embed("probe");
} catch (cause) {
  console.log(`verify-rubric-gate skipped — embed model '${embedModel}' unavailable (${cause instanceof Error ? cause.message : String(cause)}). Try: ollama pull ${embedModel}`);
  process.exit(0);
}

const corpus = [
  { source: "policy-2025.pdf", text: "Home insurance policy 7741-A: annual premium 840,000 KRW, renewal date 2026-09-14, deductible 300,000 KRW." },
  { source: "meeting-q3.md", text: "Q3 launch sync: Jin owns the deck, Mina owns pricing. Decision: ship the beta on the 12th, no marketing push until the deck is reviewed." },
  { source: "doctor.md", text: "Dentist said the 6-month cleaning is due; rebook window opens the first week of June." }
];

const cases = [
  {
    name: "GROUNDED — answer paraphrases the retrieved source with a valid citation",
    query: "when does my home insurance renew?",
    answer: "Your home insurance policy 7741-A renews on 2026-09-14 [from policy-2025.pdf].",
    expect: "grounded"
  },
  {
    name: "UNGROUNDED (drift) — confident retrieval but the answer asserts a fact the evidence lacks",
    query: "when does my home insurance renew?",
    answer: "Mercury boils at 630 kelvin and the deck ships on the 12th.",
    expect: "ungrounded"
  },
  {
    name: "UNGROUNDED (fabricated citation) — answer cites a source that was not retrieved",
    query: "when does my home insurance renew?",
    answer: "Your insurance renews 2026-09-14 [from secret-vault.md].",
    expect: "ungrounded"
  },
  {
    name: "NEVER GROUNDED — out-of-corpus query, any asserted answer stays below grounded",
    query: "what is the boiling point of mercury in kelvin?",
    answer: "Mercury boils at about 630 kelvin.",
    expectNot: "grounded"
  }
];

let failures = 0;
for (const c of cases) {
  const matches = await rankKnowledgeChunks(c.query, corpus, { diversify: true, embed, hybrid: true, topK: 3 });
  const v = verifyGrounding(c.answer, matches, c.query);
  const ok = c.expect ? v.verdict === c.expect : v.verdict !== c.expectNot;
  const topCos = matches.length ? Math.max(...matches.map((m) => m.cosine ?? m.score)).toFixed(3) : "—";
  console.log(
    `${ok ? "PASS" : "FAIL"} — ${c.name}\n   verdict=${v.verdict} (${v.reason}) topCosine=${topCos} ` +
      `coverage=${v.rubric.coverage.toFixed(2)} answerability=${v.rubric.answerability.toFixed(2)} citationValidity=${v.rubric.citationValidity.toFixed(2)}` +
      (v.invalidCitations.length ? ` invalid=[${v.invalidCitations.join(", ")}]` : "")
  );
  if (!ok) failures += 1;
}

console.log(failures === 0 ? `\nALL PASS (${cases.length}) on ${embedModel}` : `\n${failures}/${cases.length} FAILED on ${embedModel}`);
process.exit(failures === 0 ? 0 : 1);
