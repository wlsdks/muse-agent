/**
 * LIVE battery for the recall WEDGE's OUTPUT-side grounding gate — the
 * code-not-model half of "shows its work". The model answers a query from a
 * tiny notes context; `enforceAnswerCitations` then strips any `[from <source>]`
 * the answer cites that ISN'T a note we actually showed it — so a fabricated
 * citation can never reach the user, BY CODE (the same discipline
 * `parseReflections` / `parseCouncilAnswer` give the reflection / council
 * surfaces).
 *
 * Asserts the invariant on REAL local-model output:
 *   1. every citation that SURVIVES the gate resolves to a real source;
 *   2. a fabricated `[from secrets/…]` citation injected into that real answer
 *      is deterministically stripped (and reported).
 *
 *   node apps/cli/scripts/verify-recall-citation-gate.mjs   (ollama/qwen3:8b)
 *
 * Exit 0 if every case passes; skip (exit 0) if Ollama is unreachable. LOCAL
 * OLLAMA QWEN ONLY.
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createMuseRuntimeAssembly } from "@muse/autoconfigure";
import { citedSourcesIn, enforceAnswerCitations } from "@muse/agent-core";

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
  console.log(`verify-recall-citation-gate skipped — local Ollama not reachable at ${baseUrl}. A skip is not a pass.`);
  process.exit(0);
}

process.env.HOME = mkdtempSync(path.join(os.tmpdir(), "muse-recall-gate-"));
process.env.MUSE_DEFAULT_MODEL = model;
const modelProvider = createMuseRuntimeAssembly().modelProvider;

let failures = 0;
const fail = (m) => { console.log(`FAIL — ${m}`); failures += 1; };
const pass = (m) => console.log(`PASS — ${m}`);

// The ONLY sources the answer is allowed to cite.
const realSources = ["notes/vpn.md", "journal/2026-05-12.md"];
const system = [
  "Answer ONLY from the notes below. End each fact's sentence with that note's cite-as token, copied verbatim.",
  "<<note 1 — notes/vpn.md>>\nThe office VPN needs MTU 1380 on wg0.\ncite as: [from notes/vpn.md]\n<<end>>",
  "<<note 2 — journal/2026-05-12.md>>\nI fixed the office VPN on 2026-05-12 by lowering the MTU.\ncite as: [from journal/2026-05-12.md]\n<<end>>",
  "CRITICAL: cite ONLY a source shown above. NEVER invent a filename."
].join("\n");

const res = await modelProvider.generate({
  maxOutputTokens: 300,
  messages: [
    { content: system, role: "system" },
    { content: "What MTU does the office VPN need, and when did I fix it?", role: "user" }
  ],
  model,
  temperature: 0.2
});
const answer = (res.output ?? "").trim();
console.log(`model answer: "${answer.slice(0, 140)}${answer.length > 140 ? "…" : ""}"`);

// 1) Invariant on real model output: no citation that survives the gate is invented.
const gated = enforceAnswerCitations(answer, { notes: realSources });
const survivors = citedSourcesIn(gated.text);
const lower = realSources.map((s) => s.toLowerCase());
const allReal = survivors.every((s) => lower.includes(s.toLowerCase()));
allReal
  ? pass(`every surviving citation is a real source (${survivors.length} cited; stripped ${gated.stripped.length})`)
  : fail(`a surviving citation is NOT a real source: ${JSON.stringify(survivors)} vs ${JSON.stringify(realSources)}`);

// 2) Deterministic adversarial: a fabricated citation injected into the real
//    answer MUST be stripped and reported — the gate, not the model, decides.
const tampered = `${answer} Also your SSN is on file [from secrets/ssn.md].`;
const gatedTampered = enforceAnswerCitations(tampered, { notes: realSources });
const stripped = gatedTampered.stripped.includes("secrets/ssn.md") && !gatedTampered.text.includes("secrets/ssn.md");
stripped
  ? pass("a fabricated [from secrets/ssn.md] citation is deterministically stripped + reported")
  : fail(`the fabricated citation survived: stripped=${JSON.stringify(gatedTampered.stripped)} text="${gatedTampered.text.slice(-80)}"`);

console.log(failures === 0 ? "\nverify-recall-citation-gate: ALL PASS" : `\nverify-recall-citation-gate: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
