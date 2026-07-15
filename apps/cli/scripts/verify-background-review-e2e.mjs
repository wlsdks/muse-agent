/**
 * END-TO-END live battery for the background-review engine on LOCAL qwen.
 * Turns the engine ON and drives a real multi-turn conversation through the
 * REAL agent runtime (createMuseRuntimeAssembly → agentRuntime.run), then
 * watches what was learned across surfaces:
 *
 *   - auto-extract stays EVERY turn (a fact stated on turn 1 — BELOW the
 *     review trigger — is still captured; proves the engine didn't regress it),
 *   - the engine's COMMITMENT arm fires on the turn-count trigger (turn 2) and
 *     a voiced open-loop becomes a scheduled check-in — the server-surface
 *     learning that didn't exist before.
 *
 * The skill arm (tool-iteration trigger) is covered separately by
 * verify-background-review.mjs (it needs a tool-using turn). Reviews are
 * fire-and-forget, so we sleep briefly after each turn to let them land.
 *
 *   node apps/cli/scripts/verify-background-review-e2e.mjs   (qwen3:8b)
 *
 * Exit 0 if every case passes, 1 otherwise. LOCAL OLLAMA ONLY.
 */
import { mkdtempSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import os from "node:os";
import path from "node:path";

import { createMuseRuntimeAssembly, resolveCheckinsFile } from "@muse/autoconfigure";
import { readCheckins } from "@muse/proactivity";

const model = process.argv[2] ?? "ollama/gemma4:12b";
if (!model.startsWith("ollama/")) { console.error("LOCAL OLLAMA ONLY"); process.exit(2); }

process.env.HOME = mkdtempSync(path.join(os.tmpdir(), "muse-bgr-e2e-"));
process.env.MUSE_DEFAULT_MODEL = model;
process.env.MUSE_BACKGROUND_REVIEW_ENABLED = "1";
process.env.MUSE_BACKGROUND_REVIEW_MEMORY_TURNS = "2"; // commitment/preference arms fire on turn 2
process.env.MUSE_USER_MEMORY_AUTO_EXTRACT = "true";

const asm = createMuseRuntimeAssembly();
const runtime = asm.agentRuntime;
const store = asm.userMemoryStore;
if (!runtime) { console.error("no agent runtime (no model provider)"); process.exit(2); }

const userId = "stark";
const messages = [];

async function turn(text) {
  messages.push({ content: text, role: "user" });
  const result = await runtime.run({ messages: [...messages], metadata: { userId }, model });
  const reply = result.response?.output ?? "";
  messages.push({ content: reply, role: "assistant" });
  await delay(9000); // let the fire-and-forget review (auto-extract + arms) land
  return reply;
}

console.log(`bg-review e2e — engine ON, MEMORY_TURNS=2, model ${model}\n`);

// Turn 1 — a durable fact, BELOW the review trigger. Only every-turn auto-extract should catch it.
await turn("By the way, I live in Busan and I'm a vegetarian.");
// Turn 2 — a voiced commitment, AT the trigger → the engine's commitment arm schedules a check-in.
await turn("Also, I need to email Bob about the Q3 report tomorrow.");

const memory = await store.findByUserId(userId);
const factBlob = JSON.stringify({ ...(memory?.facts ?? {}), ...(memory?.preferences ?? {}) }).toLowerCase();
const checkins = await readCheckins(resolveCheckinsFile(process.env)).catch(() => []);
const checkinBlob = checkins.map((c) => c.question).join(" | ").toLowerCase();

const cases = [
  { name: "auto-extract caught the turn-1 fact (every-turn, not lost by the trigger)", ok: /busan|vegetarian|채식/u.test(factBlob) },
  { name: "engine commitment arm scheduled a check-in for the voiced open-loop", ok: checkins.length > 0 && /bob|q3|report/u.test(checkinBlob) }
];

let failures = 0;
for (const c of cases) {
  console.log(`${c.ok ? "PASS" : "FAIL"} — ${c.name}`);
  if (!c.ok) failures += 1;
}
console.log(`\n  facts/prefs: ${factBlob}`);
console.log(`  check-ins:   ${JSON.stringify(checkins.map((c) => c.question))}`);
console.log(failures === 0 ? `\nALL PASS (2) on ${model}` : `\n${failures}/2 FAILED on ${model}`);
process.exit(failures === 0 ? 0 : 1);
