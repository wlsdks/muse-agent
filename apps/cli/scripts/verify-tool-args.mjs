/**
 * Live tool-ARGUMENT-quality battery on local Qwen — selection is solid
 * (verify-tool-battery), this checks the NEXT layer: when the model calls a
 * write tool, does it FILL the required args with the right content (a tool
 * called with an empty/wrong title or no time is a failed action). Captures the
 * tool-call arguments at the approval gate and DENIES (no real write), then
 * asserts the key required arg is populated sensibly.
 *
 *   node apps/cli/scripts/verify-tool-args.mjs            (qwen3:8b)
 *
 * Exit 0 if every case fills its key args, 1 otherwise. LOCAL OLLAMA QWEN ONLY.
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createMuseRuntimeAssembly } from "@muse/autoconfigure";

const model = process.argv[2] ?? "ollama/qwen3:8b";
if (!model.startsWith("ollama/")) { console.error("LOCAL OLLAMA QWEN ONLY"); process.exit(2); }
process.env.HOME = mkdtempSync(path.join(os.tmpdir(), "muse-ta-"));
process.env.MUSE_DEFAULT_MODEL = model;
process.env.MUSE_HOMEASSISTANT_URL = "http://x";
process.env.MUSE_HOMEASSISTANT_TOKEN = "t";

const asm = createMuseRuntimeAssembly();
if (!asm.agentRuntime) { console.error("no agentRuntime"); process.exit(2); }
const SYSTEM = "You are Muse, the user's personal assistant. When the user asks you to do something a tool can handle, call the matching tool with fully-populated arguments.";

async function callArgs(prompt) {
  const calls = [];
  for await (const ev of asm.agentRuntime.stream({
    messages: [{ role: "system", content: SYSTEM }, { role: "user", content: prompt }],
    metadata: { localMode: true, userId: "ta" },
    model,
    // capture the args, then DENY so nothing actually writes
    toolApprovalGate: async ({ toolCall }) => { if (toolCall?.name) calls.push({ name: toolCall.name, args: toolCall.arguments ?? {} }); return { allowed: false }; }
  })) { /* drain */ }
  return calls;
}

// check(args) → true when the key args are sensibly filled.
const cases = [
  { prompt: "add a task to buy milk tomorrow", tool: "muse.tasks.add", check: (a) => /milk/i.test(String(a.title ?? "")) },
  // reminders.add: text + dueAt filled, and NO fabricated `via` (slice 55 removed
  // it from the schema; native structured output should keep the model from
  // inventing a delivery destination).
  { prompt: "remind me to call mom at 6pm", tool: "muse.reminders.add", check: (a) => /mom|call/i.test(String(a.text ?? "")) && Boolean(a.dueAt) && a.via === undefined },
  { prompt: "add a meeting with Sam this friday at 3pm", tool: "muse.calendar.add", check: (a) => String(a.title ?? "").length > 0 && Boolean(a.startsAtIso) },
  { prompt: "save a note that the standup moved to friday", tool: "muse.notes.save", check: (a) => /friday|standup|moved/i.test(String(a.content ?? "")) && String(a.path ?? "").length > 0 }
];

let failures = 0;
for (const c of cases) {
  const calls = await callArgs(c.prompt);
  const call = calls.find((x) => x.name === c.tool);
  const ok = Boolean(call) && c.check(call.args);
  console.log(`${ok ? "PASS" : "FAIL"} — ${JSON.stringify(c.prompt)} → ${call ? `${call.name} ${JSON.stringify(call.args).slice(0, 160)}` : `(tool ${c.tool} not called; got ${JSON.stringify(calls.map((x) => x.name))})`}`);
  if (!ok) failures += 1;
}
console.log(failures === 0 ? `\nALL PASS (${cases.length}) — args filled on ${model}` : `\n${failures}/${cases.length} FAILED on ${model}`);
process.exit(failures === 0 ? 0 : 1);
