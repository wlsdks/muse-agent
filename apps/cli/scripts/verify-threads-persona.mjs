/**
 * FAST live check on local Qwen — does the persona's "threads you keep
 * returning to" line let the model reference an ongoing thread in
 * conversation? Builds the real persona via buildMusePersona, asks what the
 * user keeps working on, asserts the model names the thread. Plus a negative
 * control: with NO threads the model must not fabricate one. ~1 minute.
 *
 *   node apps/cli/scripts/verify-threads-persona.mjs            (qwen3:8b)
 *
 * Exit 0 = both pass, 1 = a miss, 2 = setup error. LOCAL OLLAMA ONLY.
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createMuseRuntimeAssembly } from "@muse/autoconfigure";

const model = process.argv[2] ?? "ollama/gemma4:12b";
if (!model.startsWith("ollama/")) { console.error("LOCAL OLLAMA ONLY"); process.exit(2); }
process.env.HOME = mkdtempSync(path.join(os.tmpdir(), "muse-thp-"));
process.env.MUSE_DEFAULT_MODEL = model;

const { buildMusePersona } = await import("../dist/muse-persona.js");
const asm = createMuseRuntimeAssembly();
if (!asm.agentRuntime) { console.error("no agentRuntime"); process.exit(2); }

// Distinct userId per call so the runtime's own per-user memory/auto-extract
// can't bleed the first answer into the second.
async function ask(persona, question, userId) {
  let text = "";
  for await (const ev of asm.agentRuntime.stream({
    messages: [{ role: "system", content: persona }, { role: "user", content: question }],
    metadata: { localMode: true, userId },
    model
  })) {
    if (ev.type === "text-delta" && ev.text) text += ev.text;
  }
  return text;
}

// Non-leading: lets the model honestly say it doesn't know rather than being
// forced to name a topic that isn't there.
const question = "Is there a topic I keep coming back to across our sessions? If you don't have that information, say so plainly. One short sentence.";

const withThreads = buildMusePersona(
  { facts: { name: "Jinan" }, preferences: { language: "English" }, recurringThreads: [{ topic: "Q3 budget", sessions: 3 }] },
  "verify"
);
if (!withThreads || !withThreads.includes("Q3 budget (3 sessions)")) {
  console.error("persona did not carry the threads line — got:\n" + withThreads);
  process.exit(2);
}
const withoutThreads = buildMusePersona({ facts: { name: "Jinan" }, preferences: { language: "English" } }, "verify");

let failures = 0;

const a = await ask(withThreads, question, "verify-pos");
const okGrounded = /q3|budget/i.test(a);
console.log(`${okGrounded ? "PASS" : "FAIL"} — grounded: ${JSON.stringify(a.trim().slice(0, 160))}`);
if (!okGrounded) failures += 1;

const b = await ask(withoutThreads, question, "verify-neg");
const okNeg = !/q3|budget/i.test(b);
console.log(`${okNeg ? "PASS" : "FAIL"} — negative (no threads → no fabrication): ${JSON.stringify(b.trim().slice(0, 160))}`);
if (!okNeg) failures += 1;

console.log(failures === 0 ? `\nALL PASS (2) on ${model}` : `\n${failures}/2 FAILED on ${model}`);
process.exit(failures === 0 ? 0 : 1);
