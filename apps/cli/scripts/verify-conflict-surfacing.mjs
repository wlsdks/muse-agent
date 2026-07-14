/**
 * FAST live battery for CONFLICT-SURFACING on LOCAL qwen — when the recall
 * evidence CONFLICTS (two notes give different answers), does the model SURFACE
 * the conflict ("I have conflicting notes — which is current?") instead of
 * silently picking one? And does it NOT over-flag an explicit UPDATE ("moved
 * to …") as a conflict? This extends the honesty edge ("I'm not sure" → "I have
 * conflicting info"); it is a prompt-instruction behaviour (CITATION_INSTRUCTION_LINES),
 * so it must be live-verified on the fixed local model.
 *
 *   node apps/cli/scripts/verify-conflict-surfacing.mjs   (qwen3:8b)
 *
 * Exit 0 if both cases pass, 1 otherwise. LOCAL OLLAMA ONLY.
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createMuseRuntimeAssembly } from "@muse/autoconfigure";

import { CITATION_INSTRUCTION_LINES } from "../dist/commands-ask.js";

const model = process.argv[2] ?? "ollama/gemma4:12b";
if (!model.startsWith("ollama/")) { console.error("LOCAL OLLAMA ONLY"); process.exit(2); }
process.env.HOME = mkdtempSync(path.join(os.tmpdir(), "muse-conflict-"));
process.env.MUSE_DEFAULT_MODEL = model;

const baseUrl = (process.env.OLLAMA_BASE_URL ?? "http://localhost:11434").replace(/\/$/, "");
try {
  const r = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
  if (!r.ok) throw new Error("not ok");
} catch {
  console.log(`verify-conflict-surfacing skipped — local Ollama not reachable at ${baseUrl}. A skip is not a pass.`);
  process.exit(0);
}

const modelProvider = createMuseRuntimeAssembly().modelProvider;
const SYSTEM = `Answer the user's question using ONLY the passages provided below. Cite each fact.\n${CITATION_INSTRUCTION_LINES.join("\n")}`;

async function answer(passages, question) {
  const user = `Passages:\n${passages}\n\nQuestion: ${question}`;
  const resp = await modelProvider.generate({ maxOutputTokens: 200, messages: [{ content: SYSTEM, role: "system" }, { content: user, role: "user" }], model, temperature: 0 });
  return (resp.output ?? "").toLowerCase();
}

let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? "PASS" : "FAIL"} — ${name}\n   ${got.slice(0, 160)}`); if (!ok) failures += 1; };

// CASE 1 — a GENUINE conflict (no update wording): must surface BOTH values + the conflict.
{
  const got = await answer(
    "<<a.md>>\nMy dentist appointment is on June 12th.\n[from a.md]\n\n<<b.md>>\nDentist: June 15th.\n[from b.md]",
    "When is my dentist appointment?"
  );
  // Both values must appear AND the model must ASK which is current — an
  // explicit clarifying question, not merely the word "conflict" in a statement.
  // The old matcher (`conflict|which|differ|disagree`) passed a flat "There is a
  // conflict: June 12 and June 15." with no question; the honesty edge is the
  // question ("which is current?"), so require a question mark + a
  // which/current/latest interrogative.
  const bothDates = got.includes("june 12") && got.includes("june 15");
  const asksWhichCurrent = /\?/u.test(got) && /which|current|correct|latest|up[\s-]?to[\s-]?date|still (right|correct|current|accurate|valid)/iu.test(got);
  check("GENUINE conflict → surfaces both values + ASKS which is current", bothDates && asksWhichCurrent, got);
}

// CASE 2 — an explicit UPDATE: must pick the updated value, NOT call it a conflict.
{
  const got = await answer(
    "<<old.md>>\nThe weekly team sync is on Tuesday at 3:00pm.\n[from old.md]\n\n<<new.md>>\nUpdate: the weekly team sync has MOVED to Thursday at 4:00pm.\n[from new.md]",
    "When is the weekly team sync?"
  );
  // The distinction that matters: an UPDATE is RESOLVED (the newer value is stated
  // as THE answer), not left as an open "which is current?" question. Transparently
  // noting the prior value is fine — leaving it UNRESOLVED is the failure.
  const ok = (got.includes("thursday") || got.includes("4:00") || got.includes("4pm")) && !/which is current|which one (is|should)/u.test(got);
  check("explicit UPDATE → RESOLVES to the updated value (not left as an open 'which is current?')", ok, got);
}

console.log(failures === 0 ? `\nALL PASS (2) on ${model}` : `\n${failures}/2 FAILED on ${model}`);
process.exit(failures === 0 ? 0 : 1);
