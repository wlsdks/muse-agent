/**
 * FAST live battery for DUE-DATE REASONING on LOCAL qwen — when the user asks a
 * time-relative question ("what's due tomorrow?"), can the model correctly pick
 * the item due tomorrow and EXCLUDE one due far off? It can only if the recall
 * CONTEXT shows due dates in a human-readable LOCAL form with a relative hint —
 * the bug: tasks/reminders were injected with the RAW UTC ISO (e.g.
 * "2026-06-05T05:00:00.000Z"), which the 8B couldn't tell was "tomorrow", so it
 * SILENTLY DROPPED time-relative items. The fix renders them via `formatDueLocal`
 * ("Fri, Jun 5, 2026, 2:00 PM (tomorrow)"). Prompt/context behaviour → live-verify.
 *
 *   node apps/cli/scripts/verify-due-date-reasoning.mjs   (qwen3:8b)
 *
 * Exit 0 if both cases pass, 1 otherwise. LOCAL OLLAMA QWEN ONLY.
 */
process.env.TZ = "Asia/Seoul";

import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createMuseRuntimeAssembly } from "@muse/autoconfigure";
import { formatDueLocal } from "@muse/mcp";

const model = process.argv[2] ?? "ollama/qwen3:8b";
if (!model.startsWith("ollama/")) { console.error("LOCAL OLLAMA QWEN ONLY"); process.exit(2); }
process.env.HOME = mkdtempSync(path.join(os.tmpdir(), "muse-duedate-"));
process.env.MUSE_DEFAULT_MODEL = model;

const baseUrl = (process.env.OLLAMA_BASE_URL ?? "http://localhost:11434").replace(/\/$/, "");
try {
  const r = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
  if (!r.ok) throw new Error("not ok");
} catch {
  console.log(`verify-due-date-reasoning skipped — local Ollama not reachable at ${baseUrl}. A skip is not a pass.`);
  process.exit(0);
}

// Two tasks: one due TOMORROW 2pm local, one due ~10 days out — rendered the way
// the recall context now renders them (formatDueLocal, not the raw UTC ISO).
const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(14, 0, 0, 0);
const farOff = new Date(); farOff.setDate(farOff.getDate() + 10); farOff.setHours(14, 0, 0, 0);
const tasks = [
  `<<task 1 — t1>>\nFinish the Q3 deck (due ${formatDueLocal(tomorrow.toISOString())})\n[task: Finish the Q3 deck]\n<<end>>`,
  `<<task 2 — t2>>\nRenew passport (due ${formatDueLocal(farOff.toISOString())})\n[task: Renew passport]\n<<end>>`
].join("\n\n");

const modelProvider = createMuseRuntimeAssembly().modelProvider;
const SYSTEM = "Answer the user's question USING ONLY the open tasks below. Cite each with its [task: …] marker. Pay attention to each task's due date.";

async function answer(question) {
  const resp = await modelProvider.generate({ maxOutputTokens: 200, messages: [{ content: SYSTEM, role: "system" }, { content: `=== USER OPEN TASKS ===\n${tasks}\n=== END TASKS ===\n\nQuestion: ${question}`, role: "user" }], model, temperature: 0 });
  return (resp.output ?? "").toLowerCase();
}

let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? "PASS" : "FAIL"} — ${name}\n   ${got.slice(0, 180)}`); if (!ok) failures += 1; };

// CASE 1 — "due tomorrow?" must name the tomorrow task and NOT the far-off one.
{
  const got = await answer("what tasks are due tomorrow?");
  check("'due tomorrow?' → names the Q3 deck (tomorrow) and EXCLUDES the passport (10 days out)", /q3|deck/u.test(got) && !/passport/u.test(got), got);
}

// CASE 2 — the inverse: "in about a week / later" must surface the FAR task, proving
// the model is reading the dates (not just always echoing the first task).
{
  const got = await answer("which task is NOT due for about a week or more?");
  check("'not due for ~a week?' → surfaces the passport (the far-off one)", /passport/u.test(got), got);
}

console.log(failures === 0 ? `\nALL PASS (2) on ${model}` : `\n${failures}/2 FAILED on ${model}`);
process.exit(failures === 0 ? 0 : 1);
