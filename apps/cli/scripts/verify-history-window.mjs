/**
 * FAST live check on local Qwen — does the active-history window actually bound
 * what the model sees? An early fact that falls OUTSIDE a small window must be
 * forgotten; the same fact inside a large window must be recalled. Proves the
 * Context-Folding token bound is real, not cosmetic. ~1 minute.
 *
 *   node apps/cli/scripts/verify-history-window.mjs            (qwen3:8b)
 *
 * Exit 0 = both pass, 1 = a miss, 2 = setup error. LOCAL OLLAMA ONLY.
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createMuseRuntimeAssembly } from "@muse/autoconfigure";

const model = process.argv[2] ?? "ollama/gemma4:12b";
if (!model.startsWith("ollama/")) { console.error("LOCAL OLLAMA ONLY"); process.exit(2); }
process.env.HOME = mkdtempSync(path.join(os.tmpdir(), "muse-hw-"));
process.env.MUSE_DEFAULT_MODEL = model;

const { buildTurnMessages } = await import("../dist/chat-ink-core.js");
const asm = createMuseRuntimeAssembly();
const provider = asm.modelProvider;

// Early fact, then filler so it sits well back in the history.
const history = [
  { role: "user", content: "Please remember: my lucky number is 8421." },
  { role: "assistant", content: "Got it — 8421." }
];
for (let i = 0; i < 8; i++) {
  history.push({ role: "user", content: `Unrelated chat number ${i}: tell me a one-line fun fact.` });
  history.push({ role: "assistant", content: `Fun fact ${i}: octopuses have three hearts.` });
}

const question = "What is my lucky number? If it's not in our conversation, say you don't know.";
const system = "You are Muse. Answer only from the conversation.";

async function answer(window) {
  const messages = buildTurnMessages(system, history, question, window);
  const res = await provider.generate({ messages, model, temperature: 0, maxOutputTokens: 128 });
  return (res.output ?? "").trim();
}

let failures = 0;

// Small window (4 msgs) → the lucky-number turn is dropped → model can't know it.
const small = await answer(4);
const okForgotten = !small.includes("8421");
console.log(`${okForgotten ? "PASS" : "FAIL"} — windowed-out fact forgotten: ${JSON.stringify(small.slice(0, 140))}`);
if (!okForgotten) failures += 1;

// Large window (100) → the fact is in-context → recalled.
const large = await answer(100);
const okRecalled = large.includes("8421");
console.log(`${okRecalled ? "PASS" : "FAIL"} — in-window fact recalled: ${JSON.stringify(large.slice(0, 140))}`);
if (!okRecalled) failures += 1;

console.log(failures === 0 ? `\nALL PASS (2) on ${model}` : `\n${failures}/2 FAILED on ${model}`);
process.exit(failures === 0 ? 0 : 1);
