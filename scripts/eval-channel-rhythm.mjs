/**
 * eval:channel-rhythm — pins the delegation-ack composer's output quality on
 * the real local model, plus the upstream casual fast-path that keeps it from
 * ever running on small talk, plus the S3 chat fast-path (composer + its
 * triple-gated classifier) that completes the assistant rhythm.
 *
 * Runs the REAL `createComposeAck` (apps/api) against the local model for a
 * KO+EN delegation-request golden set and grades it with DETERMINISTIC
 * scorers only (agent-testing.md's cheapest-grader-first tier — no llmJudge
 * needed here: non-empty, single-line, length-capped, language-appropriate,
 * echoes a content literal from the prompt, and carries no citation marker
 * all resolve without a model). A second scenario asserts
 * `classifyCasualPrompt` (agent-core) matches small-talk strings, proving the
 * deterministic fast-path — not the composer — is what answers them in the
 * product path. A third scenario runs the REAL `createComposeChatReply` (S3)
 * against the local model for a small conversational golden set — non-null,
 * no citation marker, KO prompt → Hangul reply. A fourth scenario asserts
 * `classifyChannelIntent` (agent-core) routes genuine delegation requests to
 * "delegation" — the conservative default that keeps the S3 composer from
 * ever firing on a real ask. A fifth scenario proves the personalization
 * slice: `loadChatPersonaSnapshot` seeds a small fake `UserMemoryStore` with
 * one real fact, `createComposeChatReply` gets the resulting snapshot as
 * `personaSnapshot`, and the REAL local model answers — asserting the reply
 * is well-formed (2 positive cases; the model MAY draw on the seeded fact but
 * its exact phrasing is never pinned, per agent-testing.md) plus one negative
 * case: a fact NOT in the snapshot is asked about, and the reply must never
 * state the specific planted-absent literal as fact.
 *
 * LOCAL OLLAMA ONLY (gemma4:12b by default); skips (exit 0) when unreachable.
 * Each live-model case is run MUSE_EVAL_REPEAT times (default 2) and must
 * pass every run (pass^k).
 */

import { pathToFileURL } from "node:url";

import { OllamaProvider } from "../packages/model/dist/index.js";
import { citedSourcesIn, classifyCasualPrompt, classifyChannelIntent } from "../packages/agent-core/dist/index.js";
import { loadChatPersonaSnapshot } from "../apps/api/dist/chat-persona-snapshot.js";
import { createComposeAck } from "../apps/api/dist/inbound-ack.js";
import { createComposeChatReply } from "../apps/api/dist/inbound-chat-reply.js";
import { runEvalSuite } from "./eval-harness.mjs";

const MODEL = process.env.MUSE_EVAL_MODEL ?? "gemma4:12b";
const OLLAMA_BASE = (process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434").replace(/\/+$/u, "");
const THRESHOLD = Number(process.env.MUSE_EVAL_THRESHOLD ?? "0.85");
const REPEAT = Math.max(1, Math.trunc(Number(process.env.MUSE_EVAL_REPEAT ?? "2")));

const DELEGATION_LABEL = "delegation ack (composeAck restates the request, in the user's language)";
const CASUAL_LABEL = "casual small-talk (classifyCasualPrompt handles it upstream — composer never runs)";
const CHAT_FASTPATH_LABEL = "chat fast-path (composeChatReply answers conversationally, in the user's language)";
const CHAT_CLASSIFY_LABEL = "chat-intent classifier (a real delegation request must route to \"delegation\")";
const PERSONA_POSITIVE_LABEL = "personalization — positive (composeChatReply gets a real persona snapshot, no fabrication beyond it)";
const PERSONA_NEGATIVE_LABEL = "personalization — negative (a fact absent from the snapshot is never stated as fact)";

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

// S3 chat fast-path golden set — genuine conversational asides that are NOT
// one of the three canned casual kinds (`classifyCasualPrompt`), so they get
// the real composeChatReply single-inference reply in the product path.
const CHAT_FASTPATH_CASES = [
  { language: "ko", note: "KO tired-mood smalltalk", prompt: "오늘 좀 피곤하네 ㅋㅋ" },
  { language: "ko", note: "KO how-are-you smalltalk", prompt: "요즘 어때?" },
  { language: "ko", note: "KO casual lunch decision + laughter", prompt: "점심 뭐 먹지 ㅋㅋ" },
  { language: "en", note: "EN tired-mood smalltalk", prompt: "I'm so tired today lol" }
];

// A genuine delegation request must route to "delegation" — the classifier's
// safe default — so the S3 composer never even runs on a real ask.
const CHAT_CLASSIFY_DELEGATION_CASES = [
  { note: "KO reminder-set delegation", prompt: "내일 아침 회의 리마인더 설정해줘" },
  { note: "EN reminder-set delegation", prompt: "remind me to call mom tomorrow" }
];

// Personalization golden set: each case seeds a tiny fake UserMemoryStore
// (facts/preferences), runs it through the REAL loadChatPersonaSnapshot, and
// feeds the resulting snapshot into the REAL composeChatReply — proving the
// whole "knows-you" plumbing, not just the composer in isolation.
const PERSONA_POSITIVE_CASES = [
  {
    facts: { name: "진안" },
    language: "ko",
    // Deliberately NOT a recall-shaped prompt ("내 이름이 뭐였지?") — that
    // phrasing can trip composeChatReply's PASS sentinel (it reads as a real
    // "look something up" ask, semi-correct fast-path behavior, not a
    // composer defect). This is genuine smalltalk that the seeded snapshot
    // MAY color the greeting with; the model's exact phrasing (whether it
    // uses the name at all) is never pinned, per agent-testing.md.
    note: "KO upbeat-greeting smalltalk — snapshot carries the user's name",
    prompt: "나 오늘 기분 최고야! 인사 한번 해줘 ㅋㅋ"
  },
  {
    facts: { hobby: "rock climbing" },
    language: "en",
    note: "EN hobby-aware smalltalk — snapshot carries a real hobby fact",
    prompt: "ugh so tired today, remind me why I even started climbing lol"
  }
];

const PERSONA_NEGATIVE_CASE = {
  facts: { name: "진안" },
  // A specific figure that is NOWHERE in the seeded snapshot — the reply
  // must never state it as if it were a known fact.
  note: "a fact absent from the snapshot must never be stated as fact",
  plantedAbsentLiteral: "9,999,999",
  prompt: "내 연봉이 정확히 얼마였지 ㅋㅋ"
};

function fakeMemoryStore(memory) {
  return {
    deleteByUserId: async () => true,
    findByUserId: async () => memory,
    upsertFact: async () => memory,
    upsertPreference: async () => memory
  };
}

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

// Closing-promise token set, checked per language rather than pinning one
// exact phrase — the model varies wording run-to-run (agent-testing.md:
// don't pin a model-INVENTED value verbatim, pin the observable intent).
const KO_CLOSING_PROMISE_RE = /(알려|말해|보고)(줄게|드릴게|주겠|드리겠|하겠)/u;
const EN_CLOSING_PROMISE_RE = /(let you know|report back)/iu;

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
  const closingRe = testCase.language === "ko" ? KO_CLOSING_PROMISE_RE : EN_CLOSING_PROMISE_RE;
  if (!closingRe.test(ack)) {
    return { ok: false, detail: `ack is missing the closing report-back promise: ${ack}` };
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

function scoreChatReply(reply, testCase) {
  if (typeof reply !== "string" || reply.length === 0) {
    return { ok: false, detail: `composeChatReply returned ${reply === null ? "null (PASS sentinel / guard rejected / timed out / errored)" : "empty"}` };
  }
  if (reply.length > 400) {
    return { ok: false, detail: `chat reply too long (${reply.length} chars): ${reply}` };
  }
  if (testCase.language === "ko" && !/[가-힣]/u.test(reply)) {
    return { ok: false, detail: `KO prompt but chat reply has no Hangul: ${reply}` };
  }
  if (citedSourcesIn(reply).length > 0 || /\[[^\]]*:/u.test(reply)) {
    return { ok: false, detail: `chat reply contains a citation marker: ${reply}` };
  }
  return { ok: true, detail: `chat reply: ${reply}` };
}

function scoreChatClassifyDelegation(intent, testCase) {
  return intent === "delegation"
    ? { ok: true, detail: `classifyChannelIntent → delegation (the S3 composer never runs on this real ask)` }
    : { ok: false, detail: `classifyChannelIntent returned "${intent}" for "${testCase.prompt}" — a real ask would wrongly get the chat fast-path` };
}

// Positive personalization case: baseline chat-reply hygiene only — the
// model MAY draw on the seeded snapshot fact, but its exact phrasing is
// never pinned (agent-testing.md: don't pin a model-INVENTED echo).
function scorePersonaPositive(reply, testCase) {
  return scoreChatReply(reply, testCase);
}

// Negative personalization case: baseline hygiene PLUS the specific
// planted-absent literal (a fact the snapshot never carried) must never
// appear in the reply as if it were a known fact.
function scorePersonaNegative(reply, testCase) {
  const base = scoreChatReply(reply, testCase);
  if (!base.ok) return base;
  if (reply.includes(testCase.plantedAbsentLiteral)) {
    return { ok: false, detail: `reply states the planted-absent literal "${testCase.plantedAbsentLiteral}" as fact: ${reply}` };
  }
  return { ok: true, detail: `chat reply (no planted-absent literal leaked): ${reply}` };
}

async function main() {
  if (!(await ollamaReachable())) {
    console.log(`eval:channel-rhythm skipped — Ollama (${OLLAMA_BASE}) or model ${MODEL} unreachable. Start \`ollama serve\` with ${MODEL}.`);
    return;
  }
  const provider = new OllamaProvider({ defaultModel: MODEL });
  const composeAck = createComposeAck({ model: MODEL, modelProvider: provider });
  const composeChatReply = createComposeChatReply({ model: MODEL, modelProvider: provider });

  const solvePersonalized = async (testCase) => {
    const memory = { facts: testCase.facts ?? {}, preferences: {}, recentTopics: [], updatedAt: new Date(), userId: "eval:owner" };
    const snapshot = await loadChatPersonaSnapshot({
      providerId: "eval",
      scope: "direct",
      source: "owner",
      userMemoryStore: fakeMemoryStore(memory)
    });
    return composeChatReply({ latestUserText: testCase.prompt, personaSnapshot: snapshot ?? [], thread: [] });
  };
  const solve = async (testCase, scenario) => {
    if (scenario.label === CASUAL_LABEL) return classifyCasualPrompt(testCase.prompt);
    if (scenario.label === CHAT_CLASSIFY_LABEL) return classifyChannelIntent(testCase.prompt);
    if (scenario.label === CHAT_FASTPATH_LABEL) return composeChatReply({ latestUserText: testCase.prompt, thread: [] });
    if (scenario.label === PERSONA_POSITIVE_LABEL || scenario.label === PERSONA_NEGATIVE_LABEL) return solvePersonalized(testCase);
    return composeAck({ latestUserText: testCase.prompt });
  };
  const score = (observed, testCase, scenario) => {
    if (scenario.label === CASUAL_LABEL) return scoreCasual(observed, testCase);
    if (scenario.label === CHAT_CLASSIFY_LABEL) return scoreChatClassifyDelegation(observed, testCase);
    if (scenario.label === CHAT_FASTPATH_LABEL) return scoreChatReply(observed, testCase);
    if (scenario.label === PERSONA_POSITIVE_LABEL) return scorePersonaPositive(observed, testCase);
    if (scenario.label === PERSONA_NEGATIVE_LABEL) return scorePersonaNegative(observed, testCase);
    return scoreAck(observed, testCase);
  };

  const { gate } = await runEvalSuite({
    name: "eval:channel-rhythm",
    repeat: REPEAT,
    scenarios: [
      // These four scenarios' solve() calls the REAL composeAck/composeChatReply
      // — both fail-open (return `null` on a guard-rejection AND on a timeout,
      // indistinguishably; see apps/api/src/inbound-{ack,chat-reply}.ts). Under
      // concurrent-loop Ollama saturation that `null` is often infra, not a real
      // guard rejection — `allowNullAsInfra` lets the harness retry once before
      // scoring rather than counting it as a semantic failure.
      { allowNullAsInfra: true, cases: DELEGATION_CASES, label: DELEGATION_LABEL },
      // classifyCasualPrompt is a pure deterministic classifier — no model call,
      // so its `null` is always a real "not casual" result, never an infra flake.
      { cases: CASUAL_CASES, label: CASUAL_LABEL },
      { allowNullAsInfra: true, cases: CHAT_FASTPATH_CASES, label: CHAT_FASTPATH_LABEL },
      // classifyChannelIntent is likewise pure/deterministic.
      { cases: CHAT_CLASSIFY_DELEGATION_CASES, label: CHAT_CLASSIFY_LABEL },
      { allowNullAsInfra: true, cases: PERSONA_POSITIVE_CASES, label: PERSONA_POSITIVE_LABEL },
      { allowNullAsInfra: true, cases: [PERSONA_NEGATIVE_CASE], label: PERSONA_NEGATIVE_LABEL }
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
