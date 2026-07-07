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
 *      is deterministically stripped (and reported);
 *   3. (clause-leak fix, positive) a clean grounded multi-sentence answer
 *      survives the gate byte-for-byte — the fix must not over-drop a real answer;
 *   4. (clause-leak fix, negative) the FABRICATED CLAUSE itself — not just its
 *      citation marker — is gone from the gated text: a bare, uncited "Also your
 *      SSN is on file." surviving the strip would be the exact leak this closes.
 *      Deterministic (not live-elicited) per the loop-engineering guidance that a
 *      reliable in-battery gate-function assertion beats a flaky elicitation.
 *   5. (over-deletion remediation, positive) a REAL note cited with realistic
 *      format variance — basename only, or hyphen swapped for underscore — is
 *      tolerantly resolved and its marker REWRITTEN to the canonical path, not
 *      dropped: the fix must not delete a genuinely-grounded claim just because
 *      the local model didn't echo the marker byte-for-byte.
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

const model = process.argv[2] ?? "ollama/gemma4:12b";
if (!model.startsWith("ollama/")) { console.error("LOCAL OLLAMA ONLY"); process.exit(2); }
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

// 3) Clause-leak fix, POSITIVE: a clean answer whose every sentence resolves to a
// real source must survive the gate untouched (the fix only drops SENTENCES with
// NO valid citation — it must never over-drop a genuinely grounded answer).
const cleanMultiSentence = "The office VPN needs MTU 1380 [from notes/vpn.md]. I fixed it on 2026-05-12 [from journal/2026-05-12.md].";
const gatedClean = enforceAnswerCitations(cleanMultiSentence, { notes: realSources });
gatedClean.text === cleanMultiSentence && gatedClean.stripped.length === 0
  ? pass("a clean grounded multi-sentence answer passes the gate byte-for-byte (no over-drop)")
  : fail(`a clean answer was altered: "${gatedClean.text}" stripped=${JSON.stringify(gatedClean.stripped)}`);

// 4) Clause-leak fix, NEGATIVE (deterministic — the leak this slice closes): the
// injected fabricated-citation sentence must be gone WHOLESALE, not merely stripped
// of its marker. Before the fix, `enforceAnswerCitations` left "Also your SSN is on
// file." behind as a bare, uncited assertion — a confident-looking fabrication. The
// fix drops the whole clause; only the grounded neighbour sentences remain.
const leakClosed = !gatedTampered.text.includes("SSN is on file") && !gatedTampered.text.includes("secrets/ssn.md");
leakClosed
  ? pass("the clause-leak fix holds: the fabricated CLAUSE is gone, not just its citation marker")
  : fail(`the fabricated clause survived un-cited (the leak this slice closes): text="${gatedTampered.text}"`);

// 5) Over-deletion remediation, POSITIVE (deterministic): a real note cited by
// basename (no directory) or with an underscore instead of a hyphen must SURVIVE
// with its marker rewritten to the canonical allowed path — not be dropped as if
// fabricated. Uses the same real source as case 1/2 so the check is meaningful
// against this battery's own corpus shape.
const basenameCited = "The office VPN needs MTU 1380 [from vpn.md].";
const gatedBasename = enforceAnswerCitations(basenameCited, { notes: realSources });
const basenameOk = gatedBasename.text.includes("[from notes/vpn.md]") && gatedBasename.stripped.length === 0;
basenameOk
  ? pass("a real note cited by BASENAME (no directory) survives, rewritten to the canonical path")
  : fail(`basename citation was NOT tolerantly resolved: text="${gatedBasename.text}" stripped=${JSON.stringify(gatedBasename.stripped)}`);

const underscoreCited = "I fixed the office VPN on 2026-05-12 [from journal/2026_05_12.md].";
const gatedUnderscore = enforceAnswerCitations(underscoreCited, { notes: realSources });
const underscoreOk = gatedUnderscore.text.includes("[from journal/2026-05-12.md]") && gatedUnderscore.stripped.length === 0;
underscoreOk
  ? pass("a real note cited with UNDERSCORES instead of hyphens survives, rewritten to the canonical path")
  : fail(`underscore-variant citation was NOT tolerantly resolved: text="${gatedUnderscore.text}" stripped=${JSON.stringify(gatedUnderscore.stripped)}`);

console.log(failures === 0 ? "\nverify-recall-citation-gate: ALL PASS" : `\nverify-recall-citation-gate: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
