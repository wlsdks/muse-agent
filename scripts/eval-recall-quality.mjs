/**
 * eval:recall-quality — golden-set measurement of Muse's PERSONAL-MEMORY recall
 * (the "기억/회상 비서" golden path). Distinct from the notes batteries
 * (verify-cited-recall / verify-multihop, which use a knowledge-CHUNK corpus):
 * this models the USER's own facts/preferences/goals and asks the questions a
 * memory assistant actually gets — "내 X 뭐였지?", an absent fact (must abstain,
 * never fabricate), and a CORRECTED fact where the CURRENT value must win over
 * the stale one (the identity's "FORGETS the moment you correct it", measured).
 *
 * Drives the exact two-phase NOTES grounding assembly used by `muse ask`:
 * CLI `retrieveAndRankNotes` (local model preload + correction selector) → an
 * immutable first-retrieval snapshot → public `prepareGroundedRecall`. The
 * second phase must reuse that snapshot, so the selector cannot silently run
 * twice or choose a different correction pair. Embeddings and selector calls
 * go through one content-blind, loopback-only audited transport.
 *
 * SCOPE (honest about what this measures): this is a synthetic personal-memory-
 * STYLE corpus exercised through the production notes path. It does not claim
 * organic effectiveness, user-memory-store recall, or answer-model quality.
 *
 * The deterministic SCORER (`scoreRecallQualityCase`) is the teeth and is unit-
 * tested zero-dep in eval-recall-quality.test.mjs, so the gate has teeth even on
 * a box where Ollama is down (a skip is NOT a pass).
 *
 *   node scripts/eval-recall-quality.mjs               (nomic embed default)
 *   MUSE_EVAL_REPEAT=5 node scripts/eval-recall-quality.mjs   (pass^k)
 *
 * Exit 0 + PASS if rate ≥ threshold; exit 1 on a real regression; skip (exit 0)
 * if Ollama / the embed model is unreachable. LOCAL OLLAMA ONLY.
 */
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { runEvalSuite } from "./eval-harness.mjs";
import { completionLine, skipLine } from "./eval-skip.mjs";
import {
  canonicalJson,
  canonicalLoopbackBaseUrl,
  createAuditedLoopbackFetch,
  manifestTree,
  modelInfo,
  sha256,
  writeAtomic
} from "./recall-eval-runtime-common.mjs";

export const RECALL_QUALITY_CORRECTION_SCORER_VERSION = "recall-quality-correction-order-v2";

/**
 * The user's OWN memory, rendered as sourced entries (what a memory store holds:
 * facts, a preference, a goal). The CORRECTION pair (home city) carries the
 * stale value as a PAST-tense entry and the current value as a present-tense
 * entry — a faithful recall must surface the current one, not the stale one.
 */
export const RECALL_MEMORY_CORPUS = [
  // KO facts
  { source: "fact:home_city", text: "지금 내가 사는 도시는 부산이다." },
  { source: "fact:home_city_old", text: "예전에는 서울에 살았었다. 지금은 아니다." },
  { source: "fact:dietary", text: "나는 유당불내증이라 우유를 못 마신다." },
  { source: "fact:car", text: "내 차는 2019년식 회색 아반떼다." },
  { source: "fact:job", text: "나는 백엔드 개발자로 일한다." },
  { source: "fact:apt_floor", text: "우리 집은 아파트 12층이다." },
  { source: "fact:allergy", text: "나는 땅콩 알레르기가 있다." },
  // KO preferences
  { source: "pref:coffee", text: "커피는 아메리카노보다 라떼를 더 좋아한다." },
  { source: "pref:music", text: "잔잔한 재즈를 즐겨 듣는다." },
  { source: "pref:season", text: "사계절 중 가을을 제일 좋아한다." },
  // KO goals
  { source: "goal:running", text: "올해 목표는 10km 마라톤을 완주하는 것이다." },
  { source: "goal:reading", text: "한 달에 책 두 권 읽기가 목표다." },
  // EN facts / prefs / goal
  { source: "fact:dentist", text: "My dentist is Dr. Cho at Smile Clinic." },
  { source: "fact:laptop", text: "My work laptop is a 14-inch MacBook Pro." },
  { source: "pref:tea", text: "I prefer green tea over black tea." },
  { source: "goal:spanish", text: "My goal this year is to reach B1 in Spanish." },
  // EN correction pair (current vs stale)
  { source: "fact:gym", text: "I now go to the gym near my office every morning." },
  { source: "fact:gym_old", text: "I used to work out at a home gym, but not anymore." },
  // distractors — unrelated personal facts that must not be recalled as answers
  { source: "d:standup", text: "팀 스탠드업은 매일 아침 9시 30분." },
  { source: "d:budget", text: "한 달 장보기 예산은 60만 원이다." },
  { source: "d:weekend", text: "주말마다 등산을 간다. 다음 목표는 설악산." },
  { source: "d:commute", text: "I commute by subway, line 2." }
];

/**
 * Each case: a recall question. `expectedSource` = the memory entry a faithful
 * recall must surface as the TOP match (positive); `expectedSource: null` = an
 * absent fact where the only correct behavior is to ABSTAIN (confidence not
 * "confident"), never to dress a weak match up as a recalled fact.
 */
export const RECALL_QUALITY_CASES = [
  // positives — KO facts
  { note: "fact: car", query: "내가 어떤 차 탄다고 했지?", expectedSource: "fact:car" },
  { note: "fact: dietary", query: "내가 못 마시는 거 뭐였지?", expectedSource: "fact:dietary" },
  { note: "fact: job", query: "내 직업이 뭐라고 했더라?", expectedSource: "fact:job" },
  { note: "fact: apt floor", query: "우리 집 몇 층이라고 했지?", expectedSource: "fact:apt_floor" },
  { note: "fact: allergy", query: "나 무슨 알레르기 있다고 했어?", expectedSource: "fact:allergy" },
  // positives — KO preferences
  { note: "pref: coffee", query: "나 커피 뭐 좋아한다고 했어?", expectedSource: "pref:coffee" },
  { note: "pref: music", query: "내가 무슨 음악 즐겨 듣는다고 했지?", expectedSource: "pref:music" },
  { note: "pref: season", query: "내가 제일 좋아하는 계절이 뭐였지?", expectedSource: "pref:season" },
  // positives — KO goals
  { note: "goal: running", query: "내 올해 운동 목표가 뭐였지?", expectedSource: "goal:running" },
  { note: "goal: reading", query: "내가 한 달에 책 몇 권 읽기로 했더라?", expectedSource: "goal:reading" },
  // positives — KO correction (current value wins)
  {
    note: "correction — current city wins",
    query: "나 지금 어디 산다고 했지?",
    expectedSource: "fact:home_city",
    freshness: { currentSource: "fact:home_city", staleSource: "fact:home_city_old" }
  },
  // positives — EN
  { note: "fact: dentist (EN)", query: "who is my dentist?", expectedSource: "fact:dentist" },
  { note: "fact: laptop (EN)", query: "what laptop do I use for work?", expectedSource: "fact:laptop" },
  { note: "pref: tea (EN)", query: "what tea do I prefer?", expectedSource: "pref:tea" },
  { note: "goal: spanish (EN)", query: "what's my language goal this year?", expectedSource: "goal:spanish" },
  {
    note: "correction — current gym wins (EN)",
    query: "where do I work out now?",
    expectedSource: "fact:gym",
    freshness: { currentSource: "fact:gym", staleSource: "fact:gym_old" }
  },
  // absents — must abstain (never fabricate)
  { note: "absent: blood type", query: "내 혈액형이 뭐라고 했지?", expectedSource: null },
  { note: "absent: pet name", query: "내가 키우는 반려동물 이름 뭐였지?", expectedSource: null },
  { note: "absent: siblings", query: "나 형제자매 몇 명이라고 했지?", expectedSource: null },
  { note: "absent: birthday", query: "내 생일이 언제라고 했더라?", expectedSource: null },
  { note: "absent: company name", query: "내가 다니는 회사 이름이 뭐였지?", expectedSource: null },
  { note: "absent: shoe size (EN)", query: "what's my shoe size?", expectedSource: null },
  { note: "absent: favorite movie (EN)", query: "what's my favorite movie?", expectedSource: null },
  { note: "absent: middle name (EN)", query: "what's my middle name?", expectedSource: null }
];

/**
 * Deterministic scorer (the teeth). `observed` = { confidence, topSource }.
 * - positive case: PASS iff the gate is "confident" AND the top match is the
 *   expected entry (a confident recall of the WRONG entry FAILS; abstaining on a
 *   present fact FAILS).
 * - absent case: PASS iff the gate ABSTAINS ("ambiguous"|"none"); a "confident"
 *   verdict on an absent fact is a fabrication risk and FAILS.
 * @param {{confidence:"confident"|"ambiguous"|"none", topSource?:string|null}} observed
 * @param {{expectedSource:string|null, note?:string}} testCase
 * @returns {{ok:boolean, detail:string}}
 */
export function scoreRecallQualityCase(observed, testCase) {
  const conf = observed?.confidence;
  const top = observed?.topSource ?? null;
  if (testCase.expectedSource === null) {
    const ok = conf === "ambiguous" || conf === "none";
    return { ok, detail: ok ? `abstained (${conf})` : `did NOT abstain — confidence=${conf}, top=${top}` };
  }
  if (conf !== "confident") {
    return { ok: false, detail: `expected confident recall of ${testCase.expectedSource}, got ${conf}` };
  }
  const ok = top === testCase.expectedSource;
  return { ok, detail: ok ? `recalled ${top}` : `recalled WRONG entry ${top}, expected ${testCase.expectedSource}` };
}

/**
 * hit@1 (RETRIEVAL correctness, independent of the confidence gate): did the
 * RIGHT entry rank top-1, regardless of whether the gate then chose to present
 * it? Only meaningful for positive cases (the ranker always returns a top match,
 * so an absent case has no "right entry" to hit). Separating this from
 * `scoreRecallQualityCase` (which requires `confident`) is what tells a retrieval
 * miss apart from pure under-confidence — the diagnostic the 43% baseline needs.
 * @param {{topSource?:string|null}} observed
 * @param {{expectedSource:string|null}} testCase
 * @returns {{ok:boolean, applicable:boolean, detail:string}}
 */
export function scoreRecallHit1(observed, testCase) {
  if (testCase.expectedSource === null) {
    return { ok: false, applicable: false, detail: "n/a — absent case has no expected entry" };
  }
  const ok = (observed?.topSource ?? null) === testCase.expectedSource;
  return { ok, applicable: true, detail: ok ? `top-1 = ${testCase.expectedSource}` : `top-1 = ${observed?.topSource ?? null}` };
}

/**
 * Classify a POSITIVE case's outcome into the triad that pinpoints the fix:
 * - "confident-correct": the gate confidently recalled the right entry (good).
 * - "under-confidence":  the right entry IS top-1 but the gate abstained — the
 *                        cosine bar is too high for short memory entries
 *                        (recalibration territory, NOT a retrieval failure).
 * - "wrong-entry":       a different entry ranked top-1 (a real retrieval miss).
 * - "confident-wrong":   the gate confidently recalled the WRONG entry (worst).
 * Returns null for absent cases (not part of the retrieval triad).
 * @param {{confidence:string, topSource?:string|null}} observed
 * @param {{expectedSource:string|null}} testCase
 */
export function classifyRecallOutcome(observed, testCase) {
  if (testCase.expectedSource === null) return null;
  const rightTop = (observed?.topSource ?? null) === testCase.expectedSource;
  if (observed?.confidence === "confident") return rightTop ? "confident-correct" : "confident-wrong";
  return rightTop ? "under-confidence" : "wrong-entry";
}

/**
 * Observe the ordinary cosine-confidence contract without reordering its raw
 * selected candidates. Correction freshness is evaluated independently below;
 * globally demoting stale matches here could promote an unrelated fresh item
 * and mislabel it as either a successful or confidently-wrong recall.
 */
export function observeRecallQuality(matches, { classify, confidentAt }) {
  return {
    confidence: classify(matches, { confidentAt, promoteOnMargin: true }),
    topSource: matches[0]?.source ?? null,
  };
}

/** Inspect raw correction candidates before any freshness reordering. */
export function observeCorrectionFreshness(matches, testCase, { demoteStale } = {}) {
  const pair = testCase?.freshness;
  if (!pair?.currentSource || !pair?.staleSource) {
    throw new TypeError("correction freshness case requires currentSource and staleSource");
  }
  const selectedSources = new Set(matches.map((match) => match.source));
  const currentPresent = selectedSources.has(pair.currentSource);
  const stalePresent = selectedSources.has(pair.staleSource);
  if (!currentPresent || !stalePresent) {
    return { currentPresent, stalePresent, status: "unverified" };
  }
  if (typeof demoteStale !== "function") {
    throw new TypeError("correction freshness observation requires demoteStale");
  }
  const pairMatches = matches.filter((match) => match.source === pair.currentSource || match.source === pair.staleSource);
  const orderedPair = demoteStale(pairMatches, (match) => match.text);
  return {
    currentPreferred: orderedPair[0]?.source === pair.currentSource,
    currentPresent,
    stalePresent,
    status: "retained",
  };
}

/** Score correction-pair retention without inventing a topSource verdict. */
export function scoreCorrectionFreshnessCase(observed, testCase) {
  if (observed?.status === "retained" && observed.currentPresent === true && observed.stalePresent === true && observed.currentPreferred === true) {
    return {
      ok: true,
      detail: `retained current ${testCase.freshness.currentSource} + stale ${testCase.freshness.staleSource}`,
    };
  }
  const current = observed?.currentPresent ? "current retained" : "current absent";
  const stale = observed?.stalePresent ? "stale retained" : "stale absent";
  if (observed?.currentPresent && observed?.stalePresent && observed?.currentPreferred === false) {
    return { ok: false, detail: "freshness ordering failure — current was not preferred within the retained correction pair" };
  }
  return { ok: false, detail: `freshness retention failure — ${current}, ${stale}; unverified/abstain` };
}

/**
 * Production-path terminal scorer. Unlike the legacy pair-local observation,
 * this reads the exact prompt-evidence order emitted by prepareGroundedRecall:
 * an unrelated top document, stale-first order, or a missing counterpart all
 * fail. Expected metadata is consumed here only; the solver receives a
 * sanitized case identity + query and cannot leak these source labels into the
 * selector.
 */
export function scorePreparedRecallQualityCase(observed, testCase) {
  const sources = Array.isArray(observed?.sources) ? observed.sources : [];
  if (!testCase.freshness) {
    return scoreRecallQualityCase({
      confidence: observed?.confidence,
      topSource: sources[0] ?? null
    }, testCase);
  }
  const currentIndex = sources.indexOf(testCase.freshness.currentSource);
  const staleIndex = sources.indexOf(testCase.freshness.staleSource);
  if (currentIndex < 0 || staleIndex < 0) {
    return {
      ok: false,
      detail: `freshness retention failure — ${currentIndex < 0 ? "current absent" : "current retained"}, ${staleIndex < 0 ? "stale absent" : "stale retained"}`
    };
  }
  if (currentIndex !== 0) {
    return { ok: false, detail: `freshness top-1 failure — actual top was ${sources[0] ?? "none"}` };
  }
  if (currentIndex >= staleIndex) {
    return { ok: false, detail: "freshness ordering failure — current was not before stale" };
  }
  return {
    ok: true,
    detail: `retained current ${testCase.freshness.currentSource} top-1 before stale ${testCase.freshness.staleSource}`
  };
}

/** Combine the honest pooled baseline with both non-averageable hard floors. */
export function evaluateRecallQualityGate({ summary, absentPassed, absentTotal, correctionPassed, correctionTotal }) {
  const absentFloorMet = absentTotal >= 8 && absentPassed === absentTotal;
  const freshnessFloorMet = correctionTotal === 2 && correctionPassed === correctionTotal;
  return {
    absentFloorMet,
    freshnessFloorMet,
    gate: summary.gate === true && absentFloorMet && freshnessFloorMet,
  };
}

export const RECALL_QUALITY_RESULT_SCHEMA_VERSION = "muse-recall-quality-production.v2";
export const RECALL_QUALITY_TOP_K = 3;
export const RECALL_QUALITY_MIN_REPEAT = 3;

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_EMBED_MODEL = "nomic-embed-text-v2-moe";
const CHILD_TIMEOUT_MS = 45 * 60 * 1_000;
const SAFE_FAILURE_CODES = new Set([
  "CHILD_FAILED",
  "CHILD_TIMEOUT",
  "COLD_PRELOAD_UNVERIFIED",
  "EMBED_MODEL_UNAVAILABLE",
  "EVAL_ENV_INVALID",
  "FIXTURE_INVALID",
  "MODEL_PROVENANCE_DRIFT",
  "NETWORK_ACCOUNTING_DRIFT",
  "OLLAMA_UNREACHABLE",
  "OWNER_STATE_CHANGED",
  "PRODUCTION_PHASE_DRIFT",
  "RERANK_MODEL_MISSING",
  "SNAPSHOT_INVALID",
  "SOURCE_IDENTITY_MISSING",
  "THRESHOLD_NOT_MET",
  "UNEXPECTED_FAILURE"
]);

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function safeFailureCode(error) {
  const code = typeof error?.code === "string" ? error.code : typeof error?.message === "string" ? error.message : "";
  if (SAFE_FAILURE_CODES.has(code)) return code;
  if (/^MODEL_MISSING_OR_DIGEST:/u.test(code)) return "RERANK_MODEL_MISSING";
  if (code === "OLLAMA_UNREACHABLE") return code;
  return "UNEXPECTED_FAILURE";
}

function digestKey(value) {
  return String(value ?? "").replace(/^sha256:/u, "").toLowerCase();
}

export function isExactModelResident(payload, expected) {
  if (!payload || !Array.isArray(payload.models)) return false;
  const expectedDigest = digestKey(expected.digest);
  return payload.models.some((item) => {
    const tag = typeof item?.model === "string" ? item.model : typeof item?.name === "string" ? item.name : "";
    return tag === expected.resolvedTag && digestKey(item?.digest) === expectedDigest;
  });
}

export function sanitizeRecallQualityCases(cases = RECALL_QUALITY_CASES) {
  return cases.map((testCase, index) => Object.freeze({
    caseId: `recall-${String(index + 1).padStart(2, "0")}`,
    note: testCase.note,
    query: testCase.query
  }));
}

function sourceFilename(index) {
  return `memory-${String(index + 1).padStart(3, "0")}.md`;
}

function countDelta(after, before, key) {
  return after[key] - before[key];
}

/**
 * Execute one exact production two-phase recall without giving the solver any
 * expected source or correction labels. The immutable snapshot's reranker
 * identity is passed to prepare verbatim; an audited caller can additionally
 * prove that prepare issued no second preload/selector request.
 */
export async function executeProductionRecallQualityCase({
  embedFn,
  embedModel,
  indexBuiltAtIso,
  indexFiles,
  networkSnapshot,
  notesDir,
  notesIndexFile,
  prepare,
  retrieve,
  runtime,
  sourceForFile,
  testCase
}) {
  const before = networkSnapshot?.();
  const retrieval = await retrieve({
    embedModel,
    indexFiles,
    json: true,
    notesDir,
    onStderr: () => {},
    query: testCase.query,
    scope: undefined,
    snapshotIdentity: { indexBuiltAtIso, notesIndexFile },
    topK: RECALL_QUALITY_TOP_K
  }, runtime);
  const afterRetrieval = networkSnapshot?.();
  const snapshot = retrieval.snapshot;
  if (!snapshot
    || !Object.isFrozen(snapshot)
    || !Object.isFrozen(snapshot.identity)
    || !Object.isFrozen(snapshot.result)) {
    throw codedError("SNAPSHOT_INVALID");
  }
  const snapshotHash = snapshot.identity.rerankResultHash;
  const prepared = await prepare({
    embedFn,
    extras: { refineChunks: true },
    options: {
      conflictAwareSelection: true,
      embedModel,
      scope: undefined,
      topK: RECALL_QUALITY_TOP_K
    },
    query: testCase.query,
    rerankFn: snapshot.rerankFn,
    retrievalSnapshot: snapshot,
    sources: { notesDir, notesIndexFile }
  });
  const afterPrepare = networkSnapshot?.();
  if (snapshot.identity.rerankResultHash !== snapshotHash) throw codedError("SNAPSHOT_INVALID");
  if (before && afterRetrieval && afterPrepare) {
    if (countDelta(afterRetrieval, before, "preloadRequests") !== 1
      || countDelta(afterRetrieval, before, "selectorRequests") !== 1
      || afterPrepare.preloadRequests !== afterRetrieval.preloadRequests
      || afterPrepare.selectorRequests !== afterRetrieval.selectorRequests) {
      throw codedError("PRODUCTION_PHASE_DRIFT");
    }
  }
  const sources = prepared.scored.map((item) => sourceForFile(item.file));
  if (sources.some((source) => source === null)) throw codedError("SOURCE_IDENTITY_MISSING");
  return Object.freeze({
    confidence: prepared.verdict,
    rerankDecision: snapshot.result.rerankDecision,
    sources: Object.freeze(sources),
    snapshotReused: true
  });
}

async function readRunningModels(baseUrl, fetchImpl) {
  const response = await fetchImpl(`${baseUrl}/api/ps`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw codedError("OLLAMA_UNREACHABLE");
  try {
    return await response.json();
  } catch {
    throw codedError("OLLAMA_UNREACHABLE");
  }
}

async function createFixture({ auditFetch, baseUrl, embedModel, home, recall }) {
  const notesDir = join(home, "notes");
  const notesIndexFile = join(home, "notes-index.json");
  await mkdir(notesDir, { mode: 0o700, recursive: true });
  const sourceByFile = new Map();
  for (let index = 0; index < RECALL_MEMORY_CORPUS.length; index += 1) {
    const entry = RECALL_MEMORY_CORPUS[index];
    const path = join(notesDir, sourceFilename(index));
    await writeFile(path, `${entry.text}\n`, { mode: 0o600 });
    await chmod(path, 0o600);
    sourceByFile.set(resolve(path), entry.source);
  }
  const summary = await recall.reindexNotes({
    baseUrlResolver: () => baseUrl,
    dir: notesDir,
    fetchImpl: auditFetch,
    force: true,
    indexPath: notesIndexFile,
    model: embedModel
  });
  if (summary.failed !== 0
    || summary.totalFiles !== RECALL_MEMORY_CORPUS.length
    || summary.totalChunks !== RECALL_MEMORY_CORPUS.length
    || summary.index.version !== 2) {
    throw codedError(summary.failed === summary.totalFiles ? "EMBED_MODEL_UNAVAILABLE" : "FIXTURE_INVALID");
  }
  await chmod(notesIndexFile, 0o600);
  await chmod(recall.embeddingsSidecarPath(notesIndexFile), 0o600);
  return Object.freeze({
    index: summary.index,
    notesDir,
    notesIndexFile,
    sourceForFile: (file) => sourceByFile.get(resolve(file)) ?? null
  });
}

function reconcileNetworkAccounting(accounting, expectedCaseRuns) {
  const classified = accounting.answerRequests
    + accounting.controlRequests
    + accounting.embeddingRequests
    + accounting.otherLoopbackRequests
    + accounting.preloadRequests
    + accounting.selectorRequests;
  return accounting.answerRequests === 0
    && accounting.deniedExternalRequests === 0
    && accounting.otherLoopbackRequests === 0
    && accounting.preloadRequests === expectedCaseRuns
    && accounting.selectorRequests === expectedCaseRuns
    && accounting.controlRequests === 6
    && accounting.embeddingRequests >= RECALL_MEMORY_CORPUS.length + expectedCaseRuns
    && accounting.totalLoopbackRequests === classified;
}

export function validateRecallQualityResult(value, expectedRepeat) {
  if (!value
    || typeof value !== "object"
    || value.schemaVersion !== RECALL_QUALITY_RESULT_SCHEMA_VERSION
    || !["failed", "passed", "unverified"].includes(value.status)) {
    throw codedError("CHILD_FAILED");
  }
  if (!value.summary) {
    if (value.status === "passed" || !SAFE_FAILURE_CODES.has(value.reasonCode)) throw codedError("CHILD_FAILED");
    return value;
  }
  const { resultHash, ...hashed } = value;
  if (!/^[a-f0-9]{64}$/u.test(resultHash ?? "")
    || resultHash !== sha256(`${canonicalJson(hashed)}\n`)
    || value.repeat !== expectedRepeat
    || value.scorerVersion !== RECALL_QUALITY_CORRECTION_SCORER_VERSION
    || value.organicEffectiveness !== "NOT_PROVEN") {
    throw codedError("CHILD_FAILED");
  }
  if (value.summary.total !== 24
    || !Number.isInteger(value.summary.passed)
    || value.summary.passed < 0
    || value.summary.passed > value.summary.total
    || value.summary.rate !== value.summary.passed / value.summary.total
    || value.floors?.ordinary?.total !== 14
    || value.floors?.absent?.total !== 8
    || value.floors?.absent?.required !== 8
    || value.floors?.correction?.total !== 2
    || value.floors?.correction?.required !== 2) {
    throw codedError("CHILD_FAILED");
  }
  const requestedCaseRuns = RECALL_QUALITY_CASES.length * expectedRepeat;
  if (!Number.isInteger(value.passK?.executedCaseRuns)
    || value.passK.executedCaseRuns < RECALL_QUALITY_CASES.length
    || value.passK.executedCaseRuns > requestedCaseRuns
    || value.passK.requestedCaseRuns !== requestedCaseRuns
    || value.networkAccountingValid !== reconcileNetworkAccounting(value.accounting, value.passK.executedCaseRuns)
    || !Array.isArray(value.failures)
    || value.failures.some((caseId) => !/^recall-\d{2}$/u.test(caseId))
    || !/^(?:sha256:)?[a-f0-9]{64}$/u.test(value.models?.embed?.digest ?? "")
    || !/^(?:sha256:)?[a-f0-9]{64}$/u.test(value.models?.reranker?.digest ?? "")) {
    throw codedError("CHILD_FAILED");
  }
  const qualified = value.summary.passed >= 21
    && value.summary.gate === true
    && value.floors.absent.passed === 8
    && value.floors.correction.passed === 2
    && value.networkAccountingValid === true
    && value.coldPreload?.verified === true;
  if ((value.status === "passed") !== qualified
    || (qualified && value.reasonCode !== undefined)
    || (!qualified && !SAFE_FAILURE_CODES.has(value.reasonCode))) {
    throw codedError("CHILD_FAILED");
  }
  if (/\/Users\/|\/home\/|\.muse\/|expectedSource|currentSource|staleSource|prompt|candidateText/iu.test(canonicalJson(value))) {
    throw codedError("CHILD_FAILED");
  }
  return value;
}

async function runChildEvaluation({ embedModel, expectedRerankDigest, home, repeat, rerankerModel }) {
  if (process.env.HOME !== home
    || process.env.TMPDIR !== join(home, "tmp")
    || process.env.MUSE_LOCAL_ONLY !== "true"
    || process.env.MUSE_RECALL_RERANK !== rerankerModel) {
    throw codedError("EVAL_ENV_INVALID");
  }
  const baseUrl = canonicalLoopbackBaseUrl(process.env.OLLAMA_BASE_URL);
  const evalEnv = Object.freeze({ ...process.env });
  const audit = createAuditedLoopbackFetch(baseUrl);
  const [recall, cliRetrieval, cliEmbed] = await Promise.all([
    import("../packages/recall/dist/index.js"),
    import("../apps/cli/dist/ask-note-retrieval.js"),
    import("../apps/cli/dist/embed.js")
  ]);
  const [embedProvenance, rerankProvenance] = await Promise.all([
    modelInfo(baseUrl, embedModel, audit.fetch),
    modelInfo(baseUrl, rerankerModel, audit.fetch)
  ]);
  if (rerankProvenance.resolvedTag !== rerankerModel
    || digestKey(rerankProvenance.digest) !== digestKey(expectedRerankDigest)) {
    throw codedError("MODEL_PROVENANCE_DRIFT");
  }

  const fixture = await createFixture({ auditFetch: audit.fetch, baseUrl, embedModel, home, recall });
  const runningBefore = await readRunningModels(baseUrl, audit.fetch);
  const residentBefore = isExactModelResident(runningBefore, rerankProvenance);
  const sanitizedCases = sanitizeRecallQualityCases();
  const expectationById = new Map(sanitizedCases.map((item, index) => [item.caseId, RECALL_QUALITY_CASES[index]]));
  const ordinaryCases = sanitizedCases.filter((item) => !expectationById.get(item.caseId).freshness);
  const correctionCases = sanitizedCases.filter((item) => expectationById.get(item.caseId).freshness);
  const casePasses = new Map();
  const observations = new Map();
  let executedCaseRuns = 0;
  let firstObservation;
  let residentAfterFirst = false;
  const embedFn = (text, model) => cliEmbed.embed(text, model, { fetchImpl: audit.fetch }, evalEnv);
  const solve = async (testCase) => {
    executedCaseRuns += 1;
    const observed = await executeProductionRecallQualityCase({
      embedFn,
      embedModel,
      indexBuiltAtIso: fixture.index.builtAtIso,
      indexFiles: fixture.index.files,
      networkSnapshot: audit.snapshot,
      notesDir: fixture.notesDir,
      notesIndexFile: fixture.notesIndexFile,
      prepare: recall.prepareGroundedRecall,
      retrieve: cliRetrieval.retrieveAndRankNotes,
      runtime: { env: evalEnv, fetchFn: audit.fetch },
      sourceForFile: fixture.sourceForFile,
      testCase
    });
    if (!firstObservation) {
      firstObservation = observed;
      residentAfterFirst = isExactModelResident(await readRunningModels(baseUrl, audit.fetch), rerankProvenance);
    }
    observations.set(testCase.caseId, observed);
    return observed;
  };
  const score = (observed, testCase) => {
    const expectation = expectationById.get(testCase.caseId);
    const verdict = scorePreparedRecallQualityCase(observed, expectation);
    casePasses.set(testCase.caseId, (casePasses.get(testCase.caseId) ?? true) && verdict.ok);
    return verdict;
  };
  const summary = await runEvalSuite({
    infraRetries: 0,
    log: () => {},
    name: "eval:recall-quality",
    repeat,
    scenarios: [
      { cases: ordinaryCases, label: "production ordinary + abstention" },
      { cases: correctionCases, label: "production correction identity + order" }
    ],
    score,
    solve,
    threshold: 0.85
  });
  const absentCases = ordinaryCases.filter((item) => expectationById.get(item.caseId).expectedSource === null);
  const positiveCases = ordinaryCases.filter((item) => expectationById.get(item.caseId).expectedSource !== null);
  const absentPassed = absentCases.filter((item) => casePasses.get(item.caseId) === true).length;
  const correctionPassed = correctionCases.filter((item) => casePasses.get(item.caseId) === true).length;
  const ordinaryPassed = positiveCases.filter((item) => casePasses.get(item.caseId) === true).length;
  const gateDecision = evaluateRecallQualityGate({
    absentPassed,
    absentTotal: absentCases.length,
    correctionPassed,
    correctionTotal: correctionCases.length,
    summary
  });
  const requestedCaseRuns = RECALL_QUALITY_CASES.length * repeat;
  const networkAccounting = audit.snapshot();
  const networkAccountingValid = reconcileNetworkAccounting(networkAccounting, executedCaseRuns);
  const coldPreloadVerified = residentBefore === false
    && residentAfterFirst === true
    && firstObservation?.rerankDecision?.outcome === "success"
    && firstObservation?.snapshotReused === true;
  const qualified = summary.passed >= 21
    && gateDecision.gate
    && networkAccountingValid
    && coldPreloadVerified;
  const failedCaseIds = sanitizedCases.filter((item) => casePasses.get(item.caseId) !== true).map((item) => item.caseId);
  const result = {
    accounting: networkAccounting,
    coldPreload: { residentAfterFirst, residentBefore, verified: coldPreloadVerified },
    failures: failedCaseIds,
    floors: {
      absent: { passed: absentPassed, required: absentCases.length, total: absentCases.length },
      correction: { passed: correctionPassed, required: correctionCases.length, total: correctionCases.length },
      ordinary: { passed: ordinaryPassed, total: positiveCases.length }
    },
    models: {
      embed: { digest: embedProvenance.digest, resolvedTag: embedProvenance.resolvedTag },
      reranker: { digest: rerankProvenance.digest, resolvedTag: rerankProvenance.resolvedTag }
    },
    networkAccountingValid,
    organicEffectiveness: "NOT_PROVEN",
    passK: { executedCaseRuns, requestedCaseRuns },
    repeat,
    schemaVersion: RECALL_QUALITY_RESULT_SCHEMA_VERSION,
    scorerVersion: RECALL_QUALITY_CORRECTION_SCORER_VERSION,
    status: qualified ? "passed" : "failed",
    summary: { gate: summary.gate, passed: summary.passed, rate: summary.rate, total: summary.total },
    ...(!qualified ? {
      reasonCode: !networkAccountingValid
        ? "NETWORK_ACCOUNTING_DRIFT"
        : !coldPreloadVerified
          ? "COLD_PRELOAD_UNVERIFIED"
          : "THRESHOLD_NOT_MET"
    } : {})
  };
  return Object.freeze({
    ...result,
    resultHash: sha256(`${canonicalJson(result)}\n`)
  });
}

function childEnvironment({ baseUrl, embedModel, home, rerankerModel }) {
  return Object.freeze({
    HOME: home,
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
    MUSE_EMBED_MODEL: embedModel,
    MUSE_HOME: home,
    MUSE_LOCAL_ONLY: "true",
    MUSE_MODEL_KEYS_FILE: join(home, "models.json"),
    MUSE_NOTES_DIR: join(home, "notes"),
    MUSE_NOTES_INDEX_FILE: join(home, "notes-index.json"),
    MUSE_RECALL_RERANK: rerankerModel,
    OLLAMA_BASE_URL: baseUrl,
    PATH: process.env.PATH ?? "",
    TMPDIR: join(home, "tmp")
  });
}

function spawnChild(args, env) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, args, { cwd: repoRoot, env, stdio: "ignore" });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, CHILD_TIMEOUT_MS);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolveRun({ code, signal, timedOut });
    });
    child.once("error", () => {
      clearTimeout(timer);
      resolveRun({ code: null, signal: null, timedOut: false });
    });
  });
}

function parseInternalArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw codedError("EVAL_ENV_INVALID");
    parsed[key.slice(2)] = value;
  }
  return parsed;
}

async function writeSafeChildFailure(outputPath, reasonCode) {
  await writeAtomic(outputPath, `${canonicalJson({
    organicEffectiveness: "NOT_PROVEN",
    reasonCode,
    schemaVersion: RECALL_QUALITY_RESULT_SCHEMA_VERSION,
    status: ["OLLAMA_UNREACHABLE", "RERANK_MODEL_MISSING", "EMBED_MODEL_UNAVAILABLE"].includes(reasonCode) ? "unverified" : "failed"
  })}\n`);
}

async function childMain(options) {
  const repeat = Number(options.repeat);
  if (!options.embed
    || !options.home
    || !options.out
    || !options.reranker
    || !/^(?:sha256:)?[a-f0-9]{64}$/u.test(options.digest ?? "")
    || !Number.isSafeInteger(repeat)
    || repeat < RECALL_QUALITY_MIN_REPEAT) {
    throw codedError("EVAL_ENV_INVALID");
  }
  try {
    const result = await runChildEvaluation({
      embedModel: options.embed,
      expectedRerankDigest: options.digest,
      home: options.home,
      repeat,
      rerankerModel: options.reranker
    });
    await writeAtomic(options.out, `${canonicalJson(result)}\n`);
    if (result.status !== "passed") process.exitCode = 1;
  } catch (error) {
    await writeSafeChildFailure(options.out, safeFailureCode(error));
    process.exitCode = 1;
  }
}

function printResult(result, repeat) {
  console.log("eval:recall-quality — exact CLI retrieval → immutable snapshot → public prepare");
  console.log(`  pass^${repeat.toString()} aggregate : ${result.summary.passed}/${result.summary.total} (${(result.summary.rate * 100).toFixed(1)}%)`);
  console.log(`  executed case runs: ${result.passK.executedCaseRuns}/${result.passK.requestedCaseRuns} (strict failures short-circuit remaining repeats)`);
  console.log(`  ordinary positives : ${result.floors.ordinary.passed}/${result.floors.ordinary.total}`);
  console.log(`  absent abstention  : ${result.floors.absent.passed}/${result.floors.absent.total}`);
  console.log(`  correction order   : ${result.floors.correction.passed}/${result.floors.correction.total}`);
  console.log(`  cold preload       : ${result.coldPreload.verified ? "VERIFIED" : "UNVERIFIED"}`);
  console.log(`  audited local calls: embed ${result.accounting.embeddingRequests} · preload ${result.accounting.preloadRequests} · selector ${result.accounting.selectorRequests} · answer ${result.accounting.answerRequests} · external ${result.accounting.deniedExternalRequests}`);
  console.log("  organic effectiveness: NOT_PROVEN");
}

async function parentMain(embedModel) {
  const repeat = Math.max(RECALL_QUALITY_MIN_REPEAT, Math.trunc(Number(process.env.MUSE_EVAL_REPEAT) || RECALL_QUALITY_MIN_REPEAT));
  const baseUrl = canonicalLoopbackBaseUrl(process.env.OLLAMA_BASE_URL?.trim() || "http://127.0.0.1:11434");
  const ownerRoot = join(homedir(), ".muse");
  const before = await manifestTree(ownerRoot);
  let after;
  let isolatedRoot;
  let result;
  let parentFailure;
  try {
    const ownerAudit = createAuditedLoopbackFetch(baseUrl);
    const { resolveRerankModel } = await import("../apps/cli/dist/ask-note-retrieval.js");
    const configuredReranker = resolveRerankModel(process.env);
    if (!configuredReranker) throw codedError("RERANK_MODEL_MISSING");
    const reranker = await modelInfo(baseUrl, configuredReranker, ownerAudit.fetch);
    const ownerAccounting = ownerAudit.snapshot();
    if (ownerAccounting.controlRequests !== 2
      || ownerAccounting.totalLoopbackRequests !== 2
      || ownerAccounting.deniedExternalRequests !== 0) {
      throw codedError("NETWORK_ACCOUNTING_DRIFT");
    }
    isolatedRoot = await mkdtemp(join(tmpdir(), "muse-recall-quality-"));
    await chmod(isolatedRoot, 0o700);
    await mkdir(join(isolatedRoot, "tmp"), { mode: 0o700, recursive: true });
    await writeFile(join(isolatedRoot, "models.json"), "{}\n", { mode: 0o600 });
    const outputPath = join(isolatedRoot, "result.json");
    const env = childEnvironment({
      baseUrl,
      embedModel,
      home: isolatedRoot,
      rerankerModel: reranker.resolvedTag
    });
    const args = [
      fileURLToPath(import.meta.url),
      "--child", "1",
      "--digest", reranker.digest,
      "--embed", embedModel,
      "--home", isolatedRoot,
      "--out", outputPath,
      "--repeat", String(repeat),
      "--reranker", reranker.resolvedTag
    ];
    const run = await spawnChild(args, env);
    if (run.timedOut) throw codedError("CHILD_TIMEOUT");
    try {
      result = validateRecallQualityResult(JSON.parse(await readFile(outputPath, "utf8")), repeat);
    } catch {
      throw codedError("CHILD_FAILED");
    }
    if (run.code !== 0 && result.status === "passed") throw codedError("CHILD_FAILED");
  } catch (error) {
    parentFailure = safeFailureCode(error);
  } finally {
    after = await manifestTree(ownerRoot);
    if (isolatedRoot) await rm(isolatedRoot, { force: true, recursive: true });
  }

  if (before.manifestSha256 !== after.manifestSha256) parentFailure = "OWNER_STATE_CHANGED";
  if (parentFailure) {
    const unavailable = ["OLLAMA_UNREACHABLE", "RERANK_MODEL_MISSING", "EMBED_MODEL_UNAVAILABLE"].includes(parentFailure);
    if (unavailable) {
      console.log("eval:recall-quality skipped — required local model runtime unavailable. A skip is NOT a pass.");
      console.log(skipLine(parentFailure.toLowerCase().replaceAll("_", "-"), "local qualification dependency unavailable"));
      console.log(completionLine({ status: "unverified", requested: repeat, executed: 0, reason: parentFailure.toLowerCase().replaceAll("_", "-") }));
      return;
    }
    console.error(`eval:recall-quality failed — ${parentFailure}`);
    console.log(completionLine({ status: "failed", requested: repeat, executed: 0, reason: parentFailure.toLowerCase().replaceAll("_", "-") }));
    process.exitCode = 1;
    return;
  }
  if (result.status === "unverified") {
    console.log("eval:recall-quality skipped — required local model runtime unavailable. A skip is NOT a pass.");
    console.log(skipLine(result.reasonCode.toLowerCase().replaceAll("_", "-"), "local qualification dependency unavailable"));
    console.log(completionLine({ status: "unverified", requested: repeat, executed: 0, reason: result.reasonCode.toLowerCase().replaceAll("_", "-") }));
    return;
  }
  if (result.status !== "passed") {
    if (result.summary) printResult(result, repeat);
    console.log(completionLine({ status: "failed", requested: repeat, executed: repeat, reason: result.reasonCode.toLowerCase().replaceAll("_", "-") }));
    process.exitCode = 1;
    return;
  }
  printResult(result, repeat);
  console.log(completionLine({ status: "passed", requested: repeat, executed: repeat }));
}

async function main() {
  const args = process.argv.slice(2).filter((value) => value !== "--");
  if (args[0] === "--child") {
    await childMain(parseInternalArgs(args.slice(2)));
    return;
  }
  if (args.length > 1 || args[0]?.startsWith("--")) throw codedError("EVAL_ENV_INVALID");
  await parentMain(args[0] ?? DEFAULT_EMBED_MODEL);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    await main();
  } catch (error) {
    const reasonCode = safeFailureCode(error);
    console.error(`eval:recall-quality failed — ${reasonCode}`);
    process.exitCode = 1;
  }
}
