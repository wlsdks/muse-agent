/**
 * eval:channel-rhythm — pins the delegation-ack composer's output quality on
 * the real local model, plus the upstream casual fast-path that keeps it from
 * ever running on small talk.
 *
 * Runs the REAL `createComposeAck` (apps/api) against the local model for a
 * KO+EN delegation-request golden set and grades it with DETERMINISTIC
 * scorers only (agent-testing.md's cheapest-grader-first tier — no llmJudge
 * needed here: non-empty, single-line, length-capped, language-appropriate,
 * echoes a content literal from the prompt, and carries no citation marker
 * all resolve without a model). A second scenario asserts
 * `classifyCasualPrompt` (agent-core) matches small-talk strings, proving the
 * deterministic fast-path — not the composer — is what answers them in the
 * product path.
 *
 * LOCAL OLLAMA ONLY (gemma4:12b by default); skips (exit 0) when unreachable.
 * Each delegation case is run MUSE_EVAL_REPEAT times (default 2) and must
 * pass every run (pass^k).
 */

import { pathToFileURL } from "node:url";

import { OllamaProvider } from "../packages/model/dist/index.js";
import { citedSourcesIn, classifyCasualPrompt } from "../packages/agent-core/dist/index.js";
import { createComposeAck } from "../apps/api/dist/inbound-ack.js";
import { runEvalSuite } from "./eval-harness.mjs";

const MODEL = process.env.MUSE_EVAL_MODEL ?? "gemma4:12b";
const OLLAMA_BASE = (process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434").replace(/\/+$/u, "");
const THRESHOLD = Number(process.env.MUSE_EVAL_THRESHOLD ?? "0.85");
const REPEAT = Math.max(1, Math.trunc(Number(process.env.MUSE_EVAL_REPEAT ?? "2")));

const DELEGATION_LABEL = "delegation ack (composeAck restates the request, in the user's language)";
const CASUAL_LABEL = "casual small-talk (classifyCasualPrompt handles it upstream — composer never runs)";

// Each case's `literal` is a token the restatement can't reasonably drop
// without losing the point of the request — the echo-check proxy for
// faithfulness (agent-testing.md: grade prompt-derived literals, not
// model-invented values).
const DELEGATION_CASES = [
  { language: "ko", literal: "일정", note: "KO calendar-sort delegation", prompt: "다음 주 일정 정리해서 겹치는 거 알려줘" },
  { language: "ko", literal: "회의록", note: "KO meeting-notes summarize delegation", prompt: "어제 회의록 요약해줘" },
  { language: "ko", literal: "리마인더", note: "KO reminder-set delegation", prompt: "내일 아침 회의 리마인더 설정해줘" },
  { language: "ko", literal: "지출", note: "KO expense-sort delegation", prompt: "이번 달 지출 내역 정리해줘" },
  { language: "ko", literal: "여행", note: "KO trip-schedule-check delegation", prompt: "다음 주 여행 일정 확인해줘" },
  { language: "en", literal: "mom", note: "EN reminder-set delegation", prompt: "remind me to call mom tomorrow" },
  { language: "en", literal: "trip", note: "EN notes-summarize delegation", prompt: "summarize my notes about the trip" },
  { language: "en", literal: "dentist", note: "EN booking delegation", prompt: "book a dentist appointment for next Tuesday" },
  { language: "en", literal: "budget", note: "EN notes-find delegation", prompt: "find my notes about the budget meeting" },
  { language: "en", literal: "report", note: "EN reminder-set delegation", prompt: "set a reminder to submit the report by Friday" }
];

const CASUAL_CASES = [
  { note: "KO greeting → casual fast-path", prompt: "안녕~" },
  { note: "KO thanks → casual fast-path", prompt: "고마워요" },
  { note: "EN greeting → casual fast-path", prompt: "hi" },
  { note: "EN thanks → casual fast-path", prompt: "thanks!" }
];

async function ollamaReachable() {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return false;
    const body = await res.json();
    return (body?.models ?? []).some((m) => typeof m?.name === "string" && m.name.includes(MODEL.replace(/^ollama\//u, "")));
  } catch {
    return false;
  }
}

function scoreAck(ack, testCase) {
  if (typeof ack !== "string" || ack.length === 0) {
    return { ok: false, detail: `composeAck returned ${ack === null ? "null (guard rejected / timed out / errored)" : "empty"}` };
  }
  if (ack.length > 200) {
    return { ok: false, detail: `ack too long (${ack.length} chars): ${ack}` };
  }
  if (ack.includes("\n")) {
    return { ok: false, detail: `ack is not single-line: ${JSON.stringify(ack)}` };
  }
  if (testCase.language === "ko" && !/[가-힣]/u.test(ack)) {
    return { ok: false, detail: `KO prompt but ack has no Hangul: ${ack}` };
  }
  if (!ack.toLowerCase().includes(testCase.literal.toLowerCase())) {
    return { ok: false, detail: `ack does not echo "${testCase.literal}": ${ack}` };
  }
  if (citedSourcesIn(ack).length > 0 || /\[[^\]]*:/u.test(ack)) {
    return { ok: false, detail: `ack contains a citation marker: ${ack}` };
  }
  return { ok: true, detail: `ack: ${ack}` };
}

function scoreCasual(kind, testCase) {
  return kind !== null
    ? { ok: true, detail: `classifyCasualPrompt → ${kind} (composer is never invoked for this message in the product path)` }
    : { ok: false, detail: `classifyCasualPrompt returned null for "${testCase.prompt}" — would fall through to the composer` };
}

async function main() {
  if (!(await ollamaReachable())) {
    console.log(`eval:channel-rhythm skipped — Ollama (${OLLAMA_BASE}) or model ${MODEL} unreachable. Start \`ollama serve\` with ${MODEL}.`);
    return;
  }
  const provider = new OllamaProvider({ defaultModel: MODEL });
  const composeAck = createComposeAck({ model: MODEL, modelProvider: provider });

  const solve = async (testCase, scenario) =>
    scenario.label === CASUAL_LABEL ? classifyCasualPrompt(testCase.prompt) : composeAck({ latestUserText: testCase.prompt });
  const score = (observed, testCase, scenario) =>
    scenario.label === CASUAL_LABEL ? scoreCasual(observed, testCase) : scoreAck(observed, testCase);

  const { gate } = await runEvalSuite({
    name: "eval:channel-rhythm",
    repeat: REPEAT,
    scenarios: [
      { cases: DELEGATION_CASES, label: DELEGATION_LABEL },
      { cases: CASUAL_CASES, label: CASUAL_LABEL }
    ],
    score,
    solve,
    threshold: THRESHOLD
  });
  if (!gate) process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
