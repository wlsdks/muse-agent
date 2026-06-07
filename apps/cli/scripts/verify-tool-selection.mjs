/**
 * FAST tool-selection check on local Qwen — does the model pick <expectedTool>
 * for <prompt> in one shot? One round, small model, ~1 minute. Use this to
 * verify a tool-selection slice instead of the full (slow) `pnpm smoke:live`.
 *
 *   node apps/cli/scripts/verify-tool-selection.mjs "remember my dentist is Dr. Kim" remember_fact
 *   node apps/cli/scripts/verify-tool-selection.mjs "what's due today?" muse.tasks.list ollama/qwen3:8b
 *
 * Exit 0 = selected (PASS), 1 = not selected (MISS), 2 = setup error.
 * LOCAL OLLAMA ONLY (testing.md) — refuses a non-ollama model.
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createMuseRuntimeAssembly } from "@muse/autoconfigure";

const prompt = process.argv[2];
const expected = process.argv[3];
const model = process.argv[4] ?? "ollama/gemma4:12b";

if (!prompt || !expected) {
  console.error('usage: verify-tool-selection.mjs "<prompt>" <expected_tool> [ollama/model]');
  process.exit(2);
}
if (!model.startsWith("ollama/")) {
  console.error(`refusing non-local model '${model}' (LOCAL OLLAMA ONLY)`);
  process.exit(2);
}

process.env.HOME = mkdtempSync(path.join(os.tmpdir(), "muse-select-"));
process.env.MUSE_DEFAULT_MODEL = model;
const asm = createMuseRuntimeAssembly();
if (!asm.agentRuntime) { console.error("no agentRuntime"); process.exit(2); }

const picked = [];
const stream = asm.agentRuntime.stream({
  messages: [
    { role: "system", content: "You are Muse, a personal assistant. Call the matching tool when the user asks you to do something." },
    { role: "user", content: prompt }
  ],
  metadata: { localMode: true, userId: "verify" },
  model,
  toolApprovalGate: async ({ toolCall }) => { picked.push(toolCall.name); return { allowed: true }; }
});
for await (const ev of stream) {
  if (ev.type === "tool-call-started" && ev.name) picked.push(ev.name);
}

const unique = [...new Set(picked)];
console.log(`prompt: ${JSON.stringify(prompt)}\nexpected: ${expected}\npicked: ${JSON.stringify(unique)}`);
if (unique.includes(expected)) {
  console.log(`PASS — ${model} selected ${expected}`);
  process.exit(0);
}
console.log(`MISS — ${model} did not select ${expected}`);
process.exit(1);
