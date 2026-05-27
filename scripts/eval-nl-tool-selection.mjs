/**
 * eval:tools:nl — compare NATIVE (Hermes JSON tool-call) vs NATURAL-LANGUAGE
 * tool selection on Muse's confusable time-tool set (Natural Language Tools,
 * arXiv 2510.14453: stating the tool choice in prose + parsing it
 * deterministically beats forcing JSON on small/open-weight models).
 *
 * For each golden prompt it runs BOTH paths against the local Qwen and scores
 * one-shot selection accuracy, so we can see whether the NL path is worth
 * wiring as an option. LOCAL OLLAMA ONLY; skips (exit 0) when unreachable.
 *
 *   pnpm eval:tools:nl
 *   MUSE_EVAL_MODEL=qwen3:8b MUSE_EVAL_REPEAT=3 pnpm eval:tools:nl
 */

import { OllamaProvider } from "../packages/model/dist/index.js";
import { parseNaturalLanguageToolSelection } from "../packages/tools/dist/nl-tool-selection.js";

const MODEL = process.env.MUSE_EVAL_MODEL ?? "qwen3:8b";
const OLLAMA_BASE = (process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434").replace(/\/+$/, "");
const REPEAT = Math.max(1, Math.trunc(Number(process.env.MUSE_EVAL_REPEAT ?? "1")));

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

async function buildTimeTools() {
  const time = await import("../packages/tools/dist/muse-tools-time.js");
  const now = () => new Date();
  const instances = [
    time.createTimeNowTool(now), time.createTimeDiffTool(), time.createTimeAddTool(),
    time.createTimeRelativeTool(now), time.createNextWeekdayTool(now), time.createCronForDatetimeTool()
  ];
  return instances.map((t) => ({ name: t.definition.name, description: t.definition.description, inputSchema: t.definition.inputSchema }));
}

const CASES = [
  { prompt: "What time is it now?", expect: "time_now" },
  { prompt: "What day of the week is it right now in Seoul?", expect: "time_now" },
  { prompt: "How many hours between 9am and 5:30pm today?", expect: "time_diff" },
  { prompt: "What is 3 days after 2026-05-26?", expect: "time_add" },
  { prompt: "How long ago was 2026-05-01 from now?", expect: "time_relative" },
  { prompt: "When is the next Friday?", expect: "next_weekday_date" },
  { prompt: "Give me a cron expression for 2026-12-25 08:00.", expect: "cron_for_datetime" }
];

function nlPrompt(tools, userPrompt) {
  const list = tools.map((t) => `- ${t.name}: ${t.description}`).join("\n");
  return `You can use ONE of these tools, or none:\n${list}\n\nUser said: "${userPrompt}"\n\nWhich single tool best handles it? Answer with ONLY the tool name, or "none". Then a brief reason.`;
}

async function main() {
  if (!(await ollamaReachable())) {
    console.log(`eval:tools:nl skipped — Ollama (${OLLAMA_BASE}) or model ${MODEL} unreachable.`);
    return;
  }
  const provider = new OllamaProvider({ defaultModel: MODEL });
  const tools = await buildTimeTools();
  const names = tools.map((t) => t.name);
  let nativePass = 0;
  let nlPass = 0;
  let total = 0;

  for (const c of CASES) {
    let nativeOk = 0;
    let nlOk = 0;
    for (let r = 0; r < REPEAT; r += 1) {
      try {
        const nativeResp = await provider.generate({ model: MODEL, messages: [{ role: "user", content: c.prompt }], tools, temperature: 0, maxOutputTokens: 160 });
        if ((nativeResp.toolCalls ?? [])[0]?.name === c.expect) nativeOk += 1;
      } catch { /* miss */ }
      try {
        const nlResp = await provider.generate({ model: MODEL, messages: [{ role: "user", content: nlPrompt(tools, c.prompt) }], temperature: 0, maxOutputTokens: 120 });
        if (parseNaturalLanguageToolSelection(nlResp.output ?? "", names).tool === c.expect) nlOk += 1;
      } catch { /* miss */ }
    }
    total += 1;
    const nativeWin = nativeOk === REPEAT;
    const nlWin = nlOk === REPEAT;
    if (nativeWin) nativePass += 1;
    if (nlWin) nlPass += 1;
    console.log(`  ${c.expect.padEnd(18)} native ${nativeWin ? "PASS" : "FAIL"} (${nativeOk}/${REPEAT})  |  NL ${nlWin ? "PASS" : "FAIL"} (${nlOk}/${REPEAT})  — "${c.prompt}"`);
  }
  console.log(`\nnative: ${nativePass}/${total} (${((nativePass / total) * 100).toFixed(0)}%)   NL: ${nlPass}/${total} (${((nlPass / total) * 100).toFixed(0)}%)   model ${MODEL}, repeat ${REPEAT}`);
}

await main();
