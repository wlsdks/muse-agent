/**
 * Diverse tool-selection battery on local Qwen — stress one-shot selection
 * across EN / KO / casual(no-tool) prompts to SURFACE weaknesses (the data that
 * picks the next direction). Each case asserts the model called the expected
 * tool, or NO tool for greetings/casual.
 *
 *   node apps/cli/scripts/verify-tool-battery.mjs            (qwen3:8b)
 *
 * Exit 0 if every case passes, 1 otherwise. LOCAL OLLAMA ONLY.
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createMuseRuntimeAssembly } from "@muse/autoconfigure";

const model = process.argv[2] ?? "ollama/gemma4:12b";
if (!model.startsWith("ollama/")) { console.error("LOCAL OLLAMA ONLY"); process.exit(2); }
process.env.HOME = mkdtempSync(path.join(os.tmpdir(), "muse-tb-"));
process.env.MUSE_DEFAULT_MODEL = model;
process.env.MUSE_HOMEASSISTANT_URL = "http://x";
process.env.MUSE_HOMEASSISTANT_TOKEN = "t";

const asm = createMuseRuntimeAssembly();
if (!asm.agentRuntime) { console.error("no agentRuntime"); process.exit(2); }

// The real chat path always frames the turn with a persona/agent system prompt;
// a bare user message under-prompts tool use. Mirror that framing here.
const SYSTEM = "You are Muse, the user's personal assistant. When the user asks you to do something a tool can handle, call the matching tool. For a greeting or casual remark with no task, just reply — do not call a tool.";

async function picked(prompt) {
  const tools = [];
  for await (const ev of asm.agentRuntime.stream({
    messages: [{ role: "system", content: SYSTEM }, { role: "user", content: prompt }],
    metadata: { localMode: true, userId: "tb" },
    model,
    toolApprovalGate: async ({ toolCall }) => { if (toolCall?.name) tools.push(toolCall.name); return { allowed: true }; }
  })) {
    if (ev.type === "tool-call-started" && ev.name) tools.push(ev.name);
  }
  return [...new Set(tools)];
}

// expect: a substring the chosen tool name should contain, or "" = NO tool.
const cases = [
  { prompt: "remember my dentist is Dr. Kim", expect: "remember" },
  { prompt: "what's the weather in Busan?", expect: "weather" },
  { prompt: "부산 날씨 어때?", expect: "weather" },
  { prompt: "lock the front door", expect: "home" },
  { prompt: "내 할 일 목록 보여줘", expect: "task" },
  { prompt: "add a task to buy milk", expect: "task" },
  { prompt: "save a note: meeting moved to friday", expect: "note" },
  { prompt: "add a meeting friday at 3pm", expect: "calendar" },
  // Explicit recall-search intent (a vague "what did we discuss?" reads as a
  // question the small model answers directly rather than a search command).
  { prompt: "search my past sessions for what I said about the budget", expect: "episode" },
  { prompt: "check my inbox", expect: "messaging" },
  { prompt: "summarize this page https://example.com/post", expect: "web.read" },
  { prompt: "hello there!", expect: "" },
  { prompt: "고마워 ㅎㅎ", expect: "" }
];

let failures = 0;
for (const c of cases) {
  const tools = await picked(c.prompt);
  const ok = c.expect === ""
    ? tools.length === 0
    : tools.some((t) => t.toLowerCase().includes(c.expect));
  console.log(`${ok ? "PASS" : "FAIL"} — ${JSON.stringify(c.prompt)} → ${JSON.stringify(tools)} (want ${c.expect === "" ? "NO tool" : c.expect})`);
  if (!ok) failures += 1;
}
console.log(failures === 0 ? `\nALL PASS (${cases.length}) on ${model}` : `\n${failures}/${cases.length} FAILED on ${model}`);
process.exit(failures === 0 ? 0 : 1);
