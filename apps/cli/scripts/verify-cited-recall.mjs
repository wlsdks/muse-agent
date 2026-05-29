/**
 * LIVE battery for Muse's WEDGE — confidence-gated CITED RECALL — on LOCAL
 * Ollama embeddings (nomic-embed-text). This proves the identity's core claim
 * ("answers from your own notes with the source quoted; says 'I'm not sure'
 * instead of making things up") on the DETERMINISTIC half that makes it
 * trustworthy: the confidence gate decides, the model never does.
 *
 * Drives the real path (rankKnowledgeChunks → classifyRetrievalConfidence →
 * renderKnowledgeMatches) against a tiny personal corpus with REAL local
 * embeddings — NOT the smoke:live API server (which stalls on this PC):
 *   - IN-CORPUS query  → "confident" → "cite the [source]" + the right source.
 *   - OUT-OF-CORPUS query → "ambiguous"/"none" → the LOW-confidence / no-match
 *     banner (the REFUSAL), NEVER dressed up as a citable fact.
 *
 *   node apps/cli/scripts/verify-cited-recall.mjs        (nomic-embed-text)
 *
 * Exit 0 if every case passes; skip (exit 0) if Ollama / the embed model is
 * unreachable. LOCAL OLLAMA ONLY.
 */
import { createOllamaEmbedder } from "@muse/autoconfigure";
import { classifyRetrievalConfidence, rankKnowledgeChunks, renderKnowledgeMatches } from "@muse/agent-core";
import { ingestChatExport } from "../dist/chat-export-ingest.js";

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
  console.log(`verify-cited-recall skipped — local Ollama not reachable at ${baseUrl}. A skip is not a pass.`);
  process.exit(0);
}

const embed = createOllamaEmbedder(embedModel);
// Probe the embed model once; if it isn't pulled, skip rather than fail.
try {
  await embed("probe");
} catch (cause) {
  console.log(`verify-cited-recall skipped — embed model '${embedModel}' unavailable (${cause instanceof Error ? cause.message : String(cause)}). Try: ollama pull ${embedModel}`);
  process.exit(0);
}

// A tiny PERSONAL corpus — the kind of stuff you'd never paste into ChatGPT.
const corpus = [
  { source: "policy-2025.pdf", text: "Home insurance policy 7741-A: annual premium 840,000 KRW, renewal date 2026-09-14, deductible 300,000 KRW." },
  { source: "meeting-q3.md", text: "Q3 launch sync: Jin owns the deck, Mina owns pricing. Decision: ship the beta on the 12th, no marketing push until the deck is reviewed." },
  { source: "doctor.md", text: "Dentist said the 6-month cleaning is due; rebook window opens the first week of June." }
];

// Pile-ingester reach: an exported Claude chat, run through the REAL ingester,
// becomes a corpus chunk — proving "ingested chat → citable recall" end-to-end.
const ingested = ingestChatExport([
  { name: "VPN setup", chat_messages: [
    { sender: "human", text: "how did I fix the office VPN handshake timeout?" },
    { sender: "assistant", text: "Set MTU to 1380 on the wg0 interface and restart wireguard — that cleared the handshake timeout." }
  ] }
]);
for (const conv of ingested) corpus.push({ source: `ingested/${conv.slug}.md`, text: conv.markdown });

const cases = [
  { name: "IN-CORPUS → confident, cite the source", kind: "confident", query: "when does my home insurance renew?", needles: ["cite the [source]", "policy-2025.pdf", "2026-09-14"] },
  { name: "IN-CORPUS → confident, distinct fact", kind: "confident", query: "who owns the launch deck?", needles: ["cite the [source]", "meeting-q3.md"] },
  { name: "INGESTED chat → citable (pile-ingester reach)", kind: "confident", query: "how did I fix the VPN handshake timeout?", needles: ["cite the [source]", "ingested/vpn-setup.md", "MTU"] },
  { name: "OUT-OF-CORPUS → REFUSES (low-confidence or no-match, never confabulates)", kind: "refuse", query: "what is the boiling point of mercury in kelvin?" }
];

let failures = 0;
for (const c of cases) {
  const matches = await rankKnowledgeChunks(c.query, corpus, { diversify: true, embed, hybrid: true, topK: 3 });
  const verdict = classifyRetrievalConfidence(matches);
  const rendered = renderKnowledgeMatches(matches);
  let ok;
  if (c.kind === "confident") {
    ok = verdict === "confident" && c.needles.every((n) => rendered.includes(n));
  } else {
    // The refusal: NOT presented as a citable fact. Either "none" (no match) or
    // "ambiguous" (low-confidence banner) — but never the confident "cite" header.
    ok = verdict !== "confident" && !rendered.includes("cite the [source]")
      && (rendered.includes("No matching passages") || rendered.includes("LOW confidence"));
  }
  const topCos = matches.length ? Math.max(...matches.map((m) => m.cosine ?? m.score)).toFixed(3) : "—";
  console.log(`${ok ? "PASS" : "FAIL"} — ${c.name}\n   verdict=${verdict} topCosine=${topCos}\n   ${rendered.split("\n")[0]}`);
  if (!ok) failures += 1;
}

console.log(failures === 0 ? `\nALL PASS (${cases.length}) on ${embedModel}` : `\n${failures}/${cases.length} FAILED on ${embedModel}`);
process.exit(failures === 0 ? 0 : 1);
