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
 * a skip is not a pass. 3 golden cases (KO daily-morning, EN weekly,
 * KO-with-notify), each scored field-level (cron EXACT, prompt keyword,
 * notifyChannel presence) — a deterministic scorer, not an LLM judge, since
 * every field here is checkable in code.
 */
import {
  buildFlowDraftPrompt,
  buildFlowDraftRepairPrompt,
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
  console.log(`eval:flow-draft skipped — local model '${MODEL}' unavailable at ${OLLAMA_BASE} (a skip is not a pass).`);
  process.exit(0);
}

const modelProvider = new OllamaProvider({ baseUrl: OLLAMA_BASE });

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
  const first = parseFlowDraftResponse(await generate(buildFlowDraftPrompt(text)));
  if (first.ok) {
    return first;
  }
  return parseFlowDraftResponse(await generate(buildFlowDraftRepairPrompt(text, "(previous attempt)", first.error)));
}

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
  const ok = cronOk && promptOk && notifyOk;

  if (ok) {
    passed += 1;
  }
  console.log(
    `${ok ? "PASS" : "FAIL"} [${testCase.label}] cron=${cronOk ? "ok" : `WRONG (${parsed.value.cronExpression})`} `
      + `prompt=${promptOk ? "ok" : `MISSING keyword (${parsed.value.prompt})`} `
      + `notify=${notifyOk ? "ok" : "MISSING"}`
  );
}

const rate = passed / CASES.length;
console.log(`\neval:flow-draft — ${passed}/${CASES.length} cases passed on ${MODEL} (threshold ${THRESHOLD})`);
process.exit(rate >= THRESHOLD ? 0 : 1);
