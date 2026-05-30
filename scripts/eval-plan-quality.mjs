/**
 * eval:plan-quality — a live PlanQuality battery for the local model.
 *
 * DeepEval's agent metrics split into ToolCorrectness / ArgumentCorrectness /
 * PlanAdherence / StepEfficiency / TaskCompletion — all already covered by
 * eval:tools (selection + args), the trajectory test (adherence + redundancy),
 * and the terminal-state tests (completion). The one DIMENSION not yet measured
 * on the live model is PLAN QUALITY: given a multi-step goal + a tool set and
 * Muse's REAL planning prompt (buildPlanningSystemPrompt), does qwen3:8b emit a
 * plan that is VALID (every step names an available tool), COMPLETE (covers the
 * tools the goal needs), ORDERED (the dependency order holds), and EFFICIENT (no
 * redundant repeat, no padding)? This battery drives the real planning path +
 * parsePlan and scores those four properties deterministically.
 *
 * LOCAL OLLAMA ONLY. Skips (exit 0) when Ollama is unreachable. temperature=0.
 *
 *   pnpm eval:plan-quality
 *   MUSE_EVAL_REPEAT=3 pnpm eval:plan-quality
 */

import { OllamaProvider } from "../packages/model/dist/index.js";
import { buildPlanningSystemPrompt } from "../packages/prompts/dist/index.js";
import { parsePlan } from "../packages/agent-core/dist/index.js";
import { runEvalSuite } from "./eval-harness.mjs";

const MODEL = process.env.MUSE_EVAL_MODEL ?? "qwen3:8b";
const OLLAMA_BASE = (process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434").replace(/\/+$/, "");
const THRESHOLD = Number(process.env.MUSE_EVAL_THRESHOLD ?? "0.85");
const REPEAT = Math.max(1, Math.trunc(Number(process.env.MUSE_EVAL_REPEAT ?? "1")));

const TOOLS = [
  { name: "get_weather", description: "Get the current weather for a city. Use when the user asks about weather." },
  { name: "set_reminder", description: "Schedule a reminder for a time. Use when the user asks to be reminded of something." },
  { name: "web_search", description: "Search the public web for fresh facts or current numbers." },
  { name: "calculate", description: "Evaluate an arithmetic expression." }
];
const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));
const toolDescriptions = TOOLS.map((t) => `- ${t.name}: ${t.description}`).join("\n");

// Each goal needs exactly these tools, in this dependency order.
const CASES = [
  { prompt: "Check the weather in Seoul, then set a reminder at 8am to bring an umbrella.", expect: ["get_weather", "set_reminder"], note: "weather → reminder (EN)" },
  { prompt: "Look up the weather in Tokyo, then remind me at 7pm to pack accordingly.", expect: ["get_weather", "set_reminder"], note: "weather → reminder (EN, paraphrase)" },
  { prompt: "Find the population of France online, then calculate 12% of it.", expect: ["web_search", "calculate"], note: "web_search → calculate (dependency order)" },
  { prompt: "What's the weather in Busan? Also remind me tomorrow at 9am to water the plants.", expect: ["get_weather", "set_reminder"], note: "weather + reminder (compound)" },
  { prompt: "Search the web for Tokyo's current temperature in Celsius, calculate the Fahrenheit equivalent, then remind me at 6pm of the result.", expect: ["web_search", "calculate", "set_reminder"], note: "3-step dependency chain (web_search → calculate → set_reminder)" },
  { prompt: "서울 날씨 확인하고, 오후 6시에 우산 챙기라고 알려줘.", expect: ["get_weather", "set_reminder"], note: "KO 2-step (weather → reminder)" },
  { prompt: "도쿄의 현재 기온을 웹에서 섭씨로 찾아서, 화씨로 변환한 다음, 오후 6시에 결과를 알려줘.", expect: ["web_search", "calculate", "set_reminder"], note: "KO 3-step dependency chain (web_search → calculate → set_reminder); user's language; STABLE 3/3" },
  { prompt: "What is 18% of 240?", expect: ["calculate"], note: "single-tool goal — no padding (exactly calculate)" },
  { prompt: "Write me a short two-line poem about the autumn sky.", expect: [], note: "pure generation — the plan must be EMPTY (no over-tooling)" },
  { prompt: "가을 하늘에 대한 짧은 두 줄짜리 시를 써줘.", expect: [], note: "KO pure generation — the plan must be EMPTY (no over-tooling in the user's language); STABLE 3/3" }
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

// PlanQuality scorer: VALID ∧ COMPLETE ∧ ORDERED ∧ EFFICIENT.
function scorePlanQuality(plan, testCase) {
  if (plan === null) return { ok: false, detail: "PARSE-FAIL (no plan extracted)" };
  const tools = plan.map((s) => s.tool);
  // VALID — every step names an available tool
  const invalid = tools.find((t) => !TOOL_NAMES.has(t));
  if (invalid) return { ok: false, detail: `invalid tool '${invalid}' (not available)` };
  // COMPLETE — every required tool is present
  const missing = testCase.expect.find((t) => !tools.includes(t));
  if (missing) return { ok: false, detail: `incomplete: missing '${missing}' (got ${JSON.stringify(tools)})` };
  // EFFICIENT — no redundant repeat, no padding beyond one optional extra step
  const seen = new Set();
  for (const s of plan) {
    const key = `${s.tool}::${JSON.stringify(s.args ?? {})}`;
    if (seen.has(key)) return { ok: false, detail: `redundant repeat of ${s.tool}` };
    seen.add(key);
  }
  // Padding bound: a tool goal may carry ONE optional helper step; a pure-
  // generation goal (expect: []) must plan ZERO tools — any tool is over-tooling.
  const padAllowance = testCase.expect.length === 0 ? 0 : 1;
  if (plan.length > testCase.expect.length + padAllowance) return { ok: false, detail: `over-tooled: ${plan.length} steps for a ${testCase.expect.length}-tool goal (${JSON.stringify(tools)})` };
  // ORDERED — the required tools appear in dependency order (subsequence match)
  let idx = 0;
  for (const t of tools) {
    if (t === testCase.expect[idx]) idx += 1;
  }
  if (idx < testCase.expect.length) return { ok: false, detail: `out of order: ${JSON.stringify(tools)} vs expected ${JSON.stringify(testCase.expect)}` };
  return { ok: true, detail: `valid+complete+ordered+efficient ${JSON.stringify(tools)}` };
}

async function main() {
  if (!(await ollamaReachable())) {
    console.log(`eval:plan-quality skipped — Ollama (${OLLAMA_BASE}) or model ${MODEL} unreachable.`);
    return;
  }
  const provider = new OllamaProvider({ defaultModel: MODEL });
  const solve = async (testCase) => {
    const sys = buildPlanningSystemPrompt({ toolDescriptions, userPrompt: testCase.prompt });
    // Generous maxOutputTokens: a 2-step plan's JSON must not truncate mid-array
    // (a cut-off array is unparseable and would read as a planning failure).
    const res = await provider.generate({
      model: MODEL,
      messages: [{ role: "system", content: sys }, { role: "user", content: testCase.prompt }],
      temperature: 0,
      maxOutputTokens: 700
    });
    return parsePlan(res.output ?? "");
  };
  const scenarios = [{ label: "plan-quality (multi-step goals)", tools: TOOLS, cases: CASES }];
  const { gate } = await runEvalSuite({ name: "eval:plan-quality", repeat: REPEAT, scenarios, score: scorePlanQuality, solve, threshold: THRESHOLD });
  if (!gate) process.exit(1);
}

await main();
