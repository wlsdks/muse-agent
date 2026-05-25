/**
 * eval:tools — a golden tool-SELECTION reliability gate for the local model.
 *
 * tool-calling.md's first-class concern is that the local Qwen "picks the
 * right tool in ONE shot". Unit tests cover schemas/projection statically and
 * smoke:live exercises the full stack (too heavy on a CPU-only box); this is
 * the lean, repeatable middle layer the research recommends — a small curated
 * golden dataset (prompt → expected tool, plus negative "no tool" cases) run
 * straight against the real model and scored.
 *
 * LOCAL OLLAMA ONLY (per testing policy). Skips (exit 0) when Ollama is
 * unreachable — a skip is not a pass; it just keeps the gate non-blocking off
 * the loop PC. temperature=0 for reproducibility; reports a reliability score.
 *
 *   pnpm eval:tools                 # qwen3:8b by default
 *   MUSE_EVAL_MODEL=qwen3:8b pnpm eval:tools
 */

import { OllamaProvider } from "../packages/model/dist/index.js";

const MODEL = process.env.MUSE_EVAL_MODEL ?? "qwen3:8b";
const OLLAMA_BASE = (process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434").replace(/\/+$/, "");
// A reliability gate, not a unit test: the model is stochastic, so we require
// a high pass-rate rather than perfection. Tunable via env.
const THRESHOLD = Number(process.env.MUSE_EVAL_THRESHOLD ?? "0.85");

// Small, unambiguous, required-bearing tool set (≤ ~5-7 per tool-calling.md).
const TOOLS = [
  {
    name: "get_weather",
    description: "Get the current weather for a city. Use when the user asks about weather; do not use otherwise.",
    inputSchema: { type: "object", properties: { city: { type: "string", description: "City name, e.g. 'Seoul'" } }, required: ["city"] }
  },
  {
    name: "web_search",
    description: "Search the public web for fresh information. Use when the user wants current facts or to look something up online.",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "Search query, e.g. 'latest TypeScript release'" } }, required: ["query"] }
  },
  {
    name: "calculate",
    description: "Evaluate an arithmetic expression. Use for math; do not use for general questions.",
    inputSchema: { type: "object", properties: { expression: { type: "string", description: "Arithmetic expression, e.g. '18 * 7'" } }, required: ["expression"] }
  },
  {
    name: "set_reminder",
    description: "Schedule a reminder. Use when the user asks to be reminded of something at a time.",
    inputSchema: { type: "object", properties: { text: { type: "string", description: "What to be reminded of" }, when: { type: "string", description: "When, e.g. '3pm'" } }, required: ["text", "when"] }
  }
];

/** @type {Array<{prompt:string, expectTool?:string, argIncludes?:RegExp, expectNoTool?:boolean, note:string}>} */
const CASES = [
  { prompt: "What's the weather in Seoul right now?", expectTool: "get_weather", argIncludes: /seoul/i, note: "EN weather" },
  { prompt: "서울 날씨 어때?", expectTool: "get_weather", argIncludes: /seoul|서울/i, note: "KO weather (user's language)" },
  { prompt: "Search the web for the latest TypeScript release notes.", expectTool: "web_search", note: "EN web search" },
  { prompt: "What is 18 times 7?", expectTool: "calculate", note: "EN math (must NOT pick web_search)" },
  { prompt: "Remind me at 3pm to call Sam about the invoice.", expectTool: "set_reminder", note: "EN reminder" },
  { prompt: "오후 3시에 회의 준비하라고 알려줘.", expectTool: "set_reminder", note: "KO reminder" },
  { prompt: "안녕! 오늘 기분 어때?", expectNoTool: true, note: "KO greeting → NO tool (no eager invocation)" },
  { prompt: "Thanks, that was really helpful!", expectNoTool: true, note: "EN thanks → NO tool" },
  { prompt: "고마워, 덕분에 잘됐어.", expectNoTool: true, note: "KO thanks → NO tool" }
];

async function ollamaReachable() {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return false;
    const body = await res.json();
    return (body?.models ?? []).some((m) => typeof m?.name === "string" && m.name.includes(MODEL.replace(/^ollama\//, "")));
  } catch {
    return false;
  }
}

function evaluate(testCase, toolCalls) {
  if (testCase.expectNoTool) {
    return toolCalls.length === 0
      ? { ok: true, detail: "no tool (correct)" }
      : { ok: false, detail: `eager call: ${toolCalls.map((c) => c.name).join(",")}` };
  }
  const call = toolCalls[0];
  if (!call) return { ok: false, detail: "no tool selected (expected one)" };
  if (call.name !== testCase.expectTool) return { ok: false, detail: `picked ${call.name}, wanted ${testCase.expectTool}` };
  if (testCase.argIncludes && !testCase.argIncludes.test(JSON.stringify(call.arguments ?? {}))) {
    return { ok: false, detail: `args ${JSON.stringify(call.arguments)} miss ${testCase.argIncludes}` };
  }
  return { ok: true, detail: `${call.name}(${JSON.stringify(call.arguments ?? {})})` };
}

async function main() {
  if (!(await ollamaReachable())) {
    console.log(`eval:tools skipped — Ollama (${OLLAMA_BASE}) or model ${MODEL} unreachable. Start \`ollama serve\` with ${MODEL}.`);
    return;
  }
  const provider = new OllamaProvider({ defaultModel: MODEL });
  console.log(`eval:tools — model=${MODEL}, ${CASES.length} cases, threshold=${(THRESHOLD * 100).toFixed(0)}%\n`);

  let passed = 0;
  for (const testCase of CASES) {
    let result;
    try {
      const response = await provider.generate({
        model: MODEL,
        messages: [{ role: "user", content: testCase.prompt }],
        tools: TOOLS,
        temperature: 0,
        maxOutputTokens: 160
      });
      result = evaluate(testCase, response.toolCalls ?? []);
    } catch (error) {
      result = { ok: false, detail: `threw: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (result.ok) passed += 1;
    console.log(`  ${result.ok ? "PASS" : "FAIL"}  [${testCase.note}] ${result.detail}`);
  }

  const rate = passed / CASES.length;
  console.log(`\n--- ${passed}/${CASES.length} (${(rate * 100).toFixed(0)}%) ; threshold ${(THRESHOLD * 100).toFixed(0)}%`);
  if (rate < THRESHOLD) {
    console.error(`eval:tools FAILED — tool-selection reliability ${(rate * 100).toFixed(0)}% below ${(THRESHOLD * 100).toFixed(0)}%`);
    process.exit(1);
  }
  console.log("eval:tools PASSED");
}

await main();
