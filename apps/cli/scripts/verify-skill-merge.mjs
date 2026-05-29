/**
 * FAST live battery for curator skill-merge on LOCAL qwen — does a cluster of
 * genuinely-related narrow skills merge into ONE coherent umbrella, and
 * crucially return NONE for UNRELATED skills (no force-merge)? The negative
 * case is the whole risk of automatic consolidation.
 *
 *   node apps/cli/scripts/verify-skill-merge.mjs        (qwen3:8b)
 *
 * Exit 0 if every case passes, 1 otherwise. LOCAL OLLAMA QWEN ONLY.
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createMuseRuntimeAssembly } from "@muse/autoconfigure";
import { mergeSkillsIntoUmbrella } from "@muse/agent-core";

const model = process.argv[2] ?? "ollama/qwen3:8b";
if (!model.startsWith("ollama/")) { console.error("LOCAL OLLAMA QWEN ONLY"); process.exit(2); }
process.env.HOME = mkdtempSync(path.join(os.tmpdir(), "muse-merge-"));
process.env.MUSE_DEFAULT_MODEL = model;

const asm = createMuseRuntimeAssembly();
const modelProvider = asm.modelProvider;

const cases = [
  {
    name: "related summarise-* skills → coherent umbrella",
    kind: "umbrella",
    needles: ["summar", "요약"],
    cluster: [
      { name: "summarise-email", description: "Use when summarising an email thread", body: "1. read the thread\n2. emit 3 bullets" },
      { name: "summarise-doc", description: "Use when summarising a document", body: "1. skim headings\n2. emit bullets" },
      { name: "summarise-notes", description: "Use when summarising meeting notes", body: "1. scan notes\n2. action items as bullets" }
    ]
  },
  {
    name: "NEGATIVE: unrelated skills → NONE (no force-merge)",
    kind: "none",
    cluster: [
      { name: "summarise-email", description: "Use when summarising an email", body: "read; bullets" },
      { name: "book-flight", description: "Use when booking a flight", body: "search; pick; confirm payment" }
    ]
  }
];

let failures = 0;
for (const c of cases) {
  const out = await mergeSkillsIntoUmbrella(c.cluster, { model, modelProvider });
  let ok;
  if (c.kind === "umbrella") {
    const blob = `${out?.name ?? ""} ${out?.description ?? ""} ${out?.body ?? ""}`.toLowerCase();
    ok = Boolean(out?.name) && Boolean(out?.description) && Boolean(out?.body) && c.needles.some((n) => blob.includes(n.toLowerCase()));
  } else {
    ok = out === undefined;
  }
  console.log(`${ok ? "PASS" : "FAIL"} — ${c.name}\n   out: ${JSON.stringify(out)?.slice(0, 200)}`);
  if (!ok) failures += 1;
}

console.log(failures === 0 ? `\nALL PASS (${cases.length}) on ${model}` : `\n${failures}/${cases.length} FAILED on ${model}`);
process.exit(failures === 0 ? 0 : 1);
