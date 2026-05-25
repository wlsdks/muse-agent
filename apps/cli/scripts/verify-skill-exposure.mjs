/**
 * FAST live check on local Qwen — does the per-turn skill exposure (ITR) work?
 * A skill relevant to the prompt must have its BODY injected (model follows the
 * instruction); an irrelevant prompt must withhold the body (model can't follow
 * an instruction it never saw). Proves the token-savings change didn't break
 * skill-following AND that withholding actually withholds. ~1 minute.
 *
 *   node apps/cli/scripts/verify-skill-exposure.mjs            (qwen3:8b)
 *
 * Exit 0 = both pass, 1 = a miss, 2 = setup error. LOCAL OLLAMA QWEN ONLY.
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createMuseRuntimeAssembly } from "@muse/autoconfigure";

const model = process.argv[2] ?? "ollama/qwen3:8b";
if (!model.startsWith("ollama/")) { console.error("LOCAL OLLAMA QWEN ONLY"); process.exit(2); }
process.env.HOME = mkdtempSync(path.join(os.tmpdir(), "muse-skill-"));
process.env.MUSE_DEFAULT_MODEL = model;

const { buildSkillsPrompt } = await import("../dist/chat-skills.js");

const skills = [{
  name: "cat-mode",
  description: "Use when the user asks about cats.",
  body: "IMPORTANT: end every reply with the exact word BANANA on its own line.",
  frontmatter: {}, sourceInfo: {}
}];

const asm = createMuseRuntimeAssembly();
if (!asm.agentRuntime) { console.error("no agentRuntime"); process.exit(2); }

async function ask(prompt, userId) {
  const system = `You are Muse, a helpful assistant.${buildSkillsPrompt(skills, prompt)}`;
  let text = "";
  for await (const ev of asm.agentRuntime.stream({
    messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
    metadata: { localMode: true, userId },
    model
  })) {
    if (ev.type === "text-delta" && ev.text) text += ev.text;
  }
  return text;
}

let failures = 0;

// Relevant: "cats" matches the skill → body injected → model follows it.
const a = await ask("Tell me one short fact about cats.", "verify-pos");
const okGrounded = /banana/i.test(a);
console.log(`${okGrounded ? "PASS" : "FAIL"} — relevant skill body followed: ${JSON.stringify(a.trim().slice(0, 160))}`);
if (!okGrounded) failures += 1;

// Irrelevant: no "cat" overlap → body withheld → model never saw the rule.
const b = await ask("Tell me one short fact about airplanes.", "verify-neg");
const okWithheld = !/banana/i.test(b);
console.log(`${okWithheld ? "PASS" : "FAIL"} — irrelevant body withheld (no BANANA): ${JSON.stringify(b.trim().slice(0, 160))}`);
if (!okWithheld) failures += 1;

console.log(failures === 0 ? `\nALL PASS (2) on ${model}` : `\n${failures}/2 FAILED on ${model}`);
process.exit(failures === 0 ? 0 : 1);
