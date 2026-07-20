#!/usr/bin/env node

import { lstat, mkdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { spawnWithTimeout } from "./eval-recall-candidate-pool.mjs";
import {
  canonicalJson,
  canonicalLoopbackBaseUrl,
  createAuditedLoopbackFetch,
  jsonBytes,
  manifestTree,
  modelInfo,
  nearestRank,
  runtimeSourceProvenance,
  sha256,
  writeAtomic
} from "./recall-eval-runtime-common.mjs";

export { canonicalJson, sha256 };

export const CATEGORIES = Object.freeze(["pair-present", "no-pair"]);
export const LOCALES = Object.freeze(["ko", "en"]);
export const DOMAINS = Object.freeze(["life", "health", "work", "preference", "reference"]);
export const CASES_PER_CELL = 2;
export const CASE_COUNT = 40;
export const ORDER_NAMES = Object.freeze(["original", "reversed"]);
export const EXECUTION_COUNT = CASE_COUNT * ORDER_NAMES.length;
export const EXECUTIONS_PER_ORDER = CASE_COUNT;
export const TOP_K = 3;
export const CHILD_TIMEOUT_MS = 20 * 60_000;
export const PARENT_TIMEOUT_MS = 30 * 60_000;
export const RESULT_SCHEMA_VERSION = "muse-recall-position-bias-dev40.v2";
export const CHILD_SCHEMA_VERSION = "muse-recall-position-bias-dev40-child.v2";
export const DIAGNOSTICS_ROOT_RELATIVE = ".muse-dev/evals/recall-position-bias-dev40";
export const BUILDER_P95_INFORMATIONAL_BUDGET_MS = 10;
export const BUILDER_HARD_CAPS = Object.freeze({ maxCandidates: 12, maxComparisons: 100, maxProposals: 6 });
export const FAILURE_CODES = Object.freeze([
  "CHILD_OUTPUT_INVALID",
  "CHILD_OUTPUT_MISSING",
  "CHILD_TIMEOUT",
  "CHILD_TRIAL_FAILED",
  "DATASET_INVALID",
  "DEFAULT_RERANKER_UNAVAILABLE",
  "INVALID_ARGUMENTS",
  "ISOLATION_CLEANUP_FAILED",
  "NETWORK_ACCOUNTING_MISMATCH",
  "OWNER_STATE_CHANGED",
  "OWNER_STATE_CHECK_FAILED",
  "PAIR_IDENTITY_INVALID",
  "POSITION_BIAS_EVAL_FAILED",
  "RERANKER_RESOLUTION_DRIFT",
  "SELECTOR_EXECUTION_DRIFT",
  "SELECTOR_ORDER_DRIFT"
]);

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const diagnosticsRoot = join(repoRoot, DIAGNOSTICS_ROOT_RELATIVE);
const EMBED_MODEL = "muse-position-bias-synthetic-v1";
export const RUNTIME_SOURCE_IDS = Object.freeze([
  "apps/cli/dist/ask-note-retrieval.js",
  "packages/recall/dist/index.js",
  "packages/recall/dist/ask-note-retrieval.js",
  "scripts/eval-recall-position-bias-dev40.mjs",
  "scripts/recall-eval-runtime-common.mjs"
]);

const SCENARIOS = Object.freeze([
  { domain: "life", locale: "ko", variants: [
    { current: "현재 주말 산책 출발지는 망원나루다.", query: "내 주말 산책 출발지는 어디야?", stale: "예전에 주말 산책 출발지는 서울숲이었다." },
    { current: "현재 택배 수령 장소는 동쪽 경비실이다.", query: "내 택배 수령 장소는 어디야?", stale: "예전에 택배 수령 장소는 서쪽 무인함이었다." }
  ] },
  { domain: "health", locale: "ko", variants: [
    { current: "현재 비타민 복용 시간은 저녁 식사 직후다.", query: "내 비타민 복용 시간은 언제야?", stale: "예전에 비타민 복용 시간은 아침 식사 전이었다." },
    { current: "현재 물리치료 요일은 목요일이다.", query: "내 물리치료 요일은 언제야?", stale: "예전에 물리치료 요일은 화요일이었다." }
  ] },
  { domain: "work", locale: "ko", variants: [
    { current: "현재 주간 보고서 제출 채널은 팀 위키다.", query: "내 주간 보고서 제출 채널은 어디야?", stale: "예전에 주간 보고서 제출 채널은 이메일이었다." },
    { current: "현재 집중 업무 시작 시각은 오전 열 시다.", query: "내 집중 업무 시작 시각은 언제야?", stale: "예전에 집중 업무 시작 시각은 오전 아홉 시였다." }
  ] },
  { domain: "preference", locale: "ko", variants: [
    { current: "현재 선호하는 커피 원두는 중배전이다.", query: "내가 선호하는 커피 원두 로스팅은 뭐야?", stale: "예전에 선호하는 커피 원두는 강배전이었다." },
    { current: "현재 영화 자막 선호 언어는 한국어다.", query: "내 영화 자막 선호 언어는 뭐야?", stale: "예전에 영화 자막 선호 언어는 영어였다." }
  ] },
  { domain: "reference", locale: "ko", variants: [
    { current: "현재 여권 사본 보관 폴더는 문서함 감마 폴더다.", query: "내 여권 사본 보관 폴더는 어디야?", stale: "예전에 여권 사본 보관 폴더는 문서함 베타 폴더였다." },
    { current: "현재 공유기 관리자 주소는 192.168.40.1이다.", query: "내 공유기 관리자 주소는 뭐야?", stale: "예전에 공유기 관리자 주소는 192.168.10.1이었다." }
  ] },
  { domain: "life", locale: "en", variants: [
    { current: "My current weekend walk starts at Harbor Gate.", query: "Where does my weekend walk start?", stale: "My weekend walk used to start at Cedar Park." },
    { current: "My current parcel pickup point is the east concierge desk.", query: "Where is my parcel pickup point?", stale: "My parcel pickup point used to be the west locker." }
  ] },
  { domain: "health", locale: "en", variants: [
    { current: "My current vitamin time is just after dinner.", query: "When is my vitamin time?", stale: "My vitamin time used to be before breakfast." },
    { current: "My current physical therapy day is Thursday.", query: "Which day is my physical therapy?", stale: "My physical therapy day used to be Tuesday." }
  ] },
  { domain: "work", locale: "en", variants: [
    { current: "My current weekly report channel is the team wiki.", query: "Where do I submit my weekly report?", stale: "My weekly report channel used to be email." },
    { current: "My current focus-work start time is ten in the morning.", query: "When does my focus-work block start?", stale: "My focus-work block used to start at nine in the morning." }
  ] },
  { domain: "preference", locale: "en", variants: [
    { current: "My current coffee roast preference is medium roast.", query: "What coffee roast do I prefer?", stale: "My coffee roast preference used to be dark roast." },
    { current: "My current movie subtitle preference is Korean.", query: "Which movie subtitle language do I prefer?", stale: "My movie subtitle preference used to be English." }
  ] },
  { domain: "reference", locale: "en", variants: [
    { current: "My current passport-copy folder is Documents Gamma.", query: "Where is my passport copy stored?", stale: "My passport-copy folder used to be Documents Beta." },
    { current: "My current router admin address is 192.168.40.1.", query: "What is my router admin address?", stale: "My router admin address used to be 192.168.10.1." }
  ] }
]);

const DECOYS = Object.freeze({
  en: Object.freeze({
    current: Object.freeze([
      "The current entry mat color is gray.",
      "The current desk lamp brightness is forty percent.",
      "The current mailbox alert arrives at six in the evening.",
      "The current spare key is inside the blue box."
    ]),
    stale: Object.freeze([
      "The travel bag used to have a yellow ribbon.",
      "The morning alarm used to play piano music.",
      "The meeting room used to be booked under Lilac.",
      "The kitchen timer used to sound like a bell."
    ])
  }),
  ko: Object.freeze({
    current: Object.freeze([
      "현재 현관 매트 색은 회색이다.",
      "현재 책상 스탠드 밝기는 사십 퍼센트다.",
      "현재 우편 알림 시각은 오후 여섯 시다.",
      "현재 비상 열쇠는 파란 상자 안에 있다."
    ]),
    stale: Object.freeze([
      "예전에 여행 가방 표식은 노란 끈이었다.",
      "예전에 아침 알람 음악은 피아노였다.",
      "예전에 회의실 예약 이름은 라일락이었다.",
      "예전에 주방 타이머 소리는 종소리였다."
    ])
  })
});

function failure(code) {
  const error = new Error(code);
  Object.defineProperty(error, "code", { enumerable: false, value: code });
  return error;
}

function requireExactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || canonicalJson(Object.keys(value).sort()) !== canonicalJson([...keys].sort())) throw failure("CHILD_OUTPUT_INVALID");
  return value;
}

function safeModelIdentifier(value) {
  return typeof value === "string"
    && /^[a-z0-9][a-z0-9._:+/@-]{0,199}$/iu.test(value)
    && !value.includes("..")
    && !value.includes("//");
}

function validateModelDescriptor(model) {
  requireExactKeys(model, ["digest", "modelTag", "ollamaVersion", "resolution", "resolvedTag"]);
  if (!/^(?:sha256:)?[a-f0-9]{64}$/u.test(model.digest)
    || !safeModelIdentifier(model.modelTag)
    || !safeModelIdentifier(model.resolvedTag)
    || typeof model.ollamaVersion !== "string"
    || !/^[a-z0-9][a-z0-9._+-]{0,63}$/iu.test(model.ollamaVersion)
    || model.resolution !== "actual-default") throw failure("CHILD_OUTPUT_INVALID");
  return model;
}

function opaqueId(seed) {
  return sha256(seed).slice(0, 16);
}

function candidate(caseSeed, state, ordinal, text) {
  return Object.freeze({ id: opaqueId(`${caseSeed}|${state}|${ordinal.toString()}`), state, text });
}

function buildDataset() {
  const cases = [];
  let ordinal = 0;
  for (const category of CATEGORIES) {
    for (const scenario of SCENARIOS) {
      for (let variant = 0; variant < scenario.variants.length; variant += 1) {
        const values = scenario.variants[variant];
        const caseSeed = `${category}|${scenario.locale}|${scenario.domain}|${(variant + 1).toString()}`;
        const currentTexts = category === "pair-present"
          ? [values.current, ...DECOYS[scenario.locale].current.slice(0, 3)]
          : [...DECOYS[scenario.locale].current];
        const staleTexts = category === "pair-present"
          ? [values.stale, ...DECOYS[scenario.locale].stale.slice(0, 3)]
          : [...DECOYS[scenario.locale].stale];
        const current = currentTexts.map((text, index) => candidate(caseSeed, "current", index, text));
        const stale = staleTexts.map((text, index) => candidate(caseSeed, "stale", index, text));
        cases.push(Object.freeze({
          candidates: Object.freeze([...current, ...stale]),
          caseId: opaqueId(`case|${ordinal.toString()}`),
          category,
          domain: scenario.domain,
          expectedPair: category === "pair-present" ? Object.freeze({ current: current[0].id, stale: stale[0].id }) : null,
          locale: scenario.locale,
          query: values.query,
          variant: variant + 1
        }));
        ordinal += 1;
      }
    }
  }
  return Object.freeze(cases);
}

export const POSITION_BIAS_DATASET = buildDataset();
export const DATASET_SHA256 = sha256(jsonBytes(POSITION_BIAS_DATASET));

export function validateDataset(cases = POSITION_BIAS_DATASET, detectStaleMarker) {
  if (!Array.isArray(cases) || cases.length !== CASE_COUNT) throw failure("DATASET_INVALID");
  const cells = new Map();
  const ids = new Set();
  for (const testCase of cases) {
    if (!CATEGORIES.includes(testCase.category) || !LOCALES.includes(testCase.locale) || !DOMAINS.includes(testCase.domain) || ![1, 2].includes(testCase.variant)) throw failure("DATASET_INVALID");
    const cell = `${testCase.category}|${testCase.locale}|${testCase.domain}`;
    cells.set(cell, (cells.get(cell) ?? 0) + 1);
    if (!/^[a-f0-9]{16}$/u.test(testCase.caseId) || ids.has(testCase.caseId) || typeof testCase.query !== "string" || !testCase.query.trim()) throw failure("DATASET_INVALID");
    ids.add(testCase.caseId);
    const current = testCase.candidates.filter((item) => item.state === "current");
    const stale = testCase.candidates.filter((item) => item.state === "stale");
    if (current.length !== 4 || stale.length !== 4 || new Set(testCase.candidates.map((item) => item.id)).size !== 8) throw failure("DATASET_INVALID");
    if (detectStaleMarker && (current.some((item) => detectStaleMarker(item.text)) || stale.some((item) => !detectStaleMarker(item.text)))) throw failure("DATASET_INVALID");
    if (testCase.category === "pair-present") {
      if (!testCase.expectedPair || current[0].id !== testCase.expectedPair.current || stale[0].id !== testCase.expectedPair.stale) throw failure("DATASET_INVALID");
    } else if (testCase.expectedPair !== null) {
      throw failure("DATASET_INVALID");
    }
  }
  for (const category of CATEGORIES) for (const locale of LOCALES) for (const domain of DOMAINS) {
    if (cells.get(`${category}|${locale}|${domain}`) !== CASES_PER_CELL) throw failure("DATASET_INVALID");
  }
  return cases;
}

export function orderedCandidates(testCase, orderName) {
  if (!ORDER_NAMES.includes(orderName)) throw failure("INVALID_ARGUMENTS");
  const current = testCase.candidates.filter((item) => item.state === "current");
  const stale = testCase.candidates.filter((item) => item.state === "stale");
  return orderName === "reversed" ? [...current].reverse().concat([...stale].reverse()) : [...current, ...stale];
}

function pairEqual(left, right) {
  return left === null || right === null
    ? left === right
    : left.current === right.current && left.stale === right.stale;
}

export function remapVerifiedPair(pair, opaqueIdentityByFile) {
  if (pair === undefined) return null;
  if (!pair || typeof pair !== "object" || !pair.current || !pair.stale) throw failure("PAIR_IDENTITY_INVALID");
  if (pair.current.chunkIndex !== 0 || pair.stale.chunkIndex !== 0) throw failure("PAIR_IDENTITY_INVALID");
  const current = opaqueIdentityByFile.get(pair.current.file);
  const stale = opaqueIdentityByFile.get(pair.stale.file);
  if (!/^[a-f0-9]{16}$/u.test(current ?? "") || !/^[a-f0-9]{16}$/u.test(stale ?? "") || current === stale) throw failure("PAIR_IDENTITY_INVALID");
  return Object.freeze({ current, stale });
}

export function scoreBiasCase(testCase, executions) {
  const original = executions.original;
  const reversed = executions.reversed;
  if (!original || !reversed) throw failure("SELECTOR_EXECUTION_DRIFT");
  const originalCorrect = pairEqual(original.selection, testCase.expectedPair);
  const reversedCorrect = pairEqual(reversed.selection, testCase.expectedPair);
  const agreement = pairEqual(original.selection, reversed.selection);
  return Object.freeze({
    agreement,
    category: testCase.category,
    domain: testCase.domain,
    locale: testCase.locale,
    objectivePassed: originalCorrect && reversedCorrect,
    original: Object.freeze({
      accounting: original.accounting,
      correct: originalCorrect,
      decision: original.decision,
      selectedPair: original.selection !== null,
      selectedCurrentFirst: original.selection !== null && original.selection.current === original.firstCurrentId,
      selectedStaleFirst: original.selection !== null && original.selection.stale === original.firstStaleId
    }),
    reversed: Object.freeze({
      accounting: reversed.accounting,
      correct: reversedCorrect,
      decision: reversed.decision,
      selectedPair: reversed.selection !== null,
      selectedCurrentFirst: reversed.selection !== null && reversed.selection.current === reversed.firstCurrentId,
      selectedStaleFirst: reversed.selection !== null && reversed.selection.stale === reversed.firstStaleId
    })
  });
}

function selectionDiagnostic(outcomes, orderName) {
  const executions = outcomes.map((outcome) => outcome[orderName]);
  return {
    bothFirst: executions.filter((item) => item.selectedCurrentFirst && item.selectedStaleFirst).length,
    currentFirst: executions.filter((item) => item.selectedCurrentFirst).length,
    selectedPairs: executions.filter((item) => item.selectedPair).length,
    staleFirst: executions.filter((item) => item.selectedStaleFirst).length,
    totalExecutions: executions.length
  };
}

function selectorDecisionValid(decision) {
  return decision?.eligible === true
    && decision.logicalInvocations === 1
    && decision.httpAttempts === 1
    && decision.outcome === "success";
}

function sumExecutionAccounting(executions) {
  const initial = {
    answerRequests: 0,
    caseExecutions: 0,
    embeddingRequests: 0,
    eligibleExecutions: 0,
    externalRequests: 0,
    httpAttempts: 0,
    logicalInvocations: 0,
    preloadRequests: 0,
    selectorRequests: 0,
    successfulExecutions: 0,
    unknownRequests: 0
  };
  return executions.reduce((summary, execution) => {
    const accounting = execution.accounting;
    if (!accounting) throw failure("NETWORK_ACCOUNTING_MISMATCH");
    summary.answerRequests += accounting.answerRequests;
    summary.caseExecutions += 1;
    summary.embeddingRequests += accounting.embeddingRequests;
    summary.eligibleExecutions += execution.decision?.eligible === true ? 1 : 0;
    summary.externalRequests += accounting.deniedExternalRequests;
    summary.httpAttempts += Number.isSafeInteger(execution.decision?.httpAttempts) ? execution.decision.httpAttempts : 0;
    summary.logicalInvocations += Number.isSafeInteger(execution.decision?.logicalInvocations) ? execution.decision.logicalInvocations : 0;
    summary.preloadRequests += accounting.preloadRequests;
    summary.selectorRequests += accounting.selectorRequests;
    summary.successfulExecutions += execution.decision?.outcome === "success" ? 1 : 0;
    summary.unknownRequests += accounting.otherLoopbackRequests;
    return summary;
  }, initial);
}

export function summarizeBiasOutcomes(outcomes) {
  if (!Array.isArray(outcomes) || outcomes.length !== CASE_COUNT) throw failure("SELECTOR_EXECUTION_DRIFT");
  const pairPresent = outcomes.filter((item) => item.category === "pair-present");
  const noPair = outcomes.filter((item) => item.category === "no-pair");
  if (pairPresent.length !== 20 || noPair.length !== 20) throw failure("SELECTOR_EXECUTION_DRIFT");
  const row = (items) => ({
    agreement: items.filter((item) => item.agreement).length,
    originalCorrect: items.filter((item) => item.original.correct).length,
    reversedCorrect: items.filter((item) => item.reversed.correct).length,
    total: items.length
  });
  const metrics = { noPair: row(noPair), pairPresent: row(pairPresent) };
  const decisions = outcomes.flatMap((item) => [item.original.decision, item.reversed.decision]);
  const accounting = {
    biasDiagnostic: sumExecutionAccounting(outcomes.map((item) => item.reversed)),
    productionOriginal: sumExecutionAccounting(outcomes.map((item) => item.original))
  };
  const gates = {
    biasDiagnosticAccounting: canonicalJson(accounting.biasDiagnostic) === canonicalJson({
      answerRequests: 0,
      caseExecutions: EXECUTIONS_PER_ORDER,
      embeddingRequests: 0,
      eligibleExecutions: EXECUTIONS_PER_ORDER,
      externalRequests: 0,
      httpAttempts: EXECUTIONS_PER_ORDER,
      logicalInvocations: EXECUTIONS_PER_ORDER,
      preloadRequests: 0,
      selectorRequests: EXECUTIONS_PER_ORDER,
      successfulExecutions: EXECUTIONS_PER_ORDER,
      unknownRequests: 0
    }),
    noPairAgreement: metrics.noPair.agreement === 20,
    noPairOriginalNull: metrics.noPair.originalCorrect === 20,
    noPairReversedNull: metrics.noPair.reversedCorrect === 20,
    pairPresentAgreement: metrics.pairPresent.agreement === 20,
    pairPresentOriginalCorrect: metrics.pairPresent.originalCorrect === 20,
    pairPresentReversedCorrect: metrics.pairPresent.reversedCorrect === 20,
    productionOriginalAccounting: canonicalJson(accounting.productionOriginal) === canonicalJson({
      answerRequests: 0,
      caseExecutions: EXECUTIONS_PER_ORDER,
      embeddingRequests: EXECUTIONS_PER_ORDER,
      eligibleExecutions: EXECUTIONS_PER_ORDER,
      externalRequests: 0,
      httpAttempts: EXECUTIONS_PER_ORDER,
      logicalInvocations: EXECUTIONS_PER_ORDER,
      preloadRequests: EXECUTIONS_PER_ORDER,
      selectorRequests: EXECUTIONS_PER_ORDER,
      successfulExecutions: EXECUTIONS_PER_ORDER,
      unknownRequests: 0
    }),
    selectorExecution: decisions.length === EXECUTION_COUNT && decisions.every(selectorDecisionValid)
  };
  return {
    accounting,
    gates,
    metrics,
    passed: Object.values(gates).every(Boolean),
    positionDiagnostic: {
      firstPositionSelection: {
        original: selectionDiagnostic(outcomes, "original"),
        reversed: selectionDiagnostic(outcomes, "reversed")
      }
    }
  };
}

export function summarizeBuilderDiagnostics(measurements) {
  if (!Array.isArray(measurements) || measurements.length !== EXECUTION_COUNT) throw failure("CHILD_OUTPUT_INVALID");
  const durations = [];
  let maxCandidates = 0;
  let maxComparisons = 0;
  let maxProposals = 0;
  for (const measurement of measurements) {
    const durationMs = measurement?.durationMs;
    const diagnostics = measurement?.diagnostics;
    if (!Number.isFinite(durationMs) || durationMs < 0
      || !Number.isSafeInteger(diagnostics?.candidateCount) || diagnostics.candidateCount < 0
      || !Number.isSafeInteger(diagnostics?.compatibilityComparisons) || diagnostics.compatibilityComparisons < 0
      || !Number.isSafeInteger(diagnostics?.proposalCount) || diagnostics.proposalCount < 0) throw failure("CHILD_OUTPUT_INVALID");
    durations.push(durationMs);
    maxCandidates = Math.max(maxCandidates, diagnostics.candidateCount);
    maxComparisons = Math.max(maxComparisons, diagnostics.compatibilityComparisons);
    maxProposals = Math.max(maxProposals, diagnostics.proposalCount);
  }
  const p95Ms = nearestRank(durations, 0.95);
  return Object.freeze({
    maxCandidates,
    maxComparisons,
    maxMs: Number(Math.max(...durations).toFixed(3)),
    maxProposals,
    p95InformationalBudgetMs: BUILDER_P95_INFORMATIONAL_BUDGET_MS,
    p95Ms,
    p95WithinInformationalBudget: p95Ms <= BUILDER_P95_INFORMATIONAL_BUDGET_MS,
    samples: EXECUTION_COUNT
  });
}

export function validateBuilderDiagnostics(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || canonicalJson(Object.keys(value).sort()) !== canonicalJson([
      "maxCandidates",
      "maxComparisons",
      "maxMs",
      "maxProposals",
      "p95InformationalBudgetMs",
      "p95Ms",
      "p95WithinInformationalBudget",
      "samples"
    ])
    || value.samples !== EXECUTION_COUNT
    || !Number.isFinite(value.p95Ms) || value.p95Ms < 0
    || !Number.isFinite(value.maxMs) || value.maxMs < value.p95Ms
    || value.p95InformationalBudgetMs !== BUILDER_P95_INFORMATIONAL_BUDGET_MS
    || value.p95WithinInformationalBudget !== (value.p95Ms <= BUILDER_P95_INFORMATIONAL_BUDGET_MS)
    || !Number.isSafeInteger(value.maxComparisons) || value.maxComparisons < 0
    || !Number.isSafeInteger(value.maxProposals) || value.maxProposals < 0
    || !Number.isSafeInteger(value.maxCandidates) || value.maxCandidates < 0) throw failure("CHILD_OUTPUT_INVALID");
  return value;
}

function builderCapsPassed(value) {
  return value.maxComparisons <= BUILDER_HARD_CAPS.maxComparisons
    && value.maxProposals <= BUILDER_HARD_CAPS.maxProposals
    && value.maxCandidates <= BUILDER_HARD_CAPS.maxCandidates;
}

const NETWORK_KEYS = Object.freeze([
  "answerRequests",
  "controlRequests",
  "deniedExternalRequests",
  "embeddingRequests",
  "otherLoopbackRequests",
  "preloadRequests",
  "selectorRequests",
  "totalLoopbackRequests"
]);

export function validateBiasDiagnosticAccounting(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || canonicalJson(Object.keys(value).sort()) !== canonicalJson([...NETWORK_KEYS].sort())) throw failure("NETWORK_ACCOUNTING_MISMATCH");
  if (NETWORK_KEYS.some((key) => !Number.isSafeInteger(value[key]) || value[key] < 0)) throw failure("NETWORK_ACCOUNTING_MISMATCH");
  const summed = value.answerRequests + value.controlRequests + value.embeddingRequests + value.otherLoopbackRequests + value.preloadRequests + value.selectorRequests;
  if (value.totalLoopbackRequests !== summed
    || value.answerRequests !== 0
    || value.deniedExternalRequests !== 0
    || value.otherLoopbackRequests !== 0
    || value.controlRequests !== 2
    || value.embeddingRequests !== EXECUTIONS_PER_ORDER
    || value.preloadRequests !== EXECUTIONS_PER_ORDER
    || value.selectorRequests > EXECUTION_COUNT) throw failure("NETWORK_ACCOUNTING_MISMATCH");
  return value;
}

const CHILD_DECISION_OUTCOMES = Object.freeze(["empty", "error", "invalid", "success", "timeout"]);

function validateChildExecution(value, orderName) {
  requireExactKeys(value, ["accounting", "correct", "decision", "selectedCurrentFirst", "selectedPair", "selectedStaleFirst"]);
  if (typeof value.correct !== "boolean" || typeof value.selectedCurrentFirst !== "boolean" || typeof value.selectedPair !== "boolean" || typeof value.selectedStaleFirst !== "boolean") throw failure("CHILD_OUTPUT_INVALID");
  requireExactKeys(value.accounting, NETWORK_KEYS);
  const productionOriginal = orderName === "original";
  const expectedAccounting = {
    answerRequests: 0,
    controlRequests: 0,
    deniedExternalRequests: 0,
    embeddingRequests: productionOriginal ? 1 : 0,
    otherLoopbackRequests: 0,
    preloadRequests: productionOriginal ? 1 : 0,
    selectorRequests: 1,
    totalLoopbackRequests: productionOriginal ? 3 : 1
  };
  if (canonicalJson(value.accounting) !== canonicalJson(expectedAccounting)) throw failure("CHILD_OUTPUT_INVALID");
  requireExactKeys(value.decision, ["eligible", "httpAttempts", "logicalInvocations", "outcome"]);
  if (value.decision.eligible !== true
    || value.decision.httpAttempts !== 1
    || value.decision.logicalInvocations !== 1
    || !CHILD_DECISION_OUTCOMES.includes(value.decision.outcome)) throw failure("CHILD_OUTPUT_INVALID");
  return value;
}

export function validateChildPayload(value) {
  requireExactKeys(value, ["builderDiagnostics", "model", "networkAccounting", "outcomes", "schemaVersion"]);
  if (value.schemaVersion !== CHILD_SCHEMA_VERSION || !Array.isArray(value.outcomes) || value.outcomes.length !== CASE_COUNT) throw failure("CHILD_OUTPUT_INVALID");
  validateBuilderDiagnostics(value.builderDiagnostics);
  validateModelDescriptor(value.model);
  validateBiasDiagnosticAccounting(value.networkAccounting);
  if (value.networkAccounting.embeddingRequests !== EXECUTIONS_PER_ORDER
    || value.networkAccounting.preloadRequests !== EXECUTIONS_PER_ORDER
    || value.networkAccounting.selectorRequests !== EXECUTION_COUNT
    || value.networkAccounting.totalLoopbackRequests !== 2 + EXECUTIONS_PER_ORDER * 2 + EXECUTION_COUNT) throw failure("CHILD_OUTPUT_INVALID");
  for (let index = 0; index < value.outcomes.length; index += 1) {
    const outcome = value.outcomes[index];
    const expected = POSITION_BIAS_DATASET[index];
    requireExactKeys(outcome, ["agreement", "category", "domain", "locale", "objectivePassed", "original", "reversed"]);
    if (!expected
      || outcome.category !== expected.category
      || outcome.domain !== expected.domain
      || outcome.locale !== expected.locale
      || typeof outcome.agreement !== "boolean"
      || typeof outcome.objectivePassed !== "boolean") throw failure("CHILD_OUTPUT_INVALID");
    validateChildExecution(outcome.original, "original");
    validateChildExecution(outcome.reversed, "reversed");
    if (outcome.objectivePassed !== (outcome.original.correct && outcome.reversed.correct)) throw failure("CHILD_OUTPUT_INVALID");
  }
  if (/\/Users\/|\/home\/|candidateText|rawCandidate|rawPrompt|promptText|notesDir|queryText/iu.test(canonicalJson(value))) throw failure("CHILD_OUTPUT_INVALID");
  return value;
}

export function validateOwnerState(ownerState) {
  if (!ownerState || typeof ownerState.beforeSha256 !== "string" || typeof ownerState.afterSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(ownerState.beforeSha256) || !/^[a-f0-9]{64}$/u.test(ownerState.afterSha256)) throw failure("OWNER_STATE_CHECK_FAILED");
  if (!ownerState.unchanged || ownerState.beforeSha256 !== ownerState.afterSha256) throw failure("OWNER_STATE_CHANGED");
  return ownerState;
}

export async function runWithOwnerStateGuard({ afterPath, beforePath, capture = manifestTree, ownerRoot, run, write = writeAtomic }) {
  let before;
  let operationError;
  let ownerState;
  let value;
  try {
    before = await capture(ownerRoot);
    await write(beforePath, jsonBytes({ manifestSha256: before.manifestSha256 }));
    value = await run();
  } catch (error) {
    operationError = error;
  } finally {
    if (!before) {
      operationError = failure("OWNER_STATE_CHECK_FAILED");
    } else {
      try {
        const after = await capture(ownerRoot);
        await write(afterPath, jsonBytes({ manifestSha256: after.manifestSha256 }));
        ownerState = validateOwnerState({
          afterSha256: after.manifestSha256,
          beforeSha256: before.manifestSha256,
          unchanged: before.manifestSha256 === after.manifestSha256
        });
      } catch (error) {
        operationError = positionBiasFailureCode(error) === "OWNER_STATE_CHANGED" ? error : failure("OWNER_STATE_CHECK_FAILED");
      }
    }
  }
  if (operationError) throw operationError;
  return { ownerState, value };
}

export async function runWithIsolationCleanup({
  allowedRoot = diagnosticsRoot,
  home,
  inspect = lstat,
  remove = rm,
  run,
  sessionDir
}) {
  const resolvedAllowedRoot = resolve(allowedRoot);
  const resolvedSessionDir = resolve(sessionDir);
  const resolvedHome = resolve(home);
  const sessionRelative = relative(resolvedAllowedRoot, resolvedSessionDir);
  if (!sessionRelative || sessionRelative.startsWith("..") || isAbsolute(sessionRelative) || resolvedHome !== join(resolvedSessionDir, "home")) {
    throw failure("ISOLATION_CLEANUP_FAILED");
  }
  let operationError;
  let value;
  try {
    value = await run();
  } catch (error) {
    operationError = error;
  } finally {
    try {
      await remove(resolvedHome, { force: true, recursive: true });
      try {
        await inspect(resolvedHome);
        throw failure("ISOLATION_CLEANUP_FAILED");
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
        if (code !== "ENOENT") throw failure("ISOLATION_CLEANUP_FAILED");
      }
    } catch {
      operationError = failure("ISOLATION_CLEANUP_FAILED");
    }
  }
  if (operationError) throw operationError;
  return value;
}

export function buildDevelopmentResult({ builderDiagnostics, model, networkAccounting, outcomes, ownerState, runMetadata, runtimeSources }) {
  validateOwnerState(ownerState);
  validateBuilderDiagnostics(builderDiagnostics);
  const biasDiagnostic = validateBiasDiagnosticAccounting(networkAccounting);
  const summary = summarizeBiasOutcomes(outcomes);
  const accountingGate = biasDiagnostic.selectorRequests === EXECUTION_COUNT;
  const builderGate = builderCapsPassed(builderDiagnostics);
  const payload = {
    accounting: {
      biasDiagnostic: summary.accounting.biasDiagnostic,
      modelControl: { controlRequests: biasDiagnostic.controlRequests },
      productionOriginal: summary.accounting.productionOriginal,
      totals: {
        answerRequests: biasDiagnostic.answerRequests,
        embeddingRequests: biasDiagnostic.embeddingRequests,
        externalRequests: biasDiagnostic.deniedExternalRequests,
        preloadRequests: biasDiagnostic.preloadRequests,
        selectorRequests: biasDiagnostic.selectorRequests,
        unknownRequests: biasDiagnostic.otherLoopbackRequests
      }
    },
    builderDiagnostics,
    dataset: {
      cases: CASE_COUNT,
      datasetSha256: DATASET_SHA256,
      heldOut: false,
      matrix: { casesPerCell: CASES_PER_CELL, categories: CATEGORIES, domains: DOMAINS, locales: LOCALES },
      organicEvidence: false,
      origin: "visible synthetic development fixture"
    },
    executionStatus: "COMPLETE",
    model,
    ownerState,
    positionDiagnostic: summary.positionDiagnostic,
    qualification: {
      developmentGatesPassed: summary.passed && accountingGate && builderGate,
      gates: { ...summary.gates, builderCaps: builderGate, totalAccounting: accountingGate, ownerState: true },
      metrics: summary.metrics,
      organicEvidence: false,
      status: "DEVELOPMENT_ONLY"
    },
    runtimeSources
  };
  return { payload, payloadHash: sha256(jsonBytes(payload)), runMetadata, schemaVersion: RESULT_SCHEMA_VERSION };
}

export function validateDevelopmentResult(result) {
  requireExactKeys(result, ["payload", "payloadHash", "runMetadata", "schemaVersion"]);
  if (!result || result.schemaVersion !== RESULT_SCHEMA_VERSION || result.payloadHash !== sha256(jsonBytes(result.payload))) throw failure("CHILD_OUTPUT_INVALID");
  if (!/^[a-f0-9]{64}$/u.test(result.payloadHash)) throw failure("CHILD_OUTPUT_INVALID");
  requireExactKeys(result.runMetadata, ["generatedAt", "node", "platform"]);
  if (typeof result.runMetadata.generatedAt !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(result.runMetadata.generatedAt)
    || !Number.isFinite(Date.parse(result.runMetadata.generatedAt))
    || typeof result.runMetadata.node !== "string" || !/^v\d+(?:\.\d+){1,3}(?:[-+][a-z0-9.-]+)?$/iu.test(result.runMetadata.node)
    || typeof result.runMetadata.platform !== "string" || !/^[a-z0-9_-]+\/[a-z0-9_-]+$/iu.test(result.runMetadata.platform)) throw failure("CHILD_OUTPUT_INVALID");
  requireExactKeys(result.payload, [
    "accounting",
    "builderDiagnostics",
    "dataset",
    "executionStatus",
    "model",
    "ownerState",
    "positionDiagnostic",
    "qualification",
    "runtimeSources"
  ]);
  const { accounting, builderDiagnostics, dataset, executionStatus, model, ownerState, positionDiagnostic, qualification, runtimeSources } = result.payload;
  requireExactKeys(dataset, ["cases", "datasetSha256", "heldOut", "matrix", "organicEvidence", "origin"]);
  if (executionStatus !== "COMPLETE" || dataset.cases !== CASE_COUNT || dataset.datasetSha256 !== DATASET_SHA256 || dataset.heldOut !== false || dataset.organicEvidence !== false || dataset.origin !== "visible synthetic development fixture") throw failure("CHILD_OUTPUT_INVALID");
  requireExactKeys(dataset.matrix, ["casesPerCell", "categories", "domains", "locales"]);
  if (canonicalJson(dataset.matrix) !== canonicalJson({ casesPerCell: CASES_PER_CELL, categories: CATEGORIES, domains: DOMAINS, locales: LOCALES })) throw failure("CHILD_OUTPUT_INVALID");
  validateBuilderDiagnostics(builderDiagnostics);
  requireExactKeys(accounting, ["biasDiagnostic", "modelControl", "productionOriginal", "totals"]);
  const bias = accounting?.biasDiagnostic;
  const production = accounting?.productionOriginal;
  const totals = accounting?.totals;
  const orderAccountingKeys = ["answerRequests", "caseExecutions", "embeddingRequests", "eligibleExecutions", "externalRequests", "httpAttempts", "logicalInvocations", "preloadRequests", "selectorRequests", "successfulExecutions", "unknownRequests"];
  requireExactKeys(bias, orderAccountingKeys);
  requireExactKeys(production, orderAccountingKeys);
  requireExactKeys(accounting.modelControl, ["controlRequests"]);
  requireExactKeys(totals, ["answerRequests", "embeddingRequests", "externalRequests", "preloadRequests", "selectorRequests", "unknownRequests"]);
  const validOrderAccounting = (value, embeddingRequests, preloadRequests) => value
    && value.answerRequests === 0
    && value.caseExecutions === EXECUTIONS_PER_ORDER
    && value.embeddingRequests === embeddingRequests
    && value.externalRequests === 0
    && value.preloadRequests === preloadRequests
    && value.selectorRequests === EXECUTIONS_PER_ORDER
    && value.unknownRequests === 0
    && ["eligibleExecutions", "httpAttempts", "logicalInvocations", "successfulExecutions"].every((key) => Number.isSafeInteger(value[key]) && value[key] >= 0 && value[key] <= EXECUTIONS_PER_ORDER);
  if (!validOrderAccounting(bias, 0, 0)
    || !validOrderAccounting(production, EXECUTIONS_PER_ORDER, EXECUTIONS_PER_ORDER)
    || canonicalJson(accounting?.modelControl) !== canonicalJson({ controlRequests: 2 })
    || canonicalJson(totals) !== canonicalJson({ answerRequests: 0, embeddingRequests: EXECUTIONS_PER_ORDER, externalRequests: 0, preloadRequests: EXECUTIONS_PER_ORDER, selectorRequests: EXECUTION_COUNT, unknownRequests: 0 })) throw failure("NETWORK_ACCOUNTING_MISMATCH");
  const metrics = qualification?.metrics;
  requireExactKeys(qualification, ["developmentGatesPassed", "gates", "metrics", "organicEvidence", "status"]);
  requireExactKeys(qualification.gates, ["biasDiagnosticAccounting", "builderCaps", "noPairAgreement", "noPairOriginalNull", "noPairReversedNull", "ownerState", "pairPresentAgreement", "pairPresentOriginalCorrect", "pairPresentReversedCorrect", "productionOriginalAccounting", "selectorExecution", "totalAccounting"]);
  if (Object.values(qualification.gates).some((value) => typeof value !== "boolean") || typeof qualification.developmentGatesPassed !== "boolean") throw failure("CHILD_OUTPUT_INVALID");
  requireExactKeys(metrics, ["noPair", "pairPresent"]);
  requireExactKeys(metrics.noPair, ["agreement", "originalCorrect", "reversedCorrect", "total"]);
  requireExactKeys(metrics.pairPresent, ["agreement", "originalCorrect", "reversedCorrect", "total"]);
  if (metrics?.pairPresent?.total !== 20 || metrics?.noPair?.total !== 20) throw failure("CHILD_OUTPUT_INVALID");
  for (const row of [metrics.pairPresent, metrics.noPair]) for (const key of ["agreement", "originalCorrect", "reversedCorrect"]) if (!Number.isSafeInteger(row[key]) || row[key] < 0 || row[key] > row.total) throw failure("CHILD_OUTPUT_INVALID");
  if (qualification.status !== "DEVELOPMENT_ONLY" || qualification.organicEvidence !== false) throw failure("CHILD_OUTPUT_INVALID");
  requireExactKeys(positionDiagnostic, ["firstPositionSelection"]);
  requireExactKeys(positionDiagnostic.firstPositionSelection, ORDER_NAMES);
  const firstPosition = positionDiagnostic?.firstPositionSelection;
  for (const orderName of ORDER_NAMES) {
    const diagnostic = firstPosition?.[orderName];
    requireExactKeys(diagnostic, ["bothFirst", "currentFirst", "selectedPairs", "staleFirst", "totalExecutions"]);
    if (!diagnostic || diagnostic.totalExecutions !== EXECUTIONS_PER_ORDER) throw failure("CHILD_OUTPUT_INVALID");
    for (const key of ["bothFirst", "currentFirst", "selectedPairs", "staleFirst"]) {
      if (!Number.isSafeInteger(diagnostic[key]) || diagnostic[key] < 0 || diagnostic[key] > EXECUTIONS_PER_ORDER) throw failure("CHILD_OUTPUT_INVALID");
    }
    if (diagnostic.bothFirst > diagnostic.currentFirst || diagnostic.bothFirst > diagnostic.staleFirst || diagnostic.currentFirst > diagnostic.selectedPairs || diagnostic.staleFirst > diagnostic.selectedPairs) throw failure("CHILD_OUTPUT_INVALID");
  }
  const expectedGates = {
    biasDiagnosticAccounting: bias.eligibleExecutions === EXECUTIONS_PER_ORDER && bias.httpAttempts === EXECUTIONS_PER_ORDER && bias.logicalInvocations === EXECUTIONS_PER_ORDER && bias.successfulExecutions === EXECUTIONS_PER_ORDER,
    builderCaps: builderCapsPassed(builderDiagnostics),
    noPairAgreement: metrics.noPair.agreement === 20,
    noPairOriginalNull: metrics.noPair.originalCorrect === 20,
    noPairReversedNull: metrics.noPair.reversedCorrect === 20,
    ownerState: true,
    pairPresentAgreement: metrics.pairPresent.agreement === 20,
    pairPresentOriginalCorrect: metrics.pairPresent.originalCorrect === 20,
    pairPresentReversedCorrect: metrics.pairPresent.reversedCorrect === 20,
    productionOriginalAccounting: production.eligibleExecutions === EXECUTIONS_PER_ORDER && production.httpAttempts === EXECUTIONS_PER_ORDER && production.logicalInvocations === EXECUTIONS_PER_ORDER && production.successfulExecutions === EXECUTIONS_PER_ORDER,
    selectorExecution: bias.successfulExecutions === EXECUTIONS_PER_ORDER && production.successfulExecutions === EXECUTIONS_PER_ORDER,
    totalAccounting: totals.selectorRequests === EXECUTION_COUNT
  };
  if (canonicalJson(qualification.gates) !== canonicalJson(expectedGates) || qualification.developmentGatesPassed !== Object.values(expectedGates).every(Boolean)) throw failure("CHILD_OUTPUT_INVALID");
  validateModelDescriptor(model);
  requireExactKeys(ownerState, ["afterSha256", "beforeSha256", "unchanged"]);
  validateOwnerState(ownerState);
  if (!Array.isArray(runtimeSources)
    || canonicalJson(runtimeSources.map((source) => source?.sourceId)) !== canonicalJson(RUNTIME_SOURCE_IDS)
    || runtimeSources.some((source) => {
      try { requireExactKeys(source, ["sha256", "sourceId"]); }
      catch { return true; }
      return !/^[a-f0-9]{64}$/u.test(source.sha256);
    })) throw failure("CHILD_OUTPUT_INVALID");
  const serialized = canonicalJson(result);
  if (/\/Users\/|\/home\/|candidateText|rawPrompt|promptText|notesDir|queryText/iu.test(serialized)) throw failure("CHILD_OUTPUT_INVALID");
  return result;
}

export function positionBiasFailureCode(error) {
  try {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    return typeof code === "string" && FAILURE_CODES.includes(code) ? code : "POSITION_BIAS_EVAL_FAILED";
  } catch {
    return "POSITION_BIAS_EVAL_FAILED";
  }
}

export function formatPositionBiasFailure(error) {
  return `${positionBiasFailureCode(error)}\n`;
}

function requestUrl(input) {
  if (typeof input === "string" || input instanceof URL) return new URL(input);
  if (typeof Request !== "undefined" && input instanceof Request) return new URL(input.url);
  throw failure("SELECTOR_EXECUTION_DRIFT");
}

function requestBody(init) {
  if (typeof init?.body !== "string") return undefined;
  try {
    const parsed = JSON.parse(init.body);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function buildExpectedSelectorCards(candidateTexts, allowedPairs) {
  if (!Array.isArray(candidateTexts) || !Array.isArray(allowedPairs) || allowedPairs.length < 1 || allowedPairs.length > 6) throw failure("SELECTOR_ORDER_DRIFT");
  const sorted = [...allowedPairs].sort((left, right) => left.current - right.current || left.stale - right.stale);
  return sorted.map((pair, index) => {
    if (!Number.isSafeInteger(pair.current)
      || !Number.isSafeInteger(pair.stale)
      || pair.current < 0
      || pair.stale < 0
      || pair.current >= candidateTexts.length
      || pair.stale >= candidateTexts.length
      || pair.current === pair.stale
      || typeof candidateTexts[pair.current] !== "string"
      || typeof candidateTexts[pair.stale] !== "string") throw failure("SELECTOR_ORDER_DRIFT");
    return [
      `PAIR CARD ${(index + 1).toString()}`,
      `exact tuple: ${JSON.stringify({ current: pair.current + 1, stale: pair.stale + 1 })}`,
      `current text [${(pair.current + 1).toString()}]: ${candidateTexts[pair.current]}`,
      `stale text [${(pair.stale + 1).toString()}]: ${candidateTexts[pair.stale]}`
    ].join("\n");
  });
}

function createDevelopmentTransport(baseUrl, fetchImpl = globalThis.fetch) {
  const canonicalBase = canonicalLoopbackBaseUrl(baseUrl);
  const allowed = new URL(canonicalBase);
  let expectedSelectorCards;
  let verifiedSelectorOrders = 0;
  return {
    expectSelectorCards(candidateTexts, allowedPairs) {
      if (expectedSelectorCards) throw failure("SELECTOR_ORDER_DRIFT");
      expectedSelectorCards = buildExpectedSelectorCards(candidateTexts, allowedPairs);
    },
    fetch: async (input, init = {}) => {
      const url = requestUrl(input);
      if (url.origin !== allowed.origin) throw failure("NETWORK_ACCOUNTING_MISMATCH");
      if (url.pathname.endsWith("/api/embeddings")) {
        return new Response(JSON.stringify({ embedding: [1, 0] }), { headers: { "content-type": "application/json" }, status: 200 });
      }
      const body = requestBody(init);
      if (url.pathname.endsWith("/api/generate") && typeof body?.prompt === "string") {
        if (!expectedSelectorCards) throw failure("SELECTOR_ORDER_DRIFT");
        const cardLabels = body.prompt.match(/PAIR CARD \d+/gu) ?? [];
        if (cardLabels.length !== expectedSelectorCards.length
          || body.prompt.includes("CURRENT / NON-STALE CANDIDATES")
          || body.prompt.includes("EXPLICIT-STALE CANDIDATES")) throw failure("SELECTOR_ORDER_DRIFT");
        let cursor = -1;
        for (const card of expectedSelectorCards) {
          const position = body.prompt.indexOf(card);
          if (position <= cursor || body.prompt.lastIndexOf(card) !== position) throw failure("SELECTOR_ORDER_DRIFT");
          cursor = position;
        }
        expectedSelectorCards = undefined;
        verifiedSelectorOrders += 1;
      }
      return fetchImpl(input, init);
    },
    verifyIdle() {
      if (expectedSelectorCards) throw failure("SELECTOR_ORDER_DRIFT");
      return verifiedSelectorOrders;
    }
  };
}

function childEnvironment({ baseUrl, home, rerankerModel }) {
  return {
    HOME: home,
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
    MUSE_CLI_CONFIG_FILE: join(home, "config.json"),
    MUSE_LOCAL_ONLY: "true",
    MUSE_MODEL: `ollama/${rerankerModel}`,
    MUSE_MODEL_KEYS_FILE: join(home, "models.json"),
    MUSE_RECALL_GRAPH_HOP: "false",
    MUSE_RECALL_RERANK: "true",
    MUSE_RECALL_SECOND_HOP: "false",
    OLLAMA_BASE_URL: baseUrl,
    PATH: process.env.PATH ?? "",
    TMPDIR: join(home, "tmp")
  };
}

async function createExecutionFixture(testCase, home) {
  const root = join(home, "notes", testCase.caseId);
  await mkdir(root, { mode: 0o700, recursive: true });
  const ordered = orderedCandidates(testCase, "original");
  const identityByFile = new Map();
  const indexFiles = [];
  for (let index = 0; index < ordered.length; index += 1) {
    const item = ordered[index];
    const path = join(root, `${item.id}.md`);
    await writeAtomic(path, `${item.text}\n`);
    identityByFile.set(path, item.id);
    indexFiles.push({ chunks: [{ chunkIndex: 0, embedding: [1, 0], file: path, text: item.text }], path });
  }
  return {
    candidateIdByFile: new Map([...identityByFile].map(([path, id]) => [path, id])),
    candidateTextByFile: new Map(indexFiles.map((file) => [file.path, file.chunks[0].text])),
    correctionCandidates: indexFiles.map((file, index) => ({
      embedding: file.chunks[0].embedding,
      identity: { chunkIndex: 0, file: file.path },
      queryScore: 1,
      stale: ordered[index].state === "stale"
    })),
    identityByFile,
    indexFiles,
    notesDir: root
  };
}

function validateExecutionDelta(before, after, orderName) {
  const delta = Object.fromEntries(NETWORK_KEYS.map((key) => [key, after[key] - before[key]]));
  const productionOriginal = orderName === "original";
  if (delta.answerRequests !== 0
    || delta.controlRequests !== 0
    || delta.deniedExternalRequests !== 0
    || delta.embeddingRequests !== (productionOriginal ? 1 : 0)
    || delta.otherLoopbackRequests !== 0
    || delta.preloadRequests !== (productionOriginal ? 1 : 0)
    || delta.selectorRequests > 1
    || delta.totalLoopbackRequests !== (productionOriginal ? 2 : 0) + delta.selectorRequests) throw failure("NETWORK_ACCOUNTING_MISMATCH");
  return delta;
}

async function childMain({ baseUrl, home, outputPath, rerankerModel }) {
  if (!home || process.env.HOME !== home || !process.env.TMPDIR?.startsWith(home)) throw failure("INVALID_ARGUMENTS");
  const [recall, cliRetrieval] = await Promise.all([
    import("../packages/recall/dist/index.js"),
    import("../apps/cli/dist/ask-note-retrieval.js")
  ]);
  validateDataset(POSITION_BIAS_DATASET, recall.detectStaleMarker);
  const runtimeEnv = Object.freeze(childEnvironment({ baseUrl, home, rerankerModel }));
  const resolved = cliRetrieval.resolveRerankModel(runtimeEnv);
  if (resolved !== rerankerModel) throw failure("RERANKER_RESOLUTION_DRIFT");
  const transport = createDevelopmentTransport(baseUrl);
  const audit = createAuditedLoopbackFetch(baseUrl, transport.fetch);
  const provenance = await modelInfo(baseUrl, rerankerModel, audit.fetch);
  const reversedRerankFn = cliRetrieval.createRecallRerankFn(runtimeEnv, { fetchFn: audit.fetch });
  if (!reversedRerankFn || reversedRerankFn.mode !== "correction-pair") throw failure("RERANKER_RESOLUTION_DRIFT");
  const builderMeasurements = [];
  const outcomes = [];
  for (const testCase of POSITION_BIAS_DATASET) {
    const fixture = await createExecutionFixture(testCase, home);
    const executions = {};
    for (const orderName of ORDER_NAMES) {
      const shortlistOrder = orderName === "original" ? "original" : "reversed-within-groups";
      const builderStarted = performance.now();
      const shortlist = recall.buildCorrectionPairShortlist(fixture.correctionCandidates, shortlistOrder);
      const builderDurationMs = Math.max(0, performance.now() - builderStarted);
      if (!shortlist) throw failure("SELECTOR_ORDER_DRIFT");
      const rerankContext = recall.buildCorrectionPairRerankContext(shortlist);
      if (!rerankContext) throw failure("SELECTOR_ORDER_DRIFT");
      builderMeasurements.push({ diagnostics: shortlist.diagnostics, durationMs: builderDurationMs });
      const orderedCandidatesForSelector = shortlist.windowIndices.map((index) => fixture.correctionCandidates[index]);
      const candidateTexts = orderedCandidatesForSelector.map((candidate) => fixture.candidateTextByFile.get(candidate.identity.file));
      if (candidateTexts.some((text) => typeof text !== "string")) throw failure("SELECTOR_ORDER_DRIFT");
      transport.expectSelectorCards(candidateTexts, rerankContext.allowedCorrectionPairs);
      const before = audit.snapshot();
      let decision;
      let verifiedCorrectionPair;
      if (orderName === "original") {
        const result = await cliRetrieval.retrieveAndRankNotes({
          conflictAwareSelection: true,
          embedModel: EMBED_MODEL,
          indexFiles: fixture.indexFiles,
          json: true,
          notesDir: fixture.notesDir,
          onStderr: () => {},
          query: testCase.query,
          scope: undefined,
          topK: TOP_K
        }, { env: runtimeEnv, fetchFn: audit.fetch });
        decision = result.rerankDecision;
        verifiedCorrectionPair = result.verifiedCorrectionPair;
      } else {
        const rawExecution = await reversedRerankFn(testCase.query, candidateTexts, rerankContext);
        if (!rawExecution || typeof rawExecution !== "object" || Array.isArray(rawExecution) || !("outcome" in rawExecution)) throw failure("SELECTOR_EXECUTION_DRIFT");
        const resolvedSelection = recall.resolveCorrectionPairSelection(fixture.correctionCandidates, shortlist, rawExecution);
        if (rawExecution.outcome === "success" && !resolvedSelection) throw failure("PAIR_IDENTITY_INVALID");
        decision = {
          eligible: true,
          httpAttempts: rawExecution.httpAttempts,
          logicalInvocations: 1,
          outcome: rawExecution.outcome
        };
        verifiedCorrectionPair = resolvedSelection?.outcome === "pair" ? resolvedSelection.verifiedCorrectionPair : undefined;
      }
      const after = audit.snapshot();
      const accounting = validateExecutionDelta(before, after, orderName);
      transport.verifyIdle();
      const firstCurrent = orderedCandidatesForSelector.find((candidate) => !candidate.stale);
      const firstStale = orderedCandidatesForSelector.find((candidate) => candidate.stale);
      if (!firstCurrent || !firstStale) throw failure("SELECTOR_ORDER_DRIFT");
      const firstCurrentId = fixture.candidateIdByFile.get(firstCurrent.identity.file);
      const firstStaleId = fixture.candidateIdByFile.get(firstStale.identity.file);
      if (!/^[a-f0-9]{16}$/u.test(firstCurrentId ?? "") || !/^[a-f0-9]{16}$/u.test(firstStaleId ?? "")) throw failure("PAIR_IDENTITY_INVALID");
      executions[orderName] = {
        accounting,
        decision,
        firstCurrentId,
        firstStaleId,
        selection: remapVerifiedPair(verifiedCorrectionPair, fixture.identityByFile)
      };
    }
    outcomes.push(scoreBiasCase(testCase, executions));
  }
  if (transport.verifyIdle() !== EXECUTION_COUNT) throw failure("SELECTOR_ORDER_DRIFT");
  const networkAccounting = audit.snapshot();
  validateBiasDiagnosticAccounting(networkAccounting);
  const child = {
    builderDiagnostics: summarizeBuilderDiagnostics(builderMeasurements),
    model: { ...provenance, modelTag: rerankerModel, resolution: "actual-default" },
    networkAccounting,
    outcomes,
    schemaVersion: CHILD_SCHEMA_VERSION
  };
  validateChildPayload(child);
  await writeAtomic(outputPath, jsonBytes(child));
}

function parseInternalArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!args[index]?.startsWith("--") || args[index + 1] === undefined) throw failure("INVALID_ARGUMENTS");
    options[args[index].slice(2)] = args[index + 1];
  }
  return options;
}

function childFailure(reasonCode) {
  if (reasonCode === "TIMEOUT") return failure("CHILD_TIMEOUT");
  if (reasonCode === "PARTIAL_OUTPUT") return failure("CHILD_OUTPUT_MISSING");
  return failure("CHILD_TRIAL_FAILED");
}

async function parentMain() {
  const { resolveRerankModel } = await import("../apps/cli/dist/ask-note-retrieval.js");
  const started = Date.now();
  const sessionDir = join(diagnosticsRoot, new Date().toISOString().replaceAll(/[:.]/gu, "-"));
  const home = join(sessionDir, "home");
  await mkdir(join(home, "tmp"), { mode: 0o700, recursive: true });
  const outputPath = join(sessionDir, "child.json");
  const baseUrl = canonicalLoopbackBaseUrl(process.env.OLLAMA_BASE_URL?.trim() || "http://127.0.0.1:11434");
  const guarded = await runWithIsolationCleanup({
    home,
    run: async () => {
      return runWithOwnerStateGuard({
        afterPath: join(sessionDir, "owner-after.json"),
        beforePath: join(sessionDir, "owner-before.json"),
        ownerRoot: join(homedir(), ".muse"),
        run: async () => {
          const rerankerModel = resolveRerankModel(Object.freeze({ ...process.env, MUSE_RECALL_RERANK: "true" }));
          if (!rerankerModel) throw failure("DEFAULT_RERANKER_UNAVAILABLE");
          const child = await spawnWithTimeout(process.execPath, [fileURLToPath(import.meta.url), "--child", "1", "--home", home, "--out", outputPath, "--reranker-model", rerankerModel], {
            env: childEnvironment({ baseUrl, home, rerankerModel }),
            outputPath,
            timeoutMs: Math.min(CHILD_TIMEOUT_MS, Math.max(1, PARENT_TIMEOUT_MS - (Date.now() - started)))
          });
          if (!child.ok) throw childFailure(child.reasonCode);
          try {
            const value = JSON.parse(await readFile(outputPath, "utf8"));
            return validateChildPayload(value);
          } catch (error) {
            if (positionBiasFailureCode(error) === "CHILD_OUTPUT_INVALID") throw error;
            throw failure("CHILD_OUTPUT_INVALID");
          }
        }
      });
    },
    sessionDir
  });
  if (Date.now() - started >= PARENT_TIMEOUT_MS) throw failure("CHILD_TIMEOUT");
  const sources = await runtimeSourceProvenance(repoRoot, RUNTIME_SOURCE_IDS);
  const result = buildDevelopmentResult({
    builderDiagnostics: guarded.value.builderDiagnostics,
    model: guarded.value.model,
    networkAccounting: guarded.value.networkAccounting,
    outcomes: guarded.value.outcomes,
    ownerState: guarded.ownerState,
    runMetadata: { generatedAt: new Date().toISOString(), node: process.version, platform: `${process.platform}/${process.arch}` },
    runtimeSources: sources.map(({ path, sha256: digest }) => ({ sha256: digest, sourceId: path }))
  });
  validateDevelopmentResult(result);
  const resultPath = join(sessionDir, "result.json");
  await writeAtomic(resultPath, jsonBytes(result));
  process.stdout.write(`${canonicalJson({
    artifact: join(DIAGNOSTICS_ROOT_RELATIVE, sessionDir.slice(diagnosticsRoot.length + 1), "result.json"),
    developmentGatesPassed: result.payload.qualification.developmentGatesPassed,
    status: result.payload.executionStatus
  })}\n`);
  if (!result.payload.qualification.developmentGatesPassed) process.exitCode = 1;
}

async function main() {
  const args = process.argv.slice(2).filter((item) => item !== "--");
  if (args[0] === "--child") {
    const options = parseInternalArgs(args.slice(2));
    if (!options.home || !options.out || !options["reranker-model"]) throw failure("INVALID_ARGUMENTS");
    await childMain({ baseUrl: canonicalLoopbackBaseUrl(process.env.OLLAMA_BASE_URL), home: options.home, outputPath: options.out, rerankerModel: options["reranker-model"] });
    return;
  }
  if (args.length !== 0) throw failure("INVALID_ARGUMENTS");
  await parentMain();
}

if (pathToFileURL(process.argv[1] ?? "").href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(formatPositionBiasFailure(error));
    process.exitCode = 1;
  });
}
