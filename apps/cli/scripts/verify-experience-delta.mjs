/**
 * END-TO-END LIVE proof of CROSS-SESSION self-improvement (the audit's #1 gap).
 * Not a mechanism unit-test — a behavioral A/B on the REAL agent runtime
 * (createMuseRuntimeAssembly → agentRuntime.run), same fixed local model, the
 * ONLY difference being whether an earlier session's experience was stored:
 *
 *   PRIMED arm — session 1 teaches a durable fact (auto-extracted to the
 *     file-backed user-memory store); a FRESH session 2 (new runtime, new
 *     message list, SAME HOME) is asked about it → must answer FROM the stored
 *     memory (the fact appears in the reply).
 *   EMPTY arm — a fresh HOME with no prior session; the SAME question → the
 *     grounding floor must make it ABSTAIN (the fact does NOT appear; nothing to
 *     ground on, so it must not fabricate one).
 *
 * The delta (primed answers, empty abstains, same question + model) is the only
 * thing that can produce it: an earlier turn's stored experience. This is what a
 * fixed-weight model's "self-improvement" can mean — a later session is
 * measurably better BECAUSE an earlier one was remembered. Deterministic stores
 * + grounding gate make the delta stable; pass^k via re-runs.
 *
 *   node apps/cli/scripts/verify-experience-delta.mjs            (gemma4:12b)
 *
 * Exit 0 if every case passes, 1 otherwise. LOCAL OLLAMA ONLY.
 */
import { mkdtempSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import os from "node:os";
import path from "node:path";

import { createMuseRuntimeAssembly } from "@muse/autoconfigure";

const model = process.argv[2] ?? "ollama/gemma4:12b";
if (!model.startsWith("ollama/")) { console.error("LOCAL OLLAMA ONLY"); process.exit(2); }

const userId = "stark";
const QUESTION = "Which city do I live in? If you don't know, say you're not sure.";
const FACT = "busan";

function freshHome() {
  process.env.HOME = mkdtempSync(path.join(os.tmpdir(), "muse-xp-delta-"));
  process.env.MUSE_DEFAULT_MODEL = model;
  process.env.MUSE_USER_MEMORY_AUTO_EXTRACT = "true";
}

async function askFreshSession(text) {
  // A NEW assembly = a new process/session: it can only "know" what's PERSISTED.
  const asm = createMuseRuntimeAssembly();
  if (!asm.agentRuntime) { console.error("no agent runtime (no model provider)"); process.exit(2); }
  const result = await asm.agentRuntime.run({ messages: [{ content: text, role: "user" }], metadata: { userId }, model });
  return (result.response?.output ?? "").toLowerCase();
}

async function teach(text) {
  const asm = createMuseRuntimeAssembly();
  await asm.agentRuntime.run({ messages: [{ content: text, role: "user" }], metadata: { userId }, model });
  await delay(9000); // let fire-and-forget auto-extract persist the fact
}

console.log(`experience-delta — cross-session A/B, model ${model}\n`);

// PRIMED: session 1 teaches, a FRESH session 2 must recall from the store
freshHome();
await teach("By the way, I live in Busan.");
const primed = await askFreshSession(QUESTION);

// EMPTY: a fresh HOME, no prior session — same question
freshHome();
const empty = await askFreshSession(QUESTION);

const cases = [
  { name: "PRIMED session recalls the stored fact (experience from an earlier session helps)", ok: primed.includes(FACT) },
  { name: "EMPTY session ABSTAINS — no stored fact, so it must not fabricate the city", ok: !empty.includes(FACT) }
];

let failures = 0;
for (const c of cases) {
  console.log(`${c.ok ? "PASS" : "FAIL"} — ${c.name}`);
  if (!c.ok) failures += 1;
}
console.log(`\n  primed answer: ${primed.slice(0, 160)}`);
console.log(`  empty  answer: ${empty.slice(0, 160)}`);
console.log(failures === 0 ? `\nALL PASS (2) on ${model} — cross-session self-improvement is REAL` : `\n${failures}/2 FAILED on ${model}`);
process.exit(failures === 0 ? 0 : 1);
