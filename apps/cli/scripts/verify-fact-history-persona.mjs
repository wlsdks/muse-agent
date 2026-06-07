/**
 * FAST live check on local Qwen — does the persona's superseded-fact suffix
 * ("(previously Busan)") actually let the model answer a temporal-depth
 * question? Builds the real persona via buildMusePersona, sends it as the
 * system prompt + a "what did I used to…?" question, asserts the model's
 * reply names the PRIOR value. One round, qwen3:8b, ~1 minute.
 *
 *   node apps/cli/scripts/verify-fact-history-persona.mjs            (qwen3:8b)
 *   node apps/cli/scripts/verify-fact-history-persona.mjs ollama/qwen3:8b
 *
 * Exit 0 = PASS (prior surfaced + used), 1 = MISS, 2 = setup error.
 * LOCAL OLLAMA ONLY (testing.md) — refuses a non-ollama model.
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createMuseRuntimeAssembly } from "@muse/autoconfigure";

const model = process.argv[2] ?? "ollama/gemma4:12b";
if (!model.startsWith("ollama/")) {
  console.error(`refusing non-local model '${model}' (LOCAL OLLAMA ONLY)`);
  process.exit(2);
}

process.env.HOME = mkdtempSync(path.join(os.tmpdir(), "muse-fhp-"));
process.env.MUSE_DEFAULT_MODEL = model;

const { buildMusePersona } = await import("../dist/muse-persona.js");
const persona = buildMusePersona(
  {
    facts: { home_city: "Seoul" },
    preferences: { language: "English" },
    factHistory: [{ key: "home_city", previousValue: "Busan" }]
  },
  "verify"
);
if (!persona || !persona.includes("(previously Busan)")) {
  console.error("persona did not carry the prior value — got:\n" + persona);
  process.exit(2);
}

const asm = createMuseRuntimeAssembly();
if (!asm.agentRuntime) { console.error("no agentRuntime"); process.exit(2); }

let text = "";
const stream = asm.agentRuntime.stream({
  messages: [
    { role: "system", content: persona },
    { role: "user", content: "Which city did I live in BEFORE my current one? Answer with just the city name." }
  ],
  metadata: { localMode: true, userId: "verify" },
  model
});
for await (const ev of stream) {
  if (ev.type === "text-delta" && ev.text) text += ev.text;
}

const said = text.toLowerCase();
console.log(`reply: ${JSON.stringify(text.trim().slice(0, 200))}`);
if (said.includes("busan")) {
  console.log(`PASS — ${model} used the superseded prior value (Busan) from the persona`);
  process.exit(0);
}
console.log(`MISS — ${model} did not surface the prior value (Busan)`);
process.exit(1);
