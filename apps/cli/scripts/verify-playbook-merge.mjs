/**
 * FAST live battery for playbook strategy-merge on LOCAL qwen — do genuinely
 * redundant strategies merge into one general strategy, and crucially return
 * NONE for DISTINCT strategies (never collapse different advice)? The negative
 * case is the whole risk.
 *
 *   node apps/cli/scripts/verify-playbook-merge.mjs        (qwen3:8b)
 *
 * Exit 0 if every case passes, 1 otherwise. LOCAL OLLAMA QWEN ONLY.
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createMuseRuntimeAssembly } from "@muse/autoconfigure";
import { mergePlaybookStrategies } from "@muse/agent-core";

const model = process.argv[2] ?? "ollama/qwen3:8b";
if (!model.startsWith("ollama/")) { console.error("LOCAL OLLAMA QWEN ONLY"); process.exit(2); }
process.env.HOME = mkdtempSync(path.join(os.tmpdir(), "muse-pbmerge-"));
process.env.MUSE_DEFAULT_MODEL = model;

const asm = createMuseRuntimeAssembly();
const modelProvider = asm.modelProvider;

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
  if (c.kind === "merged") {
    const v = (out ?? "").toLowerCase();
    ok = Boolean(out) && c.needles.some((n) => v.includes(n.toLowerCase()));
  } else {
    ok = out === undefined;
  }
  console.log(`${ok ? "PASS" : "FAIL"} — ${c.name}\n   out: ${JSON.stringify(out)}`);
  if (!ok) failures += 1;
}

console.log(failures === 0 ? `\nALL PASS (${cases.length}) on ${model}` : `\n${failures}/${cases.length} FAILED on ${model}`);
process.exit(failures === 0 ? 0 : 1);
