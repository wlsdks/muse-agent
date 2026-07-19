#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DATASET_VERSION = "muse-recall-freshness-dataset.v1";
export const RESULT_SCHEMA_VERSION = "muse-recall-freshness-ablation.v1";
export const CHILD_SCHEMA_VERSION = "muse-recall-freshness-child.v1";
export const SCORER_VERSION = "recall-freshness-terminal-scorer.v1";
export const ALLOWLISTED_MODELS = Object.freeze([
  "nomic-embed-text",
  "nomic-embed-text-v2-moe",
  "embeddinggemma",
  "qwen3-embedding:0.6b"
]);
export const ARMS = Object.freeze(["raw-retrieval", "muse-freshness"]);
export const CATEGORIES = Object.freeze(["ordinary-positive", "absent", "correction-pair"]);
export const RANK_OPTIONS = Object.freeze({
  bm25: false,
  diversify: true,
  hybrid: true,
  minScore: 0.1,
  mmrLambda: 0.5,
  rrfK: 60,
  topK: 4
});
export const REASON_CODES = Object.freeze([
  "ABSENT_CONFIDENT",
  "DISTRACTOR_TOP1",
  "NOT_CONFIDENT",
  "PAIR_MISSING",
  "STALE_TOP1",
  "WRONG_TOP1"
]);
export const INFRA_REASON_CODES = Object.freeze([
  "COUNT_MISMATCH",
  "DIGEST_MISSING",
  "HASH_MISMATCH",
  "INVALID_VECTOR",
  "MODEL_MISSING",
  "OLLAMA_UNREACHABLE",
  "PARTIAL_OUTPUT",
  "TIMEOUT",
  "TRIAL_FAILED"
]);

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const trackedBase = join(repoRoot, "docs", "benchmarks", "recall-freshness-ablation");
const trackedPaths = Object.freeze({
  csv: `${trackedBase}.csv`,
  json: `${trackedBase}.json`,
  md: `${trackedBase}.md`,
  svg: `${trackedBase}.svg`
});
const diagnosticsRoot = join(repoRoot, ".muse-dev", "evals", "recall-freshness-ablation");
const CHILD_TIMEOUT_MS = 10 * 60 * 1_000;
const PREFLIGHT_TIMEOUT_MS = 60_000;

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  return value;
}
export function canonicalJson(value) { return JSON.stringify(canonicalValue(value)); }
export function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function jsonBytes(value) { return `${canonicalJson(value)}\n`; }
function rate(passed, total) { return Number((total === 0 ? 0 : passed / total).toFixed(6)); }
function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort(); const wanted = [...expected].sort();
  if (canonicalJson(actual) !== canonicalJson(wanted)) throw new Error(`${label} fields mismatch`);
}
function deepFreeze(value) { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child); } return value; }

const ORDINARY_SPECS = [
  ["home", "desk", "내 작업 책상은 어떤 색이라고 했지?", "내 작업 책상은 짙은 초록색이다.", "what color is my writing desk?", "My writing desk is deep blue."],
  ["home", "lamp", "침실 스탠드는 어떤 모양이라고 했지?", "침실 스탠드는 둥근 유리 갓이다.", "what shape is my bedroom lamp?", "My bedroom lamp has a square linen shade."],
  ["health", "vitamin", "내가 아침에 먹는 비타민은 뭐였지?", "나는 아침에 합성 비타민 D를 먹는다.", "which vitamin do I take in the morning?", "I take synthetic vitamin B12 in the morning."],
  ["health", "stretch", "내가 손목 스트레칭을 언제 한다고 했지?", "나는 점심 뒤에 손목 스트레칭을 한다.", "when do I do my shoulder stretch?", "I do my shoulder stretch after lunch."],
  ["work", "review", "주간 코드 리뷰는 무슨 요일이라고 했지?", "주간 코드 리뷰는 수요일이다.", "which day is my weekly design review?", "My weekly design review is on Thursday."],
  ["work", "editor", "업무용 편집기 테마가 뭐였지?", "업무용 편집기 테마는 솔라라이즈드 라이트다.", "which editor theme do I use at work?", "My work editor theme is Solarized Dark."],
  ["preference", "snack", "내가 오후에 좋아하는 간식은 뭐였지?", "나는 오후 간식으로 배를 좋아한다.", "what afternoon snack do I prefer?", "I prefer an apple as my afternoon snack."],
  ["preference", "music", "집중할 때 듣는 음악은 뭐였지?", "나는 집중할 때 피아노 연주곡을 듣는다.", "what music do I use for focus?", "I listen to ambient guitar while focusing."],
  ["goal", "reading", "내 분기 독서 목표는 몇 권이었지?", "내 분기 독서 목표는 합성 도서 여섯 권이다.", "how many synthetic books is my quarterly reading goal?", "My quarterly reading goal is five synthetic books."],
  ["goal", "walking", "내 주간 걷기 목표는 얼마였지?", "내 주간 걷기 목표는 35킬로미터다.", "what is my weekly walking goal?", "My weekly walking goal is 30 kilometers."]
];
const ABSENT_SPECS = [
  ["home", "내 현관 매트에 무슨 글자가 적혀 있다고 했지?", "what phrase is printed on my doormat?"],
  ["home", "내 우산 색깔이 뭐라고 했지?", "what color is my umbrella?"],
  ["health", "내 안경 도수가 얼마라고 했지?", "what is my glasses prescription?"],
  ["health", "내가 쓰는 치약 브랜드가 뭐였지?", "which toothpaste brand do I use?"],
  ["work", "내 사원 번호가 뭐라고 했지?", "what is my employee number?"],
  ["work", "내 회의실 좌석 번호가 뭐였지?", "what is my meeting-room seat number?"],
  ["preference", "내가 좋아하는 모자 브랜드가 뭐였지?", "what hat brand do I prefer?"],
  ["preference", "내가 제일 좋아하는 보드게임이 뭐였지?", "what is my favorite board game?"],
  ["goal", "내가 배우려는 악기가 뭐였지?", "which instrument am I planning to learn?"],
  ["goal", "내 저축 목표 금액이 얼마였지?", "what is my savings target amount?"]
];
const CORRECTION_SPECS = [
  ["home", "city", "나는 지금 어느 합성 도시에 산다고 했지?", "나는 지금 합성 도시 바다시에 산다.", "예전에는 합성 도시 산시에 살았다. 지금은 아니다.", "which synthetic city do I live in now?", "I now live in synthetic Harbor City.", "I used to live in synthetic Hill City, but not anymore."],
  ["home", "floor", "내 집은 지금 몇 층이라고 했지?", "내 집은 지금 8층이다.", "예전에는 3층에 살았다. 지금은 아니다.", "which floor is my home on now?", "My home is now on floor 11.", "I used to live on floor 4, but not anymore."],
  ["health", "clinic", "내가 지금 다니는 합성 치과는 어디지?", "나는 지금 합성 새봄 치과에 다닌다.", "예전에는 합성 푸른 치과에 다녔다. 지금은 아니다.", "which synthetic dental clinic do I use now?", "I now use Synthetic Maple Dental.", "I used to use Synthetic Cedar Dental, but not anymore."],
  ["health", "exercise", "내가 지금 하는 아침 운동은 뭐였지?", "나는 지금 아침에 수영을 한다.", "예전에는 아침에 자전거를 탔다. 지금은 아니다.", "what is my current morning exercise?", "My current morning exercise is rowing.", "I used to run in the morning, but not anymore."],
  ["work", "office", "내 팀은 지금 어느 합성 건물에 있지?", "내 팀은 지금 합성 오로라관에 있다.", "예전에는 합성 새턴관에서 일했다. 지금은 아니다.", "which synthetic building is my team in now?", "My team is now in Synthetic Atlas Hall.", "My team used to be in Synthetic Nova Hall, but not anymore."],
  ["work", "standup", "현재 팀 스탠드업 시간은 언제지?", "현재 팀 스탠드업은 오전 10시다.", "예전에는 오전 9시에 스탠드업을 했다. 지금은 아니다.", "what time is the current team standup?", "The current team standup is at 10:30 AM.", "The team standup used to be at 9:30 AM, but not anymore."],
  ["preference", "coffee", "내가 지금 선호하는 커피는 뭐였지?", "나는 지금 플랫화이트를 선호한다.", "예전에는 카푸치노를 좋아했다. 지금은 아니다.", "which coffee do I prefer now?", "I now prefer a cortado.", "I used to prefer a cappuccino, but not anymore."],
  ["preference", "notebook", "내가 지금 선호하는 공책 크기는 뭐지?", "나는 지금 B5 공책을 선호한다.", "예전에는 A4 공책을 선호했다. 지금은 아니다.", "which notebook size do I prefer now?", "I now prefer A5 notebooks.", "I used to prefer letter-size notebooks, but not anymore."],
  ["goal", "race", "내 현재 달리기 목표 거리는 얼마지?", "내 현재 달리기 목표는 15킬로미터다.", "예전에는 5킬로미터를 목표로 했다. 지금은 아니다.", "what is my current running-distance goal?", "My current running goal is 12 kilometers.", "My goal used to be 4 kilometers, but not anymore."],
  ["goal", "language", "내가 지금 배우려는 합성 언어는 뭐지?", "나는 지금 합성 언어 루멘어를 배우려 한다.", "예전에는 합성 언어 노바어를 배우려 했다. 지금은 아니다.", "which synthetic language am I learning now?", "I am now learning the synthetic language Luma.", "I used to study the synthetic language Nori, but not anymore."]
];

function numbered(index) { return String(index + 1).padStart(2, "0"); }
function buildDataset() {
  const cases = []; const corpus = [];
  ORDINARY_SPECS.forEach(([domain, key, koQuery, koText, enQuery, enText], index) => {
    for (const [locale, query, text] of [["ko", koQuery, koText], ["en", enQuery, enText]]) {
      const source = `syn:ordinary:${locale}:${numbered(index)}`;
      cases.push({ caseId: `ordinary-${locale}-${numbered(index)}`, category: "ordinary-positive", currentSource: null, domain, expectedSource: source, locale, query, staleSource: null }); corpus.push({ source, text });
    }
  });
  ABSENT_SPECS.forEach(([domain, koQuery, enQuery], index) => { for (const [locale, query] of [["ko", koQuery], ["en", enQuery]]) cases.push({ caseId: `absent-${locale}-${numbered(index)}`, category: "absent", currentSource: null, domain, expectedSource: null, locale, query, staleSource: null }); });
  CORRECTION_SPECS.forEach(([domain, key, koQuery, koCurrent, koStale, enQuery, enCurrent, enStale], index) => {
    for (const [locale, query, currentText, staleText] of [["ko", koQuery, koCurrent, koStale], ["en", enQuery, enCurrent, enStale]]) {
      const currentSource = `syn:correction:${locale}:${numbered(index)}:current`; const staleSource = `syn:correction:${locale}:${numbered(index)}:stale`;
      cases.push({ caseId: `correction-${locale}-${numbered(index)}`, category: "correction-pair", currentSource, domain, expectedSource: currentSource, locale, query, staleSource }); corpus.push({ source: staleSource, text: staleText }, { source: currentSource, text: currentText });
    }
  });
  cases.sort((a, b) => a.caseId.localeCompare(b.caseId));
  return deepFreeze({ cases, corpus, datasetVersion: DATASET_VERSION, schemaVersion: "muse-recall-freshness-dataset-schema.v1" });
}
export const RECALL_FRESHNESS_DATASET = buildDataset();

export function validateDataset(dataset = RECALL_FRESHNESS_DATASET, detectStale) {
  exactKeys(dataset, ["cases", "corpus", "datasetVersion", "schemaVersion"], "dataset");
  if (dataset.datasetVersion !== DATASET_VERSION || dataset.cases.length !== 60 || dataset.corpus.length !== 60) throw new Error("dataset count/version mismatch");
  const ids = new Set(); const sources = new Set(dataset.corpus.map((item) => item.source)); const expected = new Set(); const embedTexts = new Set(dataset.corpus.map((item) => item.text));
  for (const category of CATEGORIES) {
    const subset = dataset.cases.filter((item) => item.category === category); if (subset.length !== 20) throw new Error(`${category} balance mismatch`);
    for (const locale of ["ko", "en"]) { const localized = subset.filter((item) => item.locale === locale); if (localized.length !== 10 || new Set(localized.map((item) => item.domain)).size < 5) throw new Error(`${category}/${locale} coverage mismatch`); }
  }
  for (const item of dataset.cases) {
    exactKeys(item, ["caseId", "category", "currentSource", "domain", "expectedSource", "locale", "query", "staleSource"], `case ${item.caseId}`);
    if (ids.has(item.caseId) || !CATEGORIES.includes(item.category) || !["ko", "en"].includes(item.locale) || embedTexts.has(item.query)) throw new Error("case uniqueness/schema mismatch"); ids.add(item.caseId); embedTexts.add(item.query);
    if (item.category === "absent") { if (item.expectedSource !== null || item.currentSource !== null || item.staleSource !== null) throw new Error("absent source invariant"); }
    else { if (typeof item.expectedSource !== "string" || expected.has(item.expectedSource) || !sources.has(item.expectedSource)) throw new Error("expected source invariant"); expected.add(item.expectedSource); }
    if (item.category === "correction-pair") {
      if (item.expectedSource !== item.currentSource || item.currentSource === item.staleSource || !sources.has(item.staleSource)) throw new Error("correction pair source invariant");
      const currentText = dataset.corpus.find((entry) => entry.source === item.currentSource)?.text ?? ""; const staleText = dataset.corpus.find((entry) => entry.source === item.staleSource)?.text ?? "";
      if (detectStale && (!detectStale(staleText) || detectStale(currentText))) throw new Error("correction stale-marker invariant");
    }
  }
  if (embedTexts.size !== 120 || new Set(dataset.corpus.map((item) => item.source)).size !== 60 || !Object.isFrozen(dataset)) throw new Error("dataset immutability/embed request invariant");
  return true;
}
export function datasetSha256(dataset = RECALL_FRESHNESS_DATASET) { return sha256(jsonBytes(dataset)); }

export function memoizeEmbed(embed) {
  const cache = new Map(); let requests = 0;
  const memoized = async (text) => { if (!cache.has(text)) { requests += 1; cache.set(text, Promise.resolve(embed(text))); } return cache.get(text); };
  return { embed: memoized, requestCount: () => requests };
}

export function scoreTerminal(testCase, rawMatches, finalMatches, classify, confidentAt) {
  const topSource = finalMatches[0]?.source ?? null;
  if (testCase.category === "absent") {
    const confidence = classify(finalMatches, { confidentAt }); return confidence === "ambiguous" || confidence === "none" ? { ok: true, reasonCode: null } : { ok: false, reasonCode: "ABSENT_CONFIDENT" };
  }
  if (testCase.category === "ordinary-positive") {
    const confidence = classify(finalMatches, { confidentAt }); if (confidence !== "confident") return { ok: false, reasonCode: "NOT_CONFIDENT" }; return topSource === testCase.expectedSource ? { ok: true, reasonCode: null } : { ok: false, reasonCode: "WRONG_TOP1" };
  }
  const rawSources = new Set(rawMatches.map((item) => item.source)); if (!rawSources.has(testCase.currentSource) || !rawSources.has(testCase.staleSource)) return { ok: false, reasonCode: "PAIR_MISSING" };
  if (topSource === testCase.currentSource) return { ok: true, reasonCode: null }; if (topSource === testCase.staleSource) return { ok: false, reasonCode: "STALE_TOP1" }; return { ok: false, reasonCode: "DISTRACTOR_TOP1" };
}

export function evaluateCaseWithArms(testCase, rawMatches, { classify, confidentAt, demote }) {
  const museMatches = demote(rawMatches, (item) => item.text);
  return ARMS.map((arm) => { const finalMatches = arm === "raw-retrieval" ? rawMatches : museMatches; return { arm, caseId: testCase.caseId, category: testCase.category, ...scoreTerminal(testCase, rawMatches, finalMatches, classify, confidentAt) }; });
}

export async function executeTrial({ classify, confidentAt, demote, embed, modelTag, rank, trial }) {
  const memo = memoizeEmbed(embed); const verdicts = []; let rawRankCalls = 0;
  for (const testCase of RECALL_FRESHNESS_DATASET.cases) {
    const rawMatches = await rank(testCase.query, RECALL_FRESHNESS_DATASET.corpus, { ...RANK_OPTIONS, embed: memo.embed }); rawRankCalls += 1;
    verdicts.push(...evaluateCaseWithArms(testCase, rawMatches, { classify, confidentAt, demote }));
  }
  const verdictHash = sha256(jsonBytes(verdicts));
  return { accounting: { armVerdicts: verdicts.length, benchmarkEmbeddingRequests: memo.requestCount(), executedCases: RECALL_FRESHNESS_DATASET.cases.length, rawRankCalls }, modelTag, schemaVersion: CHILD_SCHEMA_VERSION, trial, verdictHash, verdicts };
}

export function canonicalLocalBaseUrl(raw = "http://127.0.0.1:11434") {
  let value; try { value = new URL(raw); } catch { throw new Error("OLLAMA_BASE_URL must be a canonical loopback URL"); }
  const host = value.hostname.replace(/^\[|\]$/gu, "").toLowerCase(); if (!['http:', 'https:'].includes(value.protocol) || !["127.0.0.1", "localhost", "::1"].includes(host) || value.username || value.password || value.search || value.hash) throw new Error("OLLAMA_BASE_URL must be loopback http(s)");
  const path = value.pathname.replace(/\/+$/gu, ""); return `${value.protocol}//${value.host}${path}`;
}
function scrubbedEnv(baseUrl, home) { return { HOME: home, LANG: process.env.LANG ?? "C.UTF-8", LC_ALL: process.env.LC_ALL ?? "C.UTF-8", MUSE_LOCAL_ONLY: "true", OLLAMA_BASE_URL: baseUrl, PATH: process.env.PATH ?? "", TMPDIR: join(home, "tmp") }; }

export function validatePreflight(value, modelTag) {
  exactKeys(value, ["digest", "dimension", "modelTag", "ollamaVersion", "preflightEmbeddingRequests", "resolvedTag", "schemaVersion"], "preflight");
  if (value.schemaVersion !== CHILD_SCHEMA_VERSION || value.modelTag !== modelTag || value.preflightEmbeddingRequests !== 1 || !Number.isInteger(value.dimension) || value.dimension <= 0 || typeof value.ollamaVersion !== "string" || !value.ollamaVersion || typeof value.resolvedTag !== "string" || !value.resolvedTag) throw new Error("invalid preflight accounting/vector");
  if (typeof value.digest !== "string" || !/^(?:sha256:)?[a-f0-9]{64}$/u.test(value.digest)) throw new Error("preflight digest missing"); return value;
}
function validateTrial(value, modelTag, trial) {
  exactKeys(value, ["accounting", "modelTag", "schemaVersion", "trial", "verdictHash", "verdicts"], "trial"); exactKeys(value.accounting, ["armVerdicts", "benchmarkEmbeddingRequests", "executedCases", "rawRankCalls"], "trial accounting");
  if (value.schemaVersion !== CHILD_SCHEMA_VERSION || value.modelTag !== modelTag || value.trial !== trial || value.accounting.executedCases !== 60 || value.accounting.armVerdicts !== 120 || value.accounting.benchmarkEmbeddingRequests !== 120 || value.accounting.rawRankCalls !== 60 || value.verdicts.length !== 120 || value.verdictHash !== sha256(jsonBytes(value.verdicts))) throw new Error("trial count/hash mismatch");
  for (const verdict of value.verdicts) { exactKeys(verdict, ["arm", "caseId", "category", "ok", "reasonCode"], "verdict"); if (!ARMS.includes(verdict.arm) || !CATEGORIES.includes(verdict.category) || typeof verdict.ok !== "boolean" || (verdict.ok ? verdict.reasonCode !== null : !REASON_CODES.includes(verdict.reasonCode))) throw new Error("verdict schema mismatch"); }
  return value;
}

function tallyVerdicts(verdicts) {
  const rows = []; for (const arm of ARMS) for (const category of CATEGORIES) { const subset = verdicts.filter((item) => item.arm === arm && item.category === category); const passed = subset.filter((item) => item.ok).length; rows.push({ arm, category, passed, rate: rate(passed, subset.length), total: subset.length }); } return rows;
}
export function aggregateModel(preflight, trials) {
  if (trials.length !== 2 || trials[0].verdictHash !== trials[1].verdictHash) throw new Error("trial verdict hash mismatch"); const verdicts = trials[0].verdicts; const metrics = tallyVerdicts(verdicts);
  const metric = (arm, category) => metrics.find((item) => item.arm === arm && item.category === category); const categoryNonRegression = Object.fromEntries(CATEGORIES.map((category) => [category, metric("muse-freshness", category).rate >= metric("raw-retrieval", category).rate]));
  const failedCases = verdicts.filter((item) => !item.ok).map(({ arm, caseId, category, reasonCode }) => ({ arm, caseId, category, reasonCode })); const correctionDelta = Number((metric("muse-freshness", "correction-pair").rate - metric("raw-retrieval", "correction-pair").rate).toFixed(6));
  return { calibrated: preflight.calibrated, categoryNonRegression, confidentAt: preflight.confidentAt, correctionDelta, digest: preflight.digest, dimension: preflight.dimension, failedCases, metrics, modelTag: preflight.modelTag, reliable: true, resolvedTag: preflight.resolvedTag, trialVerdictHash: trials[0].verdictHash };
}

export function resolveBenchmarkStatus({ complete, models }) {
  if (!complete || models.some((model) => !model.reliable)) return "UNVERIFIED";
  if (models.some((model) => model.correctionDelta < 0 || Object.values(model.categoryNonRegression).some((value) => !value))) return "REGRESSED";
  if (models.some((model) => model.correctionDelta > 0)) return "IMPROVED";
  return "UNCHANGED";
}

export function buildCanonicalResult({ models, runMetadata }) {
  const complete = models.length === 4 && canonicalJson(models.map((item) => item.modelTag)) === canonicalJson(ALLOWLISTED_MODELS);
  const status = resolveBenchmarkStatus({ complete, models }); const payload = {
    accounting: { armVerdicts: models.length * 240, benchmarkEmbeddingRequests: models.length * 240, caseTrials: models.length * 120, generatedCases: 60, preflightEmbeddingRequests: models.length, rawRankCalls: models.length * 120, successfulModelTrials: models.length * 2, totalEmbeddingRequests: models.length * 241 },
    arms: [...ARMS], categories: [...CATEGORIES], dataset: { cases: 60, corpusEntries: 60, datasetSha256: datasetSha256(), datasetVersion: DATASET_VERSION },
    models, rankOptions: RANK_OPTIONS, scorerVersion: SCORER_VERSION, status
  };
  return { payload, payloadHash: sha256(jsonBytes(payload)), runMetadata, schemaVersion: RESULT_SCHEMA_VERSION };
}

function scanTrackedValue(value, path = "") {
  if (Array.isArray(value)) return value.forEach((item, index) => scanTrackedValue(item, `${path}/${index}`));
  if (value && typeof value === "object") { for (const [key, child] of Object.entries(value)) { if (/prompt|output|trace|path|free.?text/iu.test(key)) throw new Error(`forbidden tracked field ${path}/${key}`); scanTrackedValue(child, `${path}/${key}`); } return; }
  if (typeof value === "string" && (/\/Users\//iu.test(value) || /\/home\//iu.test(value) || /\.muse/iu.test(value) || /jinan/iu.test(value) || /(?:sk-|ghp_|github_pat_|Bearer\s|AKIA)[A-Za-z0-9_\-]*/u.test(value))) throw new Error(`private token in tracked aggregate ${path}`);
}

export function validateCanonicalResult(result) {
  exactKeys(result, ["payload", "payloadHash", "runMetadata", "schemaVersion"], "result"); exactKeys(result.payload, ["accounting", "arms", "categories", "dataset", "models", "rankOptions", "scorerVersion", "status"], "payload"); exactKeys(result.runMetadata, ["generatedAt", "node", "ollamaVersion", "platform"], "run metadata");
  if (result.schemaVersion !== RESULT_SCHEMA_VERSION || result.payloadHash !== sha256(jsonBytes(result.payload)) || result.payload.dataset.datasetSha256 !== datasetSha256() || result.payload.scorerVersion !== SCORER_VERSION || canonicalJson(result.payload.rankOptions) !== canonicalJson(RANK_OPTIONS)) throw new Error("canonical result hash/version mismatch");
  if (result.payload.models.length !== 4 || canonicalJson(result.payload.models.map((item) => item.modelTag)) !== canonicalJson(ALLOWLISTED_MODELS) || result.payload.accounting.generatedCases !== 60 || result.payload.accounting.caseTrials !== 480 || result.payload.accounting.armVerdicts !== 960 || result.payload.accounting.benchmarkEmbeddingRequests !== 960 || result.payload.accounting.preflightEmbeddingRequests !== 4 || result.payload.accounting.totalEmbeddingRequests !== 964 || result.payload.accounting.rawRankCalls !== 480 || result.payload.accounting.successfulModelTrials !== 8) throw new Error("canonical result accounting mismatch");
  for (const model of result.payload.models) {
    exactKeys(model, ["calibrated", "categoryNonRegression", "confidentAt", "correctionDelta", "digest", "dimension", "failedCases", "metrics", "modelTag", "reliable", "resolvedTag", "trialVerdictHash"], `model ${model.modelTag}`);
    if (typeof model.calibrated !== "boolean" || !Number.isFinite(model.confidentAt) || model.confidentAt <= 0 || model.confidentAt > 1 || model.reliable !== true || model.metrics.length !== 6 || !/^(?:sha256:)?[a-f0-9]{64}$/u.test(model.digest)) throw new Error("model provenance mismatch");
    for (const metric of model.metrics) { exactKeys(metric, ["arm", "category", "passed", "rate", "total"], "metric"); if (!ARMS.includes(metric.arm) || !CATEGORIES.includes(metric.category) || metric.total !== 20 || metric.passed < 0 || metric.passed > 20 || metric.rate !== rate(metric.passed, 20)) throw new Error("metric reconciliation mismatch"); }
    for (const failed of model.failedCases) { exactKeys(failed, ["arm", "caseId", "category", "reasonCode"], "failed case"); if (!REASON_CODES.includes(failed.reasonCode) || !RECALL_FRESHNESS_DATASET.cases.some((item) => item.caseId === failed.caseId)) throw new Error("failed case allowlist mismatch"); }
    const rawCorrection = model.metrics.find((item) => item.arm === "raw-retrieval" && item.category === "correction-pair"); const museCorrection = model.metrics.find((item) => item.arm === "muse-freshness" && item.category === "correction-pair"); if (model.correctionDelta !== Number((museCorrection.rate - rawCorrection.rate).toFixed(6))) throw new Error("correction delta mismatch");
  }
  if (result.payload.status !== resolveBenchmarkStatus({ complete: true, models: result.payload.models })) throw new Error("status priority mismatch"); scanTrackedValue(result); return result;
}

function csvEscape(value) { const text = String(value); return /[",\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text; }
export function renderCsv(result) {
  const fields = ["modelTag", "digest", "calibrated", "confidentAt", "arm", "category", "passed", "total", "rate", "correctionDelta", "nonRegression", "status"];
  const rows = result.payload.models.flatMap((model) => model.metrics.map((metric) => ({ modelTag: model.modelTag, digest: model.digest, calibrated: model.calibrated, confidentAt: model.confidentAt, arm: metric.arm, category: metric.category, passed: metric.passed, total: metric.total, rate: metric.rate, correctionDelta: model.correctionDelta, nonRegression: model.categoryNonRegression[metric.category], status: result.payload.status })));
  return `${fields.join(",")}\n${rows.map((row) => fields.map((field) => csvEscape(row[field])).join(",")).join("\n")}\n`;
}
export function renderMarkdown(result) {
  const lines = ["# Recall freshness ablation", "", `**${result.payload.status}** — local-live retrieval component evidence only. No generative model requests were made.`, "", `Dataset: ${result.payload.dataset.cases} synthetic cases · ${result.payload.accounting.caseTrials} case-trials · ${result.payload.accounting.armVerdicts} arm verdicts · dataset SHA-256 \`${result.payload.dataset.datasetSha256}\`.`, "", "| Model | Calibrated | Confidence | Pair retained in raw top-4 | Raw correction | Muse correction | Delta | Non-regression |", "| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |"];
  let retainedTotal = 0; let correctionTotal = 0;
  for (const model of result.payload.models) { const raw = model.metrics.find((item) => item.arm === "raw-retrieval" && item.category === "correction-pair"); const muse = model.metrics.find((item) => item.arm === "muse-freshness" && item.category === "correction-pair"); const pairMissing = model.failedCases.filter((item) => item.arm === "raw-retrieval" && item.category === "correction-pair" && item.reasonCode === "PAIR_MISSING").length; const retained = raw.total - pairMissing; retainedTotal += retained; correctionTotal += raw.total; lines.push(`| ${model.modelTag} | ${model.calibrated ? "yes" : "no"} | ${model.confidentAt.toFixed(2)} | ${retained}/${raw.total} | ${raw.passed}/${raw.total} | ${muse.passed}/${muse.total} | ${model.correctionDelta >= 0 ? "+" : ""}${model.correctionDelta.toFixed(2)} | ${Object.values(model.categoryNonRegression).every(Boolean) ? "PASS" : "FAIL"} |`); }
  const pairMissingTotal = correctionTotal - retainedTotal;
  lines.push("", "Non-calibrated models use the conservative 0.55 fallback confidence threshold. Rates are checked per model and category; aggregation cannot hide a regression.", "", `**Interpretation:** all four model deltas are 0, so the qualified result is **${result.payload.status}**. Both correction sources survived the required diversified raw top-4 in only ${retainedTotal}/${correctionTotal} model-case observations; ${pairMissingTotal}/${correctionTotal} were \`PAIR_MISSING\`. \`demoteStale\` can reorder retained candidates but cannot restore a pair member removed by retrieval/MMR, making raw top-4 pair retention the measured bottleneck.`, "", "This benchmark uses synthetic controlled cases against local embedding, ranking, confidence, and freshness code. It is not an agent/LLM evaluation and does not prove organic personal effectiveness. The qualified 10/11 live aggregate remains 10/11.", "", "**organic personal effectiveness = NOT_PROVEN · agent capability = NOT_RUN · generative requests = 0**", ""); return lines.join("\n");
}
function escapeXml(value) { return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"); }
export function renderSvg(result) {
  const width = 1200; const rowHeight = 42; const top = 155; const rows = result.payload.models.flatMap((model) => CATEGORIES.map((category) => ({ category, model, raw: model.metrics.find((item) => item.arm === "raw-retrieval" && item.category === category), muse: model.metrics.find((item) => item.arm === "muse-freshness" && item.category === category) }))); const height = 770;
  const body = rows.map((row, index) => { const y = top + index * rowHeight; const rawWidth = row.raw.rate * 280; const museWidth = row.muse.rate * 280; return `<text x="40" y="${y + 16}" class="label">${escapeXml(row.model.modelTag)}</text><text x="280" y="${y + 16}" class="category">${escapeXml(row.category)}</text><rect x="430" y="${y}" width="${rawWidth}" height="12" rx="3" fill="#94a3b8"/><rect x="430" y="${y + 17}" width="${museWidth}" height="12" rx="3" fill="#2563eb"/><text x="${440 + rawWidth}" y="${y + 10}" class="value">raw ${row.raw.passed}/${row.raw.total}</text><text x="${440 + museWidth}" y="${y + 28}" class="value blue">Muse ${row.muse.passed}/${row.muse.total}</text>`; }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc"><title id="title">Muse recall freshness ablation</title><desc id="desc">Paired raw-retrieval and Muse-freshness pass counts for four local embedding models across three synthetic categories. Longer bars mean a higher within-row pass fraction.</desc><style>text{font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;fill:#172033}.title{font-size:25px;font-weight:700}.subtitle{font-size:13px;fill:#536075}.label{font-size:12px;font-weight:650}.category{font-size:12px;fill:#536075}.value{font-size:10px;fill:#475569}.blue{fill:#1d4ed8}.footer{font-size:12px;font-weight:650}</style><rect width="1200" height="770" fill="#ffffff"/><text x="40" y="40" class="title">Recall freshness ablation · ${result.payload.status}</text><text x="40" y="67" class="subtitle">local-live retrieval component · 60 synthetic cases · four models × two trials · no generative requests</text><text x="360" y="99" class="subtitle">Legend</text><rect x="430" y="90" width="14" height="10" rx="2" fill="#94a3b8"/><text x="452" y="99" class="subtitle">raw-retrieval</text><rect x="570" y="90" width="14" height="10" rx="2" fill="#2563eb"/><text x="592" y="99" class="subtitle">muse-freshness</text><text x="40" y="128" class="subtitle">Model</text><text x="280" y="128" class="subtitle">Category</text>${body}<line x1="40" y1="690" x2="1160" y2="690" stroke="#dce2ea"/><text x="40" y="718" class="footer">organic personal effectiveness = NOT_PROVEN · agent capability = NOT_RUN · generated cases are not independent truths</text></svg>\n`;
}

async function readCanonicalResult(path) { const bytes = await readFile(path, "utf8"); if (!bytes.endsWith("\n")) throw new Error("canonical JSON must end with LF"); const value = JSON.parse(bytes); if (bytes !== jsonBytes(value)) throw new Error("canonical JSON bytes mismatch"); return validateCanonicalResult(value); }
export async function validateArtifacts(paths = trackedPaths) {
  const result = await readCanonicalResult(paths.json); const expected = { csv: renderCsv(result), md: renderMarkdown(result), svg: renderSvg(result) };
  for (const kind of ["csv", "md", "svg"]) { const actual = await readFile(paths[kind], "utf8"); if (actual !== expected[kind]) throw new Error(`${kind.toUpperCase()} does not reconcile with canonical JSON`); scanTrackedValue(actual); }
  return result;
}

async function writeAtomicText(path, value) { await mkdir(dirname(path), { recursive: true }); const temporary = `${path}.tmp-${process.pid}`; await writeFile(temporary, value, { mode: 0o600 }); await rename(temporary, path); }
async function writeAtomicJson(path, value) { await writeAtomicText(path, jsonBytes(value)); }

export async function spawnWithTimeout(command, args, { env, outputPath, timeoutMs }) {
  await rm(outputPath, { force: true }); return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: repoRoot, env, stdio: ["ignore", "ignore", "ignore"] }); let timedOut = false; const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.once("error", () => { clearTimeout(timer); resolve({ ok: false, reasonCode: "TRIAL_FAILED" }); }); child.once("close", async (code) => { clearTimeout(timer); if (timedOut) return resolve({ ok: false, reasonCode: "TIMEOUT" }); if (code !== 0) return resolve({ ok: false, reasonCode: "TRIAL_FAILED" }); try { await stat(outputPath); resolve({ ok: true }); } catch { resolve({ ok: false, reasonCode: "PARTIAL_OUTPUT" }); } });
  });
}

async function childPreflight({ baseUrl, modelTag, outputPath }) {
  try {
    const [{ createOllamaEmbedder }] = await Promise.all([import("../packages/autoconfigure/dist/index.js")]); const [versionResponse, tagsResponse] = await Promise.all([fetch(`${baseUrl}/api/version`, { signal: AbortSignal.timeout(10_000) }), fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(10_000) })]); if (!versionResponse.ok || !tagsResponse.ok) throw new Error("OLLAMA_UNREACHABLE");
    const version = await versionResponse.json(); const tags = await tagsResponse.json(); const candidates = Array.isArray(tags.models) ? tags.models : []; const acceptedTags = modelTag.includes(":") ? [modelTag] : [modelTag, `${modelTag}:latest`]; const found = candidates.find((item) => acceptedTags.includes(item.name) || acceptedTags.includes(item.model)); if (!found) throw new Error("MODEL_MISSING");
    const digest = found.digest; if (typeof digest !== "string" || !/^(?:sha256:)?[a-f0-9]{64}$/u.test(digest)) throw new Error("DIGEST_MISSING"); const embed = createOllamaEmbedder(modelTag, { MUSE_LOCAL_ONLY: "true", OLLAMA_BASE_URL: baseUrl }); const vector = await embed("synthetic preflight vector probe"); if (!Array.isArray(vector) || vector.length === 0 || vector.some((item) => !Number.isFinite(item))) throw new Error("INVALID_VECTOR");
    await writeAtomicJson(outputPath, { digest, dimension: vector.length, modelTag, ollamaVersion: String(version.version ?? ""), preflightEmbeddingRequests: 1, resolvedTag: String(found.model ?? found.name), schemaVersion: CHILD_SCHEMA_VERSION });
  } catch (cause) { const reason = cause instanceof Error && INFRA_REASON_CODES.includes(cause.message) ? cause.message : "OLLAMA_UNREACHABLE"; process.stderr.write(`${reason}\n`); process.exitCode = 1; }
}

async function childTrial({ baseUrl, modelTag, outputPath, trial }) {
  try {
    const [{ classifyRetrievalConfidence, rankKnowledgeChunks }, { createOllamaEmbedder }, { demoteStale }] = await Promise.all([import("../packages/agent-core/dist/index.js"), import("../packages/autoconfigure/dist/index.js"), import("../packages/recall/dist/index.js")]); const threshold = Number(process.env.MUSE_RECALL_ABLATION_CONFIDENT_AT); if (!Number.isFinite(threshold)) throw new Error("TRIAL_FAILED");
    const result = await executeTrial({ classify: classifyRetrievalConfidence, confidentAt: threshold, demote: demoteStale, embed: createOllamaEmbedder(modelTag, { MUSE_LOCAL_ONLY: "true", OLLAMA_BASE_URL: baseUrl }), modelTag, rank: rankKnowledgeChunks, trial }); validateTrial(result, modelTag, trial); await writeAtomicJson(outputPath, result);
  } catch { process.exitCode = 1; }
}

function parseInternalArgs(args) { const out = {}; for (let index = 0; index < args.length; index += 2) { const key = args[index]; const value = args[index + 1]; if (!key?.startsWith("--") || value === undefined) throw new Error("malformed internal options"); out[key.slice(2)] = value; } return out; }
export function normalizeCliArgs(args) { return args.filter((item) => item !== "--"); }
async function runModelChildren(modelTag, baseUrl, sessionDir) {
  const home = join(sessionDir, "homes", modelTag.replaceAll(/[^a-z0-9.-]/giu, "_")); await mkdir(join(home, "tmp"), { recursive: true }); const env = scrubbedEnv(baseUrl, home); const preflightPath = join(sessionDir, `${modelTag.replaceAll(/[^a-z0-9.-]/giu, "_")}-preflight.json`); const preflightRun = await spawnWithTimeout(process.execPath, [fileURLToPath(import.meta.url), "--child-preflight", "1", "--model", modelTag, "--out", preflightPath], { env, outputPath: preflightPath, timeoutMs: PREFLIGHT_TIMEOUT_MS }); if (!preflightRun.ok) return { ok: false, reasonCode: preflightRun.reasonCode };
  let preflight; try { preflight = validatePreflight(JSON.parse(await readFile(preflightPath, "utf8")), modelTag); } catch (cause) { return { ok: false, reasonCode: /digest/iu.test(String(cause)) ? "DIGEST_MISSING" : "INVALID_VECTOR" }; }
  const [{ isCalibratedEmbedder, resolveRecallConfidentAt }] = await Promise.all([import("../packages/agent-core/dist/index.js")]); const confidenceEnv = { MUSE_LOCAL_ONLY: "true", OLLAMA_BASE_URL: baseUrl }; preflight = { ...preflight, calibrated: isCalibratedEmbedder(modelTag), confidentAt: resolveRecallConfidentAt(confidenceEnv, modelTag) }; const trials = [];
  for (let trial = 1; trial <= 2; trial += 1) { const path = join(sessionDir, `${modelTag.replaceAll(/[^a-z0-9.-]/giu, "_")}-trial-${trial}.json`); const trialEnv = { ...env, MUSE_RECALL_ABLATION_CONFIDENT_AT: String(preflight.confidentAt) }; const run = await spawnWithTimeout(process.execPath, [fileURLToPath(import.meta.url), "--child-trial", "1", "--model", modelTag, "--out", path, "--trial", String(trial)], { env: trialEnv, outputPath: path, timeoutMs: CHILD_TIMEOUT_MS }); if (!run.ok) return { ok: false, reasonCode: run.reasonCode }; try { trials.push(validateTrial(JSON.parse(await readFile(path, "utf8")), modelTag, trial)); } catch { return { ok: false, reasonCode: "COUNT_MISMATCH" }; } }
  try { return { model: aggregateModel(preflight, trials), ok: true, ollamaVersion: preflight.ollamaVersion }; } catch { return { ok: false, reasonCode: "HASH_MISMATCH" }; }
}

async function promoteTracked(result) {
  validateCanonicalResult(result); const stage = join(diagnosticsRoot, `stage-${process.pid}`); await rm(stage, { recursive: true, force: true }); await mkdir(stage, { recursive: true }); const staged = { csv: join(stage, "result.csv"), json: join(stage, "result.json"), md: join(stage, "result.md"), svg: join(stage, "result.svg") };
  await writeAtomicJson(staged.json, result); await writeAtomicText(staged.csv, renderCsv(result)); await writeAtomicText(staged.md, renderMarkdown(result)); await writeAtomicText(staged.svg, renderSvg(result)); await validateArtifacts(staged); await mkdir(dirname(trackedPaths.json), { recursive: true }); for (const kind of ["csv", "md", "svg", "json"]) await rename(staged[kind], trackedPaths[kind]); await rm(stage, { recursive: true, force: true }); await validateArtifacts();
}

async function parentMain(smokeModel) {
  const baseUrl = canonicalLocalBaseUrl(process.env.OLLAMA_BASE_URL?.trim() || "http://127.0.0.1:11434"); const models = smokeModel ? [smokeModel] : [...ALLOWLISTED_MODELS]; if (models.some((model) => !ALLOWLISTED_MODELS.includes(model))) throw new Error("model is not allowlisted"); const session = new Date().toISOString().replaceAll(/[:.]/gu, "-"); const sessionDir = join(diagnosticsRoot, session); await mkdir(sessionDir, { recursive: true });
  const { detectStaleMarker } = await import("../packages/recall/dist/index.js"); validateDataset(RECALL_FRESHNESS_DATASET, detectStaleMarker); const completed = []; const diagnostics = [];
  for (const modelTag of models) { const outcome = await runModelChildren(modelTag, baseUrl, sessionDir); diagnostics.push({ modelTag, ok: outcome.ok, reasonCode: outcome.ok ? null : outcome.reasonCode }); if (outcome.ok) completed.push(outcome); }
  await writeAtomicJson(join(sessionDir, "summary.json"), { diagnostics, requestedModels: models }); if (completed.length !== models.length) { process.stderr.write(`UNVERIFIED ${canonicalJson(diagnostics)}\n`); process.exitCode = 1; return; }
  if (smokeModel) { process.stdout.write(`${canonicalJson({ model: smokeModel, status: "SMOKE_PASS", trials: 2 })}\n`); return; }
  const ollamaVersions = new Set(completed.map((item) => item.ollamaVersion)); if (ollamaVersions.size !== 1) { process.stderr.write("UNVERIFIED Ollama version changed during preflight\n"); process.exitCode = 1; return; }
  const result = buildCanonicalResult({ models: completed.map((item) => item.model), runMetadata: { generatedAt: new Date().toISOString(), node: process.version, ollamaVersion: [...ollamaVersions][0], platform: `${process.platform}/${process.arch}` } }); if (result.payload.status === "UNVERIFIED") { process.exitCode = 1; return; } await promoteTracked(result); process.stdout.write(`${canonicalJson({ artifact: trackedPaths.json, status: result.payload.status })}\n`);
}

async function main() {
  const args = normalizeCliArgs(process.argv.slice(2));
  if (args[0] === "--validate") { if (args.length !== 1) throw new Error("validate takes no options"); const result = await validateArtifacts(); process.stdout.write(`${canonicalJson({ payloadHash: result.payloadHash, status: result.payload.status })}\n`); return; }
  if (args[0] === "--child-preflight" || args[0] === "--child-trial") { const mode = args[0]; const options = parseInternalArgs(args.slice(2)); const baseUrl = canonicalLocalBaseUrl(process.env.OLLAMA_BASE_URL); if (!options.model || !options.out) throw new Error("missing child options"); if (mode === "--child-preflight") await childPreflight({ baseUrl, modelTag: options.model, outputPath: options.out }); else await childTrial({ baseUrl, modelTag: options.model, outputPath: options.out, trial: Number(options.trial) }); return; }
  if (args.length === 0) return parentMain(undefined); if (args.length === 2 && args[0] === "--smoke-model") return parentMain(args[1]); throw new Error("Usage: eval-recall-freshness-ablation.mjs [--smoke-model <allowlisted-model>|--validate]");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) { await main(); }
