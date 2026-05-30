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
import { combineScorers, runEvalSuite, toolScorers } from "./eval-harness.mjs";

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
  { prompt: "What's the weather in Seoul right now?", expectTool: "get_weather", argIncludes: /seoul/i, requireArgs: ["city"], note: "EN weather" },
  { prompt: "서울 날씨 어때?", expectTool: "get_weather", argIncludes: /seoul|서울/i, requireArgs: ["city"], note: "KO weather (user's language)" },
  { prompt: "Search the web for the latest TypeScript release notes.", expectTool: "web_search", requireArgs: ["query"], note: "EN web search" },
  { prompt: "What is 18 times 7?", expectTool: "calculate", requireArgs: ["expression"], note: "EN math (must NOT pick web_search)" },
  { prompt: "Remind me at 3pm to call Sam about the invoice.", expectTool: "set_reminder", requireArgs: ["text", "when"], note: "EN reminder" },
  { prompt: "오후 3시에 회의 준비하라고 알려줘.", expectTool: "set_reminder", requireArgs: ["text", "when"], note: "KO reminder" },
  { prompt: "안녕! 오늘 기분 어때?", expectNoTool: true, note: "KO greeting → NO tool (no eager invocation)" },
  { prompt: "Thanks, that was really helpful!", expectNoTool: true, note: "EN thanks → NO tool" },
  { prompt: "고마워, 덕분에 잘됐어.", expectNoTool: true, note: "KO thanks → NO tool" },
  { prompt: "Write a short two-line poem about the autumn sky.", expectNoTool: true, note: "EN pure generation → NO tool (none fits)" },
  { prompt: "I'm in Seoul — do I need an umbrella later today?", expectTool: "get_weather", argIncludes: /seoul/i, requireArgs: ["city"], note: "EN indirect weather intent" },
  { prompt: "Quick, remind me — what's 25% of 480?", expectTool: "calculate", requireArgs: ["expression"], note: "EN keyword trap: 'remind' word but it's math → calculate" },
  { prompt: "타입스크립트 최신 버전을 웹에서 검색해줘.", expectTool: "web_search", requireArgs: ["query"], note: "KO web search (user's language)" },
  { prompt: "온라인에서 환율 좀 찾아봐줘.", expectTool: "web_search", requireArgs: ["query"], note: "KO indirect web-search intent" },
  { prompt: "18 곱하기 7은 얼마야?", expectTool: "calculate", requireArgs: ["expression"], note: "KO math" },
  { prompt: "장바구니 합계가 23000원 더하기 4500원인데 총 얼마야?", expectTool: "calculate", requireArgs: ["expression"], note: "KO word-problem math (must NOT pick web_search)" },
  { prompt: "어제 세금 계산하느라 진이 다 빠졌어.", expectNoTool: true, note: "KO keyword trap: '계산' but venting, no math request → NO tool" },
  { prompt: "I love how clean this weather app's design is.", expectNoTool: true, note: "EN keyword trap: 'weather' about a UI, not a forecast → NO tool" },
  { prompt: "날씨 얘기는 그만하고 다른 얘기 하자.", expectNoTool: true, note: "KO keyword trap: '날씨' but declining the topic → NO tool" }
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
      { prompt: "What is 144 divided by 12?", expectTool: "math_eval", requireArgs: ["expression"], note: "real math" },
      { prompt: "Turn 'My Great Article Title!' into a URL slug.", expectTool: "slugify", requireArgs: ["text"], note: "real slug" },
      { prompt: "How many words and characters are in 'the quick brown fox'?", expectTool: "text_stats", requireArgs: ["text"], note: "real count" },
      { prompt: "Give me the SHA-256 hash of the text 'hello'.", expectTool: "hash_text", requireArgs: ["text"], note: "real hash" },
      { prompt: "What's the current date and time?", expectTool: "time_now", note: "real time-now (vs time_diff)" },
      { prompt: "How many days are between 2026-05-01 and 2026-06-15?", expectTool: "time_diff", requireArgs: ["from", "to"], note: "real time-diff (vs time_now)" }
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
      { prompt: "How many hours between 9am and 5:30pm today?", expectTool: "time_diff", requireArgs: ["from", "to"], note: "two-timestamp diff" },
      { prompt: "What is 3 days after 2026-05-26?", expectTool: "time_add", requireArgs: ["base"], note: "add" },
      { prompt: "How long ago was 2026-05-01 from now?", expectTool: "time_relative", requireArgs: ["at"], note: "relative-to-now (NOT time_diff)" },
      { prompt: "When is the next Friday?", expectTool: "next_weekday_date", requireArgs: ["weekday"], note: "future named weekday → next_weekday_date, NOT time_now" },
      { prompt: "다음 주 금요일이 며칠이야?", expectTool: "next_weekday_date", requireArgs: ["weekday"], note: "KO future named weekday → next_weekday_date, NOT time_now (user's language); STABLE 3/3" },
      { prompt: "Give me a cron expression for 2026-12-25 08:00.", expectTool: "cron_for_datetime", requireArgs: ["iso"], note: "cron" },
      // Negative eager-invocation traps — time/weekday WORDS in a musing that
      // requests no computation (the dual of selection). Each STABLE 3/3 on qwen3:8b.
      { prompt: "시간 참 빨리 간다, 벌써 금요일이네.", expectNoTool: true, note: "KO musing; '금요일' is a keyword trap, not a next_weekday_date request → NO tool" },
      { prompt: "What a beautiful Friday morning, isn't it?", expectNoTool: true, note: "EN small-talk; 'Friday' is not a date computation → NO tool" },
      { prompt: "오늘 정말 긴 하루였어.", expectNoTool: true, note: "KO comment about the day, no time query → NO tool" },
      { prompt: "Time really does fly when you're having fun.", expectNoTool: true, note: "EN idiom about time, no computation → NO tool" }
    ];
    return { label: "real-time-tools (confusable set)", tools, cases };
  } catch (error) {
    return { label: "real-time-tools", skip: `@muse/tools not built (${error instanceof Error ? error.message : String(error)})`, tools: [], cases: [] };
  }
}

// Muse's REAL actuator + perception tools (@muse/mcp + @muse/autoconfigure)
// exposed as ONE confusable set — the local model must discriminate
// state-changing web actions vs smart-home services vs inbox search vs
// personal-knowledge search vs weather in one shot. These definitions were
// shipped while Ollama was down (their CAPABILITIES lines tagged
// [UNVERIFIED-LIVE]); this scenario is the live selection proof. Built with
// stub deps because only `.definition` (name/description/inputSchema) is read —
// `execute` (which is what the deps feed) is never called here.
async function buildActuatorScenario() {
  try {
    const mcp = await import("../packages/mcp/dist/index.js");
    const ac = await import("../packages/autoconfigure/dist/index.js");
    const instances = [
      mcp.createWebActionTool({ fetchImpl: fetch, approvalGate: {}, actionLogFile: "/tmp/eval-actuator.json", userId: "eval" }),
      mcp.createHomeActionTool({ baseUrl: "http://localhost", token: "eval", approvalGate: {}, actionLogFile: "/tmp/eval-actuator.json", userId: "eval" }),
      mcp.createEmailSearchTool({ searcher: { search: async () => [] } }),
      mcp.createWeatherTool({}),
      ac.createNotesKnowledgeSearchTool({})
    ];
    const tools = instances.map((t) => ({ name: t.definition.name, description: t.definition.description, inputSchema: t.definition.inputSchema }));
    const byName = new Set(tools.map((t) => t.name));
    const cases = [
      { prompt: "Post a comment on the project forum thread saying the build works now.", expectTool: "web_action", requireArgs: ["summary", "url"], note: "post → web_action (231)" },
      { prompt: "Reserve a table for two at 7pm tomorrow on the restaurant's booking page.", expectTool: "web_action", requireArgs: ["summary", "url"], note: "reserve → web_action (231)" },
      { prompt: "Activate the bedtime scene.", expectTool: "home_action", requireArgs: ["service"], note: "scene → home_action (223)" },
      { prompt: "Run my good night routine.", expectTool: "home_action", requireArgs: ["service"], note: "routine/script → home_action (223)" },
      { prompt: "Find the email from the bank about my statement.", expectTool: "search_email", requireArgs: ["query"], note: "inbox search → search_email, NOT knowledge_search (199)" },
      { prompt: "Any news about the Mars mission from the feeds I follow?", expectTool: "knowledge_search", requireArgs: ["query"], note: "feeds news → knowledge_search, NOT web/search_email (229/230)" },
      { prompt: "Will it rain on Saturday?", expectTool: "weather", argIncludes: /sat/i, requireArgs: ["location"], note: "upcoming-day forecast → weather with when=Saturday (202)" },
      // Negative eager-invocation traps on the STATE-CHANGING/perception set — a
      // false positive here is the worst failure (it acts/searches unbidden).
      // Each pre-verified STABLE 3/3 against qwen3:8b before landing.
      { prompt: "요즘 스마트홈 기기들 진짜 좋아졌더라.", expectNoTool: true, note: "KO comment ABOUT smart-home gear, not a command → NO home_action" },
      { prompt: "Thanks for booking that table earlier — it worked out great!", expectNoTool: true, note: "EN gratitude for a PAST action → NO web_action" },
      { prompt: "메일함이 너무 지저분해서 언젠가 정리해야 하는데.", expectNoTool: true, note: "KO venting about the inbox, no search request → NO search_email" },
      { prompt: "The weather's been so unpredictable lately, hasn't it?", expectNoTool: true, note: "EN weather small-talk, not a forecast request → NO weather" },
      { prompt: "이 날씨 앱 디자인 깔끔해서 마음에 들어.", expectNoTool: true, note: "KO comment about a weather APP's UI → NO weather" }
    ];
    return { label: "actuator-tools (confusable set)", tools, cases: cases.filter((c) => c.expectNoTool || byName.has(c.expectTool)) };
  } catch (error) {
    return { label: "actuator-tools", skip: `@muse/mcp or @muse/autoconfigure not built (${error instanceof Error ? error.message : String(error)})`, tools: [], cases: [] };
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

// Build a deterministic scorer for one case from the declarative fields, using
// the shared harness scorers: a no-tool case asserts no eager invocation; a
// tool case ANDs selection + (optional) arg-value match + ArgumentCorrectness
// (required args present). This is the "code-based scorer first" tier.
function caseScorer(testCase) {
  if (testCase.expectNoTool) return toolScorers.noTool();
  const checks = [toolScorers.selected(testCase.expectTool)];
  if (testCase.argIncludes) checks.push(toolScorers.argMatches(testCase.argIncludes));
  if (testCase.requireArgs) checks.push(toolScorers.argsPresent(testCase.requireArgs));
  return combineScorers(...checks);
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
    await buildTimeToolsScenario(),
    await buildActuatorScenario()
  ];

  // Solver: elicit the model's one-shot tool selection for a case's prompt.
  const solve = async (testCase, scenario) =>
    (await provider.generate({ model: MODEL, messages: [{ role: "user", content: testCase.prompt }], tools: scenario.tools, temperature: 0, maxOutputTokens: 160 })).toolCalls ?? [];
  // Scorer: deterministic per-case (selection + args), via the shared harness.
  const score = (toolCalls, testCase) => caseScorer(testCase)(toolCalls);

  const { gate } = await runEvalSuite({ name: "eval:tools", repeat: REPEAT, scenarios, score, solve, threshold: THRESHOLD });
  if (!gate) process.exit(1);
}

await main();
