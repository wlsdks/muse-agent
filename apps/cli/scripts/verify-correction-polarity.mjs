/**
 * FAST live battery for the autonomous SUBTRACTIVE correction-decay polarity gate
 * (P43-1) on LOCAL qwen — does `classifyCorrectionContradiction` correctly tell a
 * correction that CONTRADICTS a strategy Muse applies ("stop using a warm
 * sign-off" vs "use a warm sign-off") from one that AGREES or is UNRELATED? The
 * SAFETY-critical metric is ZERO false-CONTRADICT — a false CONTRADICT would
 * wrongly decay a good strategy (the sign error the playbook panel flagged). A
 * lexical Jaccard can't do this (topic-overlap can't tell "do X" from "STOP X"),
 * which is why this gate is an LLM judgment that must be live-verified.
 *
 *   node apps/cli/scripts/verify-correction-polarity.mjs   (qwen3:8b)
 *
 * Exit 0 if every case passes AND there are zero false-CONTRADICT, 1 otherwise.
 * LOCAL OLLAMA QWEN ONLY.
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createMuseRuntimeAssembly } from "@muse/autoconfigure";
import { classifyCorrectionContradiction } from "@muse/agent-core";

const model = process.argv[2] ?? "ollama/qwen3:8b";
if (!model.startsWith("ollama/")) { console.error("LOCAL OLLAMA QWEN ONLY"); process.exit(2); }
process.env.HOME = mkdtempSync(path.join(os.tmpdir(), "muse-polarity-"));
process.env.MUSE_DEFAULT_MODEL = model;

const modelProvider = createMuseRuntimeAssembly().modelProvider;

// [correction, strategy-Muse-applies, expected]
const cases = [
  // CONTRADICT — incl. topic-overlap-but-opposite (the exact case a lexical matcher misses)
  ["Stop ending messages with a warm sign-off, just stop abruptly.", "End every message with a warm sign-off.", "contradict"],
  ["Don't give me long essays — answer in one short sentence.", "Give thorough, detailed multi-paragraph answers.", "contradict"],
  ["Quit adding emojis to everything.", "Add a friendly emoji to each response.", "contradict"],
  ["Stop calling me 'Sir'.", "Address the user as 'Sir'.", "contradict"],
  ["Don't use bullet points, write in prose.", "Format answers as bullet-point lists.", "contradict"],
  // AGREE — reinforces; a false CONTRADICT here wrongly decays a good rule
  ["Yes, keep answers short like that.", "Keep answers concise and short.", "agree"],
  ["Good, always cite the source note.", "Always cite the source note for any claim.", "agree"],
  ["Perfect, keep addressing me by my first name.", "Address the user by their first name.", "agree"],
  // UNRELATED — different topic; a false CONTRADICT here wrongly decays an unrelated rule
  ["Stop using a warm sign-off.", "Always cite the source note for any claim.", "unrelated"],
  ["Don't add emojis.", "Address the user as 'Sir'.", "unrelated"],
  ["Keep it to one sentence.", "Use metric units for measurements.", "unrelated"]
];

let failures = 0;
let falseContradict = 0;
for (const [correction, strategy, expected] of cases) {
  const got = await classifyCorrectionContradiction(correction, strategy, { model, modelProvider });
  const ok = got === expected;
  if (!ok) failures += 1;
  if (got === "contradict" && expected !== "contradict") falseContradict += 1;
  console.log(`${ok ? "PASS" : "FAIL"} exp=${expected} got=${got} — "${correction.slice(0, 40)}" vs "${strategy.slice(0, 32)}"`);
}

// The safety gate: even one false-CONTRADICT is a fail (it would decay a good strategy).
const safetyFail = falseContradict > 0;
console.log(`\n${failures === 0 && !safetyFail ? "ALL PASS" : "FAILED"} (${cases.length - failures}/${cases.length}) on ${model} — false-CONTRADICT (safety-critical): ${falseContradict}`);
process.exit(failures === 0 && !safetyFail ? 0 : 1);
