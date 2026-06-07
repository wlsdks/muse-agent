/**
 * FAST live battery for playbook strategy-merge on LOCAL qwen — do genuinely
 * redundant strategies merge into one general strategy, and crucially return
 * NONE for DISTINCT strategies (never collapse different advice)? The negative
 * case is the whole risk.
 *
 *   node apps/cli/scripts/verify-playbook-merge.mjs        (qwen3:8b)
 *
 * Exit 0 if every case passes, 1 otherwise. LOCAL OLLAMA ONLY.
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createMuseRuntimeAssembly, createOllamaEmbedder } from "@muse/autoconfigure";
import { mergePlaybookStrategies, validateMergeCoverage } from "@muse/agent-core";

const model = process.argv[2] ?? "ollama/gemma4:12b";
if (!model.startsWith("ollama/")) { console.error("LOCAL OLLAMA ONLY"); process.exit(2); }
process.env.HOME = mkdtempSync(path.join(os.tmpdir(), "muse-pbmerge-"));
process.env.MUSE_DEFAULT_MODEL = model;

const asm = createMuseRuntimeAssembly();
const modelProvider = asm.modelProvider;
const embed = createOllamaEmbedder("nomic-embed-text");

const cases = [
  {
    name: "redundant summarise strategies → one merged",
    kind: "merged",
    needles: ["bullet", "summar", "concise"],
    texts: ["when asked to summarise, use bullet points not prose", "summaries should be given as bullet points, not paragraphs"]
  },
  {
    // A second redundant cluster in a DIFFERENT domain (scheduling, not
    // summarising) — proves the merger isn't overfit to one topic. STABLE 3/3.
    name: "redundant scheduling strategies → one merged",
    kind: "merged",
    needles: ["back-to-back", "buffer", "gap", "meeting", "schedul"],
    texts: ["when scheduling meetings, always leave buffer time and avoid back-to-back slots", "never book meetings back-to-back; keep a gap between them"]
  },
  {
    name: "NEGATIVE: distinct strategies → NONE (never collapse)",
    kind: "none",
    texts: ["when rescheduling, default to the next business day", "keep work emails under four sentences"]
  }
];

let failures = 0;
for (const c of cases) {
  const out = await mergePlaybookStrategies(c.texts, { model, modelProvider });
  let ok;
  let gateNote = "";
  if (c.kind === "merged") {
    const v = (out ?? "").toLowerCase();
    const coherent = Boolean(out) && c.needles.some((n) => v.includes(n.toLowerCase()));
    // Held-out gate must ACCEPT a coherent real merge — a rejection here is a
    // false-reject regression, not the gate doing its job.
    const verdict = out
      ? await validateMergeCoverage(c.texts.map((t) => ({ label: t.slice(0, 40), text: t })), { label: out.slice(0, 40), text: out }, { embed })
      : { accept: false, reason: "no merge produced" };
    ok = coherent && verdict.accept;
    gateNote = `\n   gate: ${verdict.accept ? "ACCEPT" : "REJECT"} — ${verdict.reason}`;
  } else {
    ok = out === undefined;
  }
  console.log(`${ok ? "PASS" : "FAIL"} — ${c.name}\n   out: ${JSON.stringify(out)}${gateNote}`);
  if (!ok) failures += 1;
}

console.log(failures === 0 ? `\nALL PASS (${cases.length}) on ${model}` : `\n${failures}/${cases.length} FAILED on ${model}`);
process.exit(failures === 0 ? 0 : 1);
