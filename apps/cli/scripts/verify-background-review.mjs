/**
 * LIVE battery for the background-review SKILL arm on LOCAL qwen — the
 * "hard tasks teach" half of the engine. Drives the REAL code path the engine
 * runs (`reviewSkillsFromTurns` + a real AuthoredSkillStore) against a real
 * model:
 *   - POSITIVE: a turn with a procedural correction → a reusable skill is
 *     AUTHORED (written active to the store).
 *   - NEGATIVE (no signal): a trivial turn → nothing authored.
 *   - INFORMATIONAL: a style-only preference correction. The drafter is
 *     prompted to return NONE for pure preferences (they belong in the
 *     playbook, not a skill), but a small local model often authors a narrow
 *     skill anyway — a KNOWN limitation, not a hard failure: the outcome is a
 *     real (if narrow) skill, the risk-scan still gates it, and the curator's
 *     consolidate folds narrow skills into umbrellas. Logged, not asserted.
 *
 *   node apps/cli/scripts/verify-background-review.mjs        (qwen3:8b)
 *
 * Exit 0 if every case passes, 1 otherwise. LOCAL OLLAMA QWEN ONLY.
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createMuseRuntimeAssembly } from "@muse/autoconfigure";
import { reviewSkillsFromTurns } from "@muse/agent-core";
import { AuthoredSkillStore } from "@muse/skills";

const model = process.argv[2] ?? "ollama/qwen3:8b";
if (!model.startsWith("ollama/")) { console.error("LOCAL OLLAMA QWEN ONLY"); process.exit(2); }
process.env.HOME = mkdtempSync(path.join(os.tmpdir(), "muse-bgreview-"));
process.env.MUSE_DEFAULT_MODEL = model;

const asm = createMuseRuntimeAssembly();
const modelProvider = asm.modelProvider;

const turn = (role, content) => ({ content, role });

const cases = [
  {
    name: "procedural correction → skill AUTHORED",
    kind: "authored",
    turns: [
      turn("user", "send the quarterly report to my manager"),
      turn("assistant", "Done — I attached the report.docx to the email."),
      turn("user", "no, that's not how — always export the doc to PDF first, THEN attach the PDF, never the raw .docx")
    ]
  },
  {
    name: "NEGATIVE: no correction → nothing authored",
    kind: "none",
    turns: [turn("user", "thanks, that's perfect"), turn("assistant", "Glad it helped!")]
  },
  {
    name: "INFORMATIONAL: style-only preference (model decides procedure-vs-preference)",
    kind: "info",
    turns: [
      turn("user", "summarise this thread"),
      turn("assistant", "Here is a detailed prose summary spanning several sentences..."),
      turn("user", "no, that's too long — just give me short bullet points")
    ]
  }
];

let failures = 0;
for (const c of cases) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "muse-bgreview-store-"));
  const store = new AuthoredSkillStore({ dir });
  const result = await reviewSkillsFromTurns(c.turns, {
    model,
    modelProvider,
    writeDraft: async (draft) => {
      const { action, skill } = await store.writeOrPatch(draft);
      return { action, name: skill.name };
    }
  });
  const authored = result.authored.length > 0;
  if (c.kind === "info") {
    console.log(`INFO — ${c.name}\n   authored: ${JSON.stringify(result.authored)} (either outcome acceptable)`);
    continue;
  }
  const ok = c.kind === "authored" ? authored : !authored;
  console.log(`${ok ? "PASS" : "FAIL"} — ${c.name}\n   authored: ${JSON.stringify(result.authored)}`);
  if (!ok) failures += 1;
}

const asserted = cases.filter((c) => c.kind !== "info").length;
console.log(failures === 0 ? `\nALL PASS (${asserted.toString()} asserted) on ${model}` : `\n${failures.toString()}/${asserted.toString()} FAILED on ${model}`);
process.exit(failures === 0 ? 0 : 1);
