/**
 * LIVE battery for evidence-gated standing-objective completion (roadmap D —
 * the objective evaluator no longer asserts `met` on its own say-so). The
 * model only PROPOSES which local store + keywords would evidence the
 * objective; CODE resolves that query against injected fixture stores and
 * decides `met` deterministically. This proves the real gemma4 proposal
 * round-trips into a code-verified outcome — not just that the parser is
 * correct (that's unit-tested already).
 *
 *   node apps/cli/scripts/verify-objective-completion.mjs   (gemma4:12b)
 *
 * Exit 0 if every case passes, 1 otherwise. LOCAL OLLAMA ONLY.
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createMuseRuntimeAssembly } from "@muse/autoconfigure";
import { createModelObjectiveEvaluator } from "@muse/proactivity";

const model = process.argv[2] ?? "ollama/gemma4:12b";
if (!model.startsWith("ollama/")) { console.error("LOCAL OLLAMA ONLY"); process.exit(2); }
process.env.HOME = mkdtempSync(path.join(os.tmpdir(), "muse-objective-"));
process.env.MUSE_DEFAULT_MODEL = model;

const asm = createMuseRuntimeAssembly();
const modelProvider = asm.modelProvider;

const THREE_WORKOUT_TASKS = [
  { title: "workout: ran 5k", createdAt: "2026-07-08T09:00:00.000Z" },
  { title: "workout: strength day", createdAt: "2026-07-09T09:00:00.000Z" },
  { title: "workout: yoga session", createdAt: "2026-07-10T09:00:00.000Z" }
];
const TWO_WORKOUT_TASKS = THREE_WORKOUT_TASKS.slice(0, 2);

function objective(spec) {
  return {
    createdAt: "2026-07-04T00:00:00.000Z",
    id: "obj_verify",
    kind: "watch",
    spec,
    status: "active",
    userId: "verify"
  };
}

// kind "met" → outcome must be "met" AND evidence.length >= minEvidence;
// kind "unmet" → outcome must be "unmet" (never "met" without proof).
const cases = [
  {
    name: "3 matching in-window task records prove a 3x-this-week objective ⇒ met, evidence >= 3",
    kind: "met",
    minEvidence: 3,
    spec: "this week I want to have logged a workout 3 times — tell me when that's true",
    tasks: THREE_WORKOUT_TASKS
  },
  {
    name: "only 2 matching records ⇒ unmet (not enough evidence yet, never a false met)",
    kind: "unmet",
    spec: "this week I want to have logged a workout 3 times — tell me when that's true",
    tasks: TWO_WORKOUT_TASKS
  },
  {
    name: "no local store could ever evidence this ⇒ unmet (honest terminal, never met)",
    kind: "unmet",
    spec: "let me know the moment a crewed mission lands on the moon again",
    tasks: []
  }
];

let failures = 0;
for (const c of cases) {
  const evaluate = createModelObjectiveEvaluator({
    evidenceDeps: { readTasks: () => Promise.resolve(c.tasks) },
    model,
    modelProvider,
    now: () => new Date("2026-07-11T12:00:00.000Z")
  });
  const result = await evaluate(objective(c.spec));
  let ok;
  if (c.kind === "met") {
    const evidenceLen = result.outcome === "met" ? (result.evidence?.length ?? 0) : 0;
    ok = result.outcome === "met" && evidenceLen >= c.minEvidence;
  } else {
    ok = result.outcome === "unmet";
  }
  console.log(`${ok ? "PASS" : "FAIL"} — ${c.name}\n   out: ${JSON.stringify(result)}`);
  if (!ok) failures += 1;
}

console.log(failures === 0 ? `\nALL PASS (${cases.length}) on ${model}` : `\n${failures}/${cases.length} FAILED on ${model}`);
process.exit(failures === 0 ? 0 : 1);
