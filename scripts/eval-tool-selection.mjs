/**
 * eval:tools — a golden tool-SELECTION reliability gate for the local model.
 *
 * tool-calling.md's first-class concern is that the local Qwen "picks the
 * right tool in ONE shot". Unit tests cover schemas/projection statically and
 * smoke:live exercises the full stack (too heavy on a CPU-only box); this is
 * the lean, repeatable middle layer the research recommends — small curated
 * golden datasets (prompt → expected tool, plus negative "no tool" cases) run
 * straight against the real model and scored.
 *
 * Two scenarios:
 *   - "synthetic"  — a hand-crafted capability set (weather/search/math/
 *     reminder) that probes the MODEL's selection ability + the named failure
 *     modes (no-fit, indirect intent, keyword trap, no eager invocation).
 *   - "real-tools" — Muse's ACTUAL built-in @muse/tools definitions, so the
 *     gate proves PRODUCTION tool names/descriptions are one-shot selectable
 *     (tool-calling.md: a tool the model can't reliably call is not delivered).
 *
 * LOCAL OLLAMA ONLY. Skips (exit 0) when Ollama is unreachable. temperature=0
 * for reproducibility; reports a reliability score against a threshold.
 *
 *   pnpm eval:tools                       # qwen3:8b by default
 *   MUSE_EVAL_MODEL=qwen3:8b MUSE_EVAL_THRESHOLD=0.85 pnpm eval:tools
 *   MUSE_EVAL_REPEAT=5 pnpm eval:tools    # run each case 5x; pass only if all pass
 */

import { OllamaProvider } from "../packages/model/dist/index.js";

const MODEL = process.env.MUSE_EVAL_MODEL ?? "qwen3:8b";
const OLLAMA_BASE = (process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434").replace(/\/+$/, "");
const THRESHOLD = Number(process.env.MUSE_EVAL_THRESHOLD ?? "0.85");
// The model is stochastic; one pass isn't proof of reliability. MUSE_EVAL_REPEAT
// runs each case N times and counts it as passed only if EVERY run passes —
// surfacing flaky/borderline selections that a single run would hide.
const REPEAT = Math.max(1, Math.trunc(Number(process.env.MUSE_EVAL_REPEAT ?? "1")));

const SYNTHETIC_TOOLS = [
  { name: "get_weather", description: "Get the current weather for a city. Use when the user asks about weather; do not use otherwise.", inputSchema: { type: "object", properties: { city: { type: "string", description: "City name, e.g. 'Seoul'" } }, required: ["city"] } },
  { name: "web_search", description: "Search the public web for fresh information. Use when the user wants current facts or to look something up online.", inputSchema: { type: "object", properties: { query: { type: "string", description: "Search query, e.g. 'latest TypeScript release'" } }, required: ["query"] } },
  { name: "calculate", description: "Evaluate an arithmetic expression. Use for math; do not use for general questions.", inputSchema: { type: "object", properties: { expression: { type: "string", description: "Arithmetic expression, e.g. '18 * 7'" } }, required: ["expression"] } },
  { name: "set_reminder", description: "Schedule a reminder. Use when the user asks to be reminded of something at a time.", inputSchema: { type: "object", properties: { text: { type: "string", description: "What to be reminded of" }, when: { type: "string", description: "When, e.g. '3pm'" } }, required: ["text", "when"] } }
];

const SYNTHETIC_CASES = [
  { prompt: "What's the weather in Seoul right now?", expectTool: "get_weather", argIncludes: /seoul/i, note: "EN weather" },
  { prompt: "서울 날씨 어때?", expectTool: "get_weather", argIncludes: /seoul|서울/i, note: "KO weather (user's language)" },
  { prompt: "Search the web for the latest TypeScript release notes.", expectTool: "web_search", note: "EN web search" },
  { prompt: "What is 18 times 7?", expectTool: "calculate", note: "EN math (must NOT pick web_search)" },
  { prompt: "Remind me at 3pm to call Sam about the invoice.", expectTool: "set_reminder", note: "EN reminder" },
  { prompt: "오후 3시에 회의 준비하라고 알려줘.", expectTool: "set_reminder", note: "KO reminder" },
  { prompt: "안녕! 오늘 기분 어때?", expectNoTool: true, note: "KO greeting → NO tool (no eager invocation)" },
  { prompt: "Thanks, that was really helpful!", expectNoTool: true, note: "EN thanks → NO tool" },
  { prompt: "고마워, 덕분에 잘됐어.", expectNoTool: true, note: "KO thanks → NO tool" },
  { prompt: "Write a short two-line poem about the autumn sky.", expectNoTool: true, note: "EN pure generation → NO tool (none fits)" },
  { prompt: "I'm in Seoul — do I need an umbrella later today?", expectTool: "get_weather", argIncludes: /seoul/i, note: "EN indirect weather intent" },
  { prompt: "Quick, remind me — what's 25% of 480?", expectTool: "calculate", note: "EN keyword trap: 'remind' word but it's math → calculate" }
];
// NOTE: the missing-required-param failure mode (e.g. "Remind me to call Sam"
// with no time) is NOT asserted here — it's a PARAM-completeness concern, not
// a SELECTION one. set_reminder is the correct tool for a reminder; whether a
// call missing its required `when` should proceed is handled by the runtime's
// required-arg gate (agent-runtime: "blocks a tool call missing a REQUIRED
// argument before the executor runs"), already unit-tested. (Observed: the
// model asks for the time when only set_reminder is exposed, but fires eagerly
// under a larger tool set — the runtime gate, not the model, is the defense.)

// Muse's ACTUAL built-in tools — proves production names/descriptions are
// selectable. Includes the confusable time_now vs time_diff pair on purpose.
async function buildRealScenario() {
  try {
    const data = await import("../packages/tools/dist/muse-tools-data.js");
    const text = await import("../packages/tools/dist/muse-tools-text.js");
    const time = await import("../packages/tools/dist/muse-tools-time.js");
    const now = () => new Date();
    const instances = [
      data.createMathEvalTool(), text.createSlugifyTool(), text.createTextStatsTool(),
      data.createHashTextTool(), time.createTimeNowTool(now), time.createTimeDiffTool()
    ];
    const tools = instances.map((t) => ({ name: t.definition.name, description: t.definition.description, inputSchema: t.definition.inputSchema }));
    const byName = new Set(tools.map((t) => t.name));
    const cases = [
      { prompt: "What is 144 divided by 12?", expectTool: "math_eval", note: "real math" },
      { prompt: "Turn 'My Great Article Title!' into a URL slug.", expectTool: "slugify", note: "real slug" },
      { prompt: "How many words and characters are in 'the quick brown fox'?", expectTool: "text_stats", note: "real count" },
      { prompt: "Give me the SHA-256 hash of the text 'hello'.", expectTool: "hash_text", note: "real hash" },
      { prompt: "What's the current date and time?", expectTool: "time_now", note: "real time-now (vs time_diff)" },
      { prompt: "How many days are between 2026-05-01 and 2026-06-15?", expectTool: "time_diff", note: "real time-diff (vs time_now)" }
    ];
    // Only keep cases whose expected tool actually exists in the built set
    // (guards against a renamed factory silently passing).
    return { label: "real-tools", tools, cases: cases.filter((c) => byName.has(c.expectTool)) };
  } catch (error) {
    return { label: "real-tools", skip: `@muse/tools not built (${error instanceof Error ? error.message : String(error)})`, tools: [], cases: [] };
  }
}

// Stress the confusable real time tools: all 6 exposed together. time_relative
// vs time_diff overlap (relative-to-now vs two-timestamp), so each carries a
// "use when / not when" line — this scenario guards that disambiguation.
async function buildTimeToolsScenario() {
  try {
    const time = await import("../packages/tools/dist/muse-tools-time.js");
    const now = () => new Date();
    const instances = [
      time.createTimeNowTool(now), time.createTimeDiffTool(), time.createTimeAddTool(),
      time.createTimeRelativeTool(now), time.createNextWeekdayTool(now), time.createCronForDatetimeTool()
    ];
    const tools = instances.map((t) => ({ name: t.definition.name, description: t.definition.description, inputSchema: t.definition.inputSchema }));
    const cases = [
      { prompt: "What time is it now?", expectTool: "time_now", note: "now" },
      { prompt: "What day of the week is it right now in Seoul?", expectTool: "time_now", note: "current weekday → time_now, NOT next_weekday_date" },
      { prompt: "How many hours between 9am and 5:30pm today?", expectTool: "time_diff", note: "two-timestamp diff" },
      { prompt: "What is 3 days after 2026-05-26?", expectTool: "time_add", note: "add" },
      { prompt: "How long ago was 2026-05-01 from now?", expectTool: "time_relative", note: "relative-to-now (NOT time_diff)" },
      { prompt: "When is the next Friday?", expectTool: "next_weekday_date", note: "future named weekday → next_weekday_date, NOT time_now" },
      { prompt: "Give me a cron expression for 2026-12-25 08:00.", expectTool: "cron_for_datetime", note: "cron" }
    ];
    return { label: "real-time-tools (confusable set)", tools, cases };
  } catch (error) {
    return { label: "real-time-tools", skip: `@muse/tools not built (${error instanceof Error ? error.message : String(error)})`, tools: [], cases: [] };
  }
}

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
    return toolCalls.length === 0 ? { ok: true, detail: "no tool (correct)" } : { ok: false, detail: `eager call: ${toolCalls.map((c) => c.name).join(",")}` };
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
  const scenarios = [
    { label: "synthetic", tools: SYNTHETIC_TOOLS, cases: SYNTHETIC_CASES },
    await buildRealScenario(),
    await buildTimeToolsScenario()
  ];

  let total = 0;
  let passed = 0;
  for (const scenario of scenarios) {
    if (scenario.skip) { console.log(`\n[${scenario.label}] SKIP — ${scenario.skip}`); continue; }
    console.log(`\n[${scenario.label}] ${scenario.cases.length} cases (tools: ${scenario.tools.map((t) => t.name).join(", ")})`);
    for (const testCase of scenario.cases) {
      total += 1;
      let runsPassed = 0;
      let lastDetail = "";
      for (let run = 0; run < REPEAT; run += 1) {
        let result;
        try {
          const response = await provider.generate({ model: MODEL, messages: [{ role: "user", content: testCase.prompt }], tools: scenario.tools, temperature: 0, maxOutputTokens: 160 });
          result = evaluate(testCase, response.toolCalls ?? []);
        } catch (error) {
          result = { ok: false, detail: `threw: ${error instanceof Error ? error.message : String(error)}` };
        }
        if (result.ok) runsPassed += 1;
        lastDetail = result.detail;
      }
      const ok = runsPassed === REPEAT; // strict: every run must pass
      if (ok) passed += 1;
      const stability = REPEAT > 1 ? ` [${runsPassed}/${REPEAT} runs]` : "";
      console.log(`  ${ok ? "PASS" : "FAIL"}${stability}  [${testCase.note}] ${lastDetail}`);
    }
  }

  const rate = total === 0 ? 0 : passed / total;
  console.log(`\n--- ${passed}/${total} (${(rate * 100).toFixed(0)}%) ; threshold ${(THRESHOLD * 100).toFixed(0)}%`);
  if (total === 0 || rate < THRESHOLD) {
    console.error(`eval:tools FAILED — tool-selection reliability ${(rate * 100).toFixed(0)}% below ${(THRESHOLD * 100).toFixed(0)}%`);
    process.exit(1);
  }
  console.log("eval:tools PASSED");
}

await main();
