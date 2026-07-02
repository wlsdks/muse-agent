/**
 * LIVE battery for the `runGroundedRecall` SEAM (@muse/recall pipeline.ts) —
 * the one-call grounded-recall entry point the API surface (`POST /api/ask`)
 * serves. Drives the REAL local model + REAL embeddings through the seam over
 * a tiny temp corpus and asserts the wedge invariant ON THE SEAM'S OUTPUT:
 *
 *   1. answerable question → every citation the result carries resolves to a
 *      real corpus source (fabrication=0, checked on real model output);
 *   2. a fabricated citation injected into the real model answer is stripped
 *      BY THE SEAM (result.strippedCitations reports it, the text loses it);
 *   3. absent-information question → still zero fabricated sources.
 *
 *   node apps/cli/scripts/verify-grounded-recall-seam.mjs   (ollama/gemma4:12b)
 *
 * Exit 0 if every case passes; skip (exit 0) if Ollama or an embed model is
 * unreachable. LOCAL OLLAMA ONLY.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createMuseRuntimeAssembly } from "@muse/autoconfigure";
import { embed, reindexNotes, runGroundedRecall } from "@muse/recall";

const model = process.argv[2] ?? "ollama/gemma4:12b";
if (!model.startsWith("ollama/")) { console.error("LOCAL OLLAMA ONLY"); process.exit(2); }
const baseUrl = (process.env.OLLAMA_BASE_URL ?? "http://localhost:11434").replace(/\/$/, "");

async function tags() {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 3_000);
    const r = await fetch(`${baseUrl}/api/tags`, { signal: c.signal });
    clearTimeout(t);
    if (!r.ok) return undefined;
    const body = await r.json();
    return (body.models ?? []).map((m) => String(m.name ?? ""));
  } catch { return undefined; }
}
const available = await tags();
if (!available) {
  console.log(`verify-grounded-recall-seam skipped — local Ollama not reachable at ${baseUrl}. A skip is not a pass.`);
  process.exit(0);
}
const embedModel = ["nomic-embed-text-v2-moe", "nomic-embed-text"]
  .find((m) => available.some((name) => name === m || name.startsWith(`${m}:`)));
if (!embedModel) {
  console.log("verify-grounded-recall-seam skipped — no local embed model (nomic-embed-text[-v2-moe]) pulled. A skip is not a pass.");
  process.exit(0);
}

process.env.HOME = mkdtempSync(path.join(os.tmpdir(), "muse-recall-seam-"));
process.env.MUSE_DEFAULT_MODEL = model;
const modelProvider = createMuseRuntimeAssembly().modelProvider;

// Tiny REAL corpus: build the index with real embeddings through the package's
// own reindexNotes (the same path `muse notes reindex` uses).
const notesDir = path.join(process.env.HOME, "notes");
mkdirSync(notesDir, { recursive: true });
writeFileSync(path.join(notesDir, "vpn.md"), "The office VPN needs MTU 1380 on the wg0 interface.\n");
writeFileSync(path.join(notesDir, "coffee.md"), "My favorite coffee order is a flat white with oat milk.\n");
const indexFile = path.join(process.env.HOME, "notes-index.json");
const baseUrlResolver = () => baseUrl;
const summary = await reindexNotes({ baseUrlResolver, dir: notesDir, indexPath: indexFile, model: embedModel });
if (summary.embedded === 0) {
  console.log("verify-grounded-recall-seam skipped — embedding produced no index (embed endpoint failing). A skip is not a pass.");
  process.exit(0);
}

const embedFn = (text, m) => embed(text, m, { baseUrlResolver });
const generateReal = async ({ system, user, model: answerModel, temperature }) => {
  const res = await modelProvider.generate({
    maxOutputTokens: 300,
    messages: [{ content: system, role: "system" }, { content: user, role: "user" }],
    model: answerModel,
    temperature: temperature ?? 0.2
  });
  return (res.output ?? "").trim();
};

const realSources = ["vpn.md", "coffee.md"];
const seamInput = (generateAnswer, query) => ({
  options: { answerModel: model, embedModel, topK: 4 },
  query,
  runtime: { embedFn, generateAnswer },
  sources: { notesDir, notesIndexFile: indexFile }
});

let failures = 0;
const fail = (m) => { console.log(`FAIL — ${m}`); failures += 1; };
const pass = (m) => console.log(`PASS — ${m}`);
const onlyReal = (citations) => citations.every((c) => realSources.includes(c.split("/").pop() ?? c));

// 1) Answerable: real model, real embeddings, one seam call.
const grounded = await runGroundedRecall(seamInput(generateReal, "What MTU does the office VPN need?"));
console.log(`grounded answer: "${grounded.answer.slice(0, 140)}${grounded.answer.length > 140 ? "…" : ""}" (verdict ${grounded.verdict})`);
onlyReal(grounded.citations)
  ? pass(`every citation resolves to a real corpus source (${JSON.stringify(grounded.citations)})`)
  : fail(`a non-corpus citation survived the seam: ${JSON.stringify(grounded.citations)}`);
grounded.answer.includes("1380")
  ? pass("the grounded fact (MTU 1380) is in the answer")
  : fail(`the answerable fact is missing from the answer: "${grounded.answer.slice(0, 200)}"`);

// 2) Adversarial: the REAL answer plus an injected fabricated citation must
//    lose the fabrication INSIDE the seam (code strips it, not the model).
const tamper = async (args) => `${await generateReal(args)} Also, your SSN is 123-45-6789. [from secrets/ssn.md]`;
const tampered = await runGroundedRecall(seamInput(tamper, "What MTU does the office VPN need?"));
const strippedOk = tampered.strippedCitations.includes("secrets/ssn.md") && !tampered.answer.includes("secrets/ssn.md");
strippedOk
  ? pass("an injected fabricated citation is stripped by the seam and reported in strippedCitations")
  : fail(`the fabricated citation survived the seam: stripped=${JSON.stringify(tampered.strippedCitations)} answer-tail="${tampered.answer.slice(-100)}"`);

// 3) Absent information: whatever the model says, no fabricated source may leave the seam.
const absent = await runGroundedRecall(seamInput(generateReal, "What is my aunt's cat's name?"));
console.log(`absent-info answer: "${absent.answer.slice(0, 140)}${absent.answer.length > 140 ? "…" : ""}" (verdict ${absent.verdict}, refusal ${String(absent.refusal)})`);
onlyReal(absent.citations)
  ? pass(`absent-info question carried no fabricated source (citations ${JSON.stringify(absent.citations)})`)
  : fail(`absent-info question produced a non-corpus citation: ${JSON.stringify(absent.citations)}`);

console.log(failures === 0 ? "\nverify-grounded-recall-seam: ALL PASS" : `\nverify-grounded-recall-seam: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
