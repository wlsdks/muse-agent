/**
 * eval:flow-draft — live gate for the "코파일럿 초안" (describe → draft) LLM
 * path (`POST /api/flows/draft`). Calls the EXACT prompt-building / parsing
 * pipeline the route uses (`flows-draft-compile.ts`, incl. the same
 * one-shot repair retry) directly against the local model via
 * `OllamaProvider`, bypassing the HTTP server — lean and fast, per
 * agent-testing.md's rule that an LLM-facing capability ships with a live
 * gate, not just a unit test of the parser.
 *
 * LOCAL OLLAMA ONLY (gemma4:12b default); skips (exit 0) when unreachable —
 * a skip is not a pass. 4 golden cases (KO daily-morning, EN weekly,
 * KO-with-notify, + a REVISION case), each scored field-level (cron EXACT,
 * prompt keyword, notifyChannel presence) — a deterministic scorer, not an
 * LLM judge, since every field here is checkable in code. The revision case
 * scores FIELD-PRESERVATION: only the requested field may change.
 */
import {
  buildFlowDraftPrompt,
  buildFlowDraftRepairPrompt,
  buildFlowDraftRevisionPrompt,
  buildFlowDraftRevisionRepairPrompt,
  parseFlowDraftResponse
} from "../../api/dist/flows-draft-compile.js";
import { OllamaProvider } from "../../../packages/model/dist/index.js";

const MODEL = process.env.MUSE_EVAL_MODEL ?? "gemma4:12b";
const OLLAMA_BASE = (process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434").replace(/\/+$/u, "");
const THRESHOLD = Number(process.env.MUSE_EVAL_THRESHOLD ?? "1"); // 3/3 field-level, see module docstring

async function ollamaHasModel() {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return false;
    const names = ((await res.json())?.models ?? []).map((m) => m?.name ?? "");
    return names.some((n) => n === MODEL || n.startsWith(`${MODEL}:`));
  } catch {
    return false;
  }
}

if (!(await ollamaHasModel())) {
  console.log(`eval:flow-draft skipped — local Ollama not reachable at ${OLLAMA_BASE} or model '${MODEL}' missing. A skip is not a pass.`);
  process.exit(0);
}

const modelProvider = new OllamaProvider({ baseUrl: OLLAMA_BASE });

// Mirrors the route's listDraftableTools: read-risk loopback tools the
// scheduler can actually execute. A fixed representative subset keeps the
// battery deterministic (the live route derives the full set at runtime).
const DRAFTABLE_TOOLS = [
  { description: "Returns the current date/time (ISO timestamp, weekday).", server: "muse.time", tool: "now" },
  {
    description: "Millisecond difference between two ISO timestamps.",
    inputSchema: {
      properties: {
        from: { description: "Start ISO timestamp, e.g. '2026-01-01T00:00:00Z'", type: "string" },
        to: { description: "End ISO timestamp, e.g. '2026-01-02T00:00:00Z'", type: "string" }
      },
      required: ["from", "to"],
      type: "object"
    },
    server: "muse.time",
    tool: "diff_ms"
  },
  {
    description: "Character/word/line statistics for a text.",
    inputSchema: {
      properties: { text: { description: "The text to analyze", type: "string" } },
      required: ["text"],
      type: "object"
    },
    server: "muse.text",
    tool: "stats"
  },
  {
    description: "Evaluates an arithmetic expression.",
    inputSchema: {
      properties: { expression: { description: "Arithmetic expression, e.g. '2*(3+4)'", type: "string" } },
      required: ["expression"],
      type: "object"
    },
    server: "muse.math",
    tool: "evaluate"
  },
  {
    description: "Pretty-prints a JSON document.",
    inputSchema: {
      properties: { json: { description: "The JSON text to pretty-print", type: "string" } },
      required: ["json"],
      type: "object"
    },
    server: "muse.json",
    tool: "format"
  },
  {
    description: "Parses a URL into components.",
    inputSchema: {
      properties: { url: { description: "The URL to parse, e.g. 'https://example.com/a?b=1'", type: "string" } },
      required: ["url"],
      type: "object"
    },
    server: "muse.url",
    tool: "parse"
  },
  {
    description: "Add a reminder. `text` is the reminder body; `dueAt` accepts an ISO timestamp or a relative phrase ('내일 오전 8시', 'in 3 hours').",
    inputSchema: {
      properties: {
        dueAt: { description: "When it is due, e.g. '내일 오전 8시' or '2026-07-19T08:00:00+09:00'", type: "string" },
        text: { description: "Reminder body, e.g. '물 마시기'", type: "string" }
      },
      required: ["text"],
      type: "object"
    },
    server: "muse.reminders",
    tool: "add"
  }
];

const CASES = [
  {
    expectNotify: false,
    expectedCron: "0 9 * * *",
    label: "KO daily-morning",
    promptKeywords: ["일정", "요약"],
    text: "매일 아침 9시에 일정 요약해서 알려줘"
  },
  {
    expectNotify: false,
    expectedCron: "0 9 * * 1",
    label: "EN weekly",
    promptKeywords: ["week"],
    text: "every monday at 9am summarize my week"
  },
  {
    expectNotify: true,
    expectedCron: "0 18 * * *",
    label: "KO with notify",
    promptKeywords: ["이메일", "요약"],
    text: "매일 저녁 6시에 이메일 요약해서 텔레그램 123으로 보내줘"
  }
];

async function generate(prompt) {
  const response = await modelProvider.generate({
    messages: [
      { content: prompt.system, role: "system" },
      { content: prompt.user, role: "user" }
    ],
    model: MODEL,
    temperature: 0
  });
  return response.output;
}

async function draftFor(text) {
  const options = { allowedTools: DRAFTABLE_TOOLS };
  const first = parseFlowDraftResponse(await generate(buildFlowDraftPrompt(text, DRAFTABLE_TOOLS)), options);
  if (first.ok) {
    return first;
  }
  return parseFlowDraftResponse(
    await generate(buildFlowDraftRepairPrompt(text, "(previous attempt)", first.error, DRAFTABLE_TOOLS)),
    options
  );
}

async function revisionDraftFor(text, currentDraft) {
  const options = { requireAllFields: true };
  const first = parseFlowDraftResponse(await generate(buildFlowDraftRevisionPrompt(text, currentDraft)), options);
  if (first.ok) {
    return first;
  }
  return parseFlowDraftResponse(
    await generate(buildFlowDraftRevisionRepairPrompt(text, currentDraft, "(previous attempt)", first.error)),
    options
  );
}

// The 4th case: given an existing draft, a conversational follow-up
// ("8시 반으로 바꿔줘") must change ONLY the requested field — field
// preservation is the scored property, not just a valid draft.
const REVISION_CASE = {
  currentDraft: {
    action: "agent",
    cronExpression: "0 9 * * *",
    name: "아침 브리핑",
    notifyChannel: null,
    prompt: "일정 요약해줘",
    retry: false,
    toolName: null,
    toolServer: null
  },
  expectedCron: "30 8 * * *",
  label: "KO revision (time-change, field-preservation)",
  text: "8시 반으로 바꿔줘"
};

let passed = 0;
for (const testCase of CASES) {
  const parsed = await draftFor(testCase.text);
  if (!parsed.ok) {
    console.log(`FAIL [${testCase.label}] — model never returned a valid draft: ${parsed.error}`);
    continue;
  }

  const cronOk = parsed.value.cronExpression === testCase.expectedCron;
  const promptOk = testCase.promptKeywords.every((keyword) => parsed.value.prompt.includes(keyword));
  const notifyOk = !testCase.expectNotify || parsed.value.notifyChannel !== null;
  // Over-fire guard (IrrelAcc analog): an agent-shaped request must NOT
  // become a tool draft just because tools are on offer.
  const actionOk = parsed.value.action === "agent";
  const ok = cronOk && promptOk && notifyOk && actionOk;

  if (ok) {
    passed += 1;
  }
  console.log(
    `${ok ? "PASS" : "FAIL"} [${testCase.label}] cron=${cronOk ? "ok" : `WRONG (${parsed.value.cronExpression})`} `
      + `prompt=${promptOk ? "ok" : `MISSING keyword (${parsed.value.prompt})`} `
      + `notify=${notifyOk ? "ok" : "MISSING"} `
      + `action=${actionOk ? "ok" : `OVER-FIRED (${parsed.value.action} ${String(parsed.value.toolServer)}.${String(parsed.value.toolName)})`}`
  );
}

// Tool-draft case: a request that IS a direct tool call must select the
// matching read-risk loopback tool in one shot (repair allowed, same as the
// route), with the exact server/tool pair — the binding constraint on a
// local model per tool-calling.md.
const TOOL_CASE = {
  expectedCron: "0 * * * *",
  expectedServer: "muse.time",
  expectedTool: "now",
  label: "KO tool-draft (hourly current time)",
  text: "매시간 정각에 현재 시각 기록해줘"
};
{
  const parsed = await draftFor(TOOL_CASE.text);
  if (!parsed.ok) {
    console.log(`FAIL [${TOOL_CASE.label}] — model never returned a valid draft: ${parsed.error}`);
  } else {
    const actionOk = parsed.value.action === "tool";
    const pairOk = parsed.value.toolServer === TOOL_CASE.expectedServer && parsed.value.toolName === TOOL_CASE.expectedTool;
    const cronOk = parsed.value.cronExpression === TOOL_CASE.expectedCron;
    const argsOk = JSON.stringify(parsed.value.toolArguments) === "{}";
    const ok = actionOk && pairOk && cronOk && argsOk;
    if (ok) {
      passed += 1;
    }
    console.log(
      `${ok ? "PASS" : "FAIL"} [${TOOL_CASE.label}] action=${actionOk ? "ok" : `WRONG (${parsed.value.action})`} `
        + `tool=${pairOk ? "ok" : `WRONG (${String(parsed.value.toolServer)}.${String(parsed.value.toolName)})`} `
        + `cron=${cronOk ? "ok" : `WRONG (${parsed.value.cronExpression})`} `
        + `args=${argsOk ? "ok" : `WRONG (${JSON.stringify(parsed.value.toolArguments)})`}`
    );
  }
}

// Tool-ARGUMENT case: the request carries a literal the model must COPY into
// toolArguments (prompt-derived literal per agent-testing.md — never grade a
// model-invented value). The deterministic schema gate already rejects
// fabricated keys/missing required; this case proves the model actually
// FILLS the argument in one shot (repair allowed, same as the route).
const TOOL_ARGS_CASE = {
  expectedArguments: { url: "https://news.ycombinator.com" },
  expectedServer: "muse.url",
  expectedTool: "parse",
  label: "KO tool-args draft (hourly URL parse, literal copy)",
  text: "매시간 https://news.ycombinator.com 주소 파싱해서 기록해줘"
};
{
  const parsed = await draftFor(TOOL_ARGS_CASE.text);
  if (!parsed.ok) {
    console.log(`FAIL [${TOOL_ARGS_CASE.label}] — model never returned a valid draft: ${parsed.error}`);
  } else {
    const pairOk = parsed.value.toolServer === TOOL_ARGS_CASE.expectedServer && parsed.value.toolName === TOOL_ARGS_CASE.expectedTool;
    const argsOk = JSON.stringify(parsed.value.toolArguments) === JSON.stringify(TOOL_ARGS_CASE.expectedArguments);
    const ok = parsed.value.action === "tool" && pairOk && argsOk;
    if (ok) {
      passed += 1;
    }
    console.log(
      `${ok ? "PASS" : "FAIL"} [${TOOL_ARGS_CASE.label}] `
        + `tool=${pairOk ? "ok" : `WRONG (${String(parsed.value.toolServer)}.${String(parsed.value.toolName)})`} `
        + `args=${argsOk ? "ok" : `WRONG (${JSON.stringify(parsed.value.toolArguments)})`}`
    );
  }
}

// WRITE-tool case (진안 2026-07-18 ruling opened write tools to the copilot):
// the model must pick the write tool AND copy the reminder body literal.
const WRITE_TOOL_CASE = {
  expectedServer: "muse.reminders",
  expectedTool: "add",
  label: "KO write-tool draft (daily water reminder)",
  text: "매일 아침 8시에 물 마시기 리마인더 만들어줘",
  textKeyword: "물"
};
{
  const parsed = await draftFor(WRITE_TOOL_CASE.text);
  if (!parsed.ok) {
    console.log(`FAIL [${WRITE_TOOL_CASE.label}] — model never returned a valid draft: ${parsed.error}`);
  } else {
    const pairOk = parsed.value.toolServer === WRITE_TOOL_CASE.expectedServer && parsed.value.toolName === WRITE_TOOL_CASE.expectedTool;
    const textArg = typeof parsed.value.toolArguments.text === "string" ? parsed.value.toolArguments.text : "";
    const argsOk = textArg.includes(WRITE_TOOL_CASE.textKeyword);
    const ok = parsed.value.action === "tool" && pairOk && argsOk;
    if (ok) {
      passed += 1;
    }
    console.log(
      `${ok ? "PASS" : "FAIL"} [${WRITE_TOOL_CASE.label}] `
        + `tool=${pairOk ? "ok" : `WRONG (${String(parsed.value.toolServer)}.${String(parsed.value.toolName)})`} `
        + `args=${argsOk ? "ok" : `WRONG (${JSON.stringify(parsed.value.toolArguments)})`}`
    );
  }
}

const revisionParsed = await revisionDraftFor(REVISION_CASE.text, REVISION_CASE.currentDraft);
if (!revisionParsed.ok) {
  console.log(`FAIL [${REVISION_CASE.label}] — model never returned a valid revision: ${revisionParsed.error}`);
} else {
  const cronOk = revisionParsed.value.cronExpression === REVISION_CASE.expectedCron;
  const promptPreserved = revisionParsed.value.prompt === REVISION_CASE.currentDraft.prompt;
  const notifyPreserved = revisionParsed.value.notifyChannel === REVISION_CASE.currentDraft.notifyChannel;
  const ok = cronOk && promptPreserved && notifyPreserved;

  if (ok) {
    passed += 1;
  }
  console.log(
    `${ok ? "PASS" : "FAIL"} [${REVISION_CASE.label}] cron=${cronOk ? "ok" : `WRONG (${revisionParsed.value.cronExpression})`} `
      + `prompt-preserved=${promptPreserved ? "ok" : `CHANGED (${revisionParsed.value.prompt})`} `
      + `notify-preserved=${notifyPreserved ? "ok" : `CHANGED (${String(revisionParsed.value.notifyChannel)})`}`
  );
}

const totalCases = CASES.length + 4;
const rate = passed / totalCases;
console.log(`\neval:flow-draft — ${passed}/${totalCases} cases passed on ${MODEL} (threshold ${THRESHOLD})`);
process.exit(rate >= THRESHOLD ? 0 : 1);
