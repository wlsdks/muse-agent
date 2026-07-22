// Deterministic unit tests for the eval:recall-quality scorer — the teeth that
// hold even when Ollama is down (a skip is not a pass).
// Run: node --test scripts/eval-recall-quality.test.mjs   (zero deps, no Ollama)

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classifyRecallOutcome,
  executeProductionRecallQualityCase,
  evaluateRecallQualityGate,
  isExactModelResident,
  observeCorrectionFreshness,
  observeRecallQuality,
  RECALL_MEMORY_CORPUS,
  RECALL_QUALITY_CASES,
  RECALL_QUALITY_CORRECTION_SCORER_VERSION,
  RECALL_QUALITY_RESULT_SCHEMA_VERSION,
  scoreRecallHit1,
  scoreRecallQualityCase,
  scoreCorrectionFreshnessCase,
  scorePreparedRecallQualityCase,
  sanitizeRecallQualityCases,
  validateRecallQualityResult
} from "./eval-recall-quality.mjs";
import { canonicalJson, createAuditedLoopbackFetch, sha256 } from "./recall-eval-runtime-common.mjs";

const POSITIVE = { note: "x", expectedSource: "fact:car" };
const ABSENT = { note: "x", expectedSource: null };

test("audited recall transport observes request classes and denies non-loopback without retaining content", async () => {
  const dispatched = [];
  const audit = createAuditedLoopbackFetch("http://127.0.0.1:11434", async (input) => {
    dispatched.push(String(input));
    return new Response("{}", { status: 200 });
  });
  await audit.fetch("http://127.0.0.1:11434/api/tags");
  await audit.fetch("http://127.0.0.1:11434/api/embeddings", { method: "POST", body: JSON.stringify({ model: "embed", prompt: "private embedding text" }) });
  await audit.fetch("http://127.0.0.1:11434/api/generate", { method: "POST", body: JSON.stringify({ model: "local", stream: false, keep_alive: "5m" }) });
  await audit.fetch("http://127.0.0.1:11434/api/generate", { method: "POST", body: JSON.stringify({ model: "local", prompt: "private selector text", format: "json", stream: false }) });
  await audit.fetch("http://127.0.0.1:11434/api/generate", { method: "POST", body: JSON.stringify({ model: "local", prompt: "answer request", stream: false }) });
  await assert.rejects(audit.fetch("https://example.com/api/generate", { method: "POST" }), /EXTERNAL_REQUEST_DENIED/u);
  assert.deepEqual(audit.snapshot(), {
    answerRequests: 1,
    controlRequests: 1,
    deniedExternalRequests: 1,
    embeddingRequests: 1,
    otherLoopbackRequests: 0,
    preloadRequests: 1,
    selectorRequests: 1,
    totalLoopbackRequests: 5
  });
  assert.equal(dispatched.length, 5);
  assert.doesNotMatch(JSON.stringify(audit.snapshot()), /private|answer request/iu);
});

test("production solver cases contain no expected source or freshness labels", () => {
  const cases = sanitizeRecallQualityCases();
  assert.equal(cases.length, RECALL_QUALITY_CASES.length);
  assert.deepEqual(Object.keys(cases[0]).sort(), ["caseId", "note", "query"]);
  assert.equal(Object.isFrozen(cases[0]), true);
  assert.doesNotMatch(JSON.stringify(cases), /expectedSource|currentSource|staleSource/u);
});

test("cold residency requires the exact resolved tag and digest", () => {
  const digest = "a".repeat(64);
  const expected = { digest: `sha256:${digest}`, resolvedTag: "gemma4:12b" };
  assert.equal(isExactModelResident({ models: [{ digest, model: "gemma4:12b" }] }, expected), true);
  assert.equal(isExactModelResident({ models: [{ digest, model: "gemma4:latest" }] }, expected), false);
  assert.equal(isExactModelResident({ models: [{ digest: "b".repeat(64), model: "gemma4:12b" }] }, expected), false);
});

function frozenSnapshot(rerankFn) {
  const result = Object.freeze({
    notesUnavailable: false,
    preGapScored: Object.freeze([]),
    queryVec: Object.freeze([1]),
    rerankDecision: Object.freeze({ eligible: true, httpAttempts: 1, logicalInvocations: 1, outcome: "success" }),
    scored: Object.freeze([]),
    splitClauses: Object.freeze([]),
    subqueryEmbeddings: Object.freeze([])
  });
  return Object.freeze({
    identity: Object.freeze({
      conflictAwareSelection: true,
      embedModel: "embed",
      indexBuiltAtIso: "2026-07-21T00:00:00.000Z",
      notesDir: "/isolated/notes",
      notesIndexFile: "/isolated/index.json",
      query: "where now?",
      rerankResultHash: "hash",
      scope: undefined,
      topK: 3
    }),
    rerankFn,
    result
  });
}

test("production case executes CLI retrieval once then prepares from its exact immutable snapshot", async () => {
  const rerankFn = Object.assign(async () => undefined, { mode: "correction-pair" });
  const snapshot = frozenSnapshot(rerankFn);
  const accounting = { preloadRequests: 0, selectorRequests: 0 };
  let retrievedInput;
  let preparedInput;
  const observed = await executeProductionRecallQualityCase({
    embedFn: async () => [1],
    embedModel: "embed",
    indexBuiltAtIso: "2026-07-21T00:00:00.000Z",
    indexFiles: [],
    networkSnapshot: () => ({ ...accounting }),
    notesDir: "/isolated/notes",
    notesIndexFile: "/isolated/index.json",
    prepare: async (input) => {
      preparedInput = input;
      return { scored: [{ file: "/isolated/notes/current.md" }], verdict: "confident" };
    },
    retrieve: async (input) => {
      retrievedInput = input;
      accounting.preloadRequests += 1;
      accounting.selectorRequests += 1;
      return { snapshot };
    },
    runtime: { env: Object.freeze({ HOME: "/isolated" }), fetchFn: async () => new Response() },
    sourceForFile: () => "fact:current",
    testCase: Object.freeze({ caseId: "recall-01", note: "opaque", query: "where now?" })
  });
  assert.deepEqual(Object.keys(retrievedInput).sort(), ["embedModel", "indexFiles", "json", "notesDir", "onStderr", "query", "scope", "snapshotIdentity", "topK"]);
  assert.equal(preparedInput.retrievalSnapshot, snapshot);
  assert.equal(preparedInput.rerankFn, snapshot.rerankFn);
  assert.equal(observed.snapshotReused, true);
  assert.deepEqual(observed.sources, ["fact:current"]);
  assert.deepEqual(accounting, { preloadRequests: 1, selectorRequests: 1 });
});

test("production case fails closed if prepare reruns the selector", async () => {
  const rerankFn = Object.assign(async () => undefined, { mode: "correction-pair" });
  const accounting = { preloadRequests: 0, selectorRequests: 0 };
  await assert.rejects(executeProductionRecallQualityCase({
    embedFn: async () => [1],
    embedModel: "embed",
    indexBuiltAtIso: "2026-07-21T00:00:00.000Z",
    indexFiles: [],
    networkSnapshot: () => ({ ...accounting }),
    notesDir: "/isolated/notes",
    notesIndexFile: "/isolated/index.json",
    prepare: async () => {
      accounting.selectorRequests += 1;
      return { scored: [], verdict: "none" };
    },
    retrieve: async () => {
      accounting.preloadRequests += 1;
      accounting.selectorRequests += 1;
      return { snapshot: frozenSnapshot(rerankFn) };
    },
    runtime: {},
    sourceForFile: () => null,
    testCase: { caseId: "recall-01", note: "opaque", query: "where now?" }
  }), /PRODUCTION_PHASE_DRIFT/u);
});

test("production result validator reconciles pass^3 accounting and rejects mutation", () => {
  const payload = {
    accounting: {
      answerRequests: 0,
      controlRequests: 6,
      deniedExternalRequests: 0,
      embeddingRequests: 94,
      otherLoopbackRequests: 0,
      preloadRequests: 72,
      selectorRequests: 72,
      totalLoopbackRequests: 244
    },
    coldPreload: { residentAfterFirst: true, residentBefore: false, verified: true },
    failures: ["recall-04", "recall-07", "recall-09"],
    floors: {
      absent: { passed: 8, required: 8, total: 8 },
      correction: { passed: 2, required: 2, total: 2 },
      ordinary: { passed: 11, total: 14 }
    },
    models: {
      embed: { digest: "a".repeat(64), resolvedTag: "embed:latest" },
      reranker: { digest: "b".repeat(64), resolvedTag: "reranker:12b" }
    },
    networkAccountingValid: true,
    organicEffectiveness: "NOT_PROVEN",
    passK: { executedCaseRuns: 72, requestedCaseRuns: 72 },
    repeat: 3,
    schemaVersion: RECALL_QUALITY_RESULT_SCHEMA_VERSION,
    scorerVersion: RECALL_QUALITY_CORRECTION_SCORER_VERSION,
    status: "passed",
    summary: { gate: true, passed: 21, rate: 0.875, total: 24 }
  };
  const value = { ...payload, resultHash: sha256(`${canonicalJson(payload)}\n`) };
  assert.equal(validateRecallQualityResult(value, 3), value);
  assert.throws(() => validateRecallQualityResult({ ...value, accounting: { ...value.accounting, answerRequests: 1 } }, 3), /CHILD_FAILED/u);
});

test("failed pass^3 accounting uses actual short-circuited executions without masking the quality failure", () => {
  const payload = {
    accounting: {
      answerRequests: 0,
      controlRequests: 6,
      deniedExternalRequests: 0,
      embeddingRequests: 84,
      otherLoopbackRequests: 0,
      preloadRequests: 62,
      selectorRequests: 62,
      totalLoopbackRequests: 214
    },
    coldPreload: { residentAfterFirst: true, residentBefore: false, verified: true },
    failures: ["recall-01", "recall-02", "recall-03", "recall-04", "recall-05"],
    floors: {
      absent: { passed: 8, required: 8, total: 8 },
      correction: { passed: 1, required: 2, total: 2 },
      ordinary: { passed: 10, total: 14 }
    },
    models: {
      embed: { digest: "a".repeat(64), resolvedTag: "embed:latest" },
      reranker: { digest: "b".repeat(64), resolvedTag: "reranker:12b" }
    },
    networkAccountingValid: true,
    organicEffectiveness: "NOT_PROVEN",
    passK: { executedCaseRuns: 62, requestedCaseRuns: 72 },
    reasonCode: "THRESHOLD_NOT_MET",
    repeat: 3,
    schemaVersion: RECALL_QUALITY_RESULT_SCHEMA_VERSION,
    scorerVersion: RECALL_QUALITY_CORRECTION_SCORER_VERSION,
    status: "failed",
    summary: { gate: false, passed: 19, rate: 19 / 24, total: 24 }
  };
  const value = { ...payload, resultHash: sha256(`${canonicalJson(payload)}\n`) };
  assert.equal(validateRecallQualityResult(value, 3), value);
});

test("aggregate keeps the honest 18/24 baseline failed even when both hard floors pass", () => {
  assert.deepEqual(evaluateRecallQualityGate({
    absentPassed: 8,
    absentTotal: 8,
    correctionPassed: 2,
    correctionTotal: 2,
    summary: { gate: false, passed: 18, rate: 18 / 24, total: 24 },
  }), { absentFloorMet: true, freshnessFloorMet: true, gate: false });
});

test("ordinary observation uses the calibrated bar without globally reordering candidates", () => {
  const matches = [
    { cosine: 0.9, score: 0.9, source: "fact:car", text: "car" },
    { cosine: 0.5, score: 0.5, source: "d:budget", text: "budget" },
  ];
  let seenOptions;
  let seenMatches;
  const observed = observeRecallQuality(matches, {
    confidentAt: 0.45,
    classify: (selected, options) => {
      seenMatches = selected;
      seenOptions = options;
      return "confident";
    },
  });
  assert.deepEqual(observed, { confidence: "confident", topSource: "fact:car" });
  assert.equal(seenMatches, matches);
  assert.deepEqual(seenOptions, { confidentAt: 0.45, promoteOnMargin: true });
});

test("correction freshness passes only when raw selection retains current and stale together", () => {
  const testCase = {
    expectedSource: "fact:home_city",
    freshness: { currentSource: "fact:home_city", staleSource: "fact:home_city_old" },
  };
  const observed = observeCorrectionFreshness([
    { source: "fact:home_city_old", text: "stale" },
    { source: "fact:home_city", text: "current" },
  ], testCase, { demoteStale: (pair) => [pair[1], pair[0]] });
  assert.deepEqual(observed, { currentPreferred: true, currentPresent: true, stalePresent: true, status: "retained" });
  assert.equal(scoreCorrectionFreshnessCase(observed, testCase).ok, true);
});

test("correction freshness fails if the retained pair does not prefer current after pair-local demotion", () => {
  const testCase = {
    expectedSource: "fact:gym",
    freshness: { currentSource: "fact:gym", staleSource: "fact:gym_old" },
  };
  const observed = observeCorrectionFreshness([
    { source: "fact:gym_old", text: "stale" },
    { source: "fact:gym", text: "current" },
  ], testCase, { demoteStale: (pair) => pair });
  assert.deepEqual(observed, { currentPreferred: false, currentPresent: true, stalePresent: true, status: "retained" });
  const verdict = scoreCorrectionFreshnessCase(observed, testCase);
  assert.equal(verdict.ok, false);
  assert.match(verdict.detail, /current was not preferred/iu);
});

test("v2 production scorer requires actual current top-1 before the retained stale counterpart", () => {
  const testCase = {
    expectedSource: "fact:home_city",
    freshness: { currentSource: "fact:home_city", staleSource: "fact:home_city_old" }
  };
  assert.equal(RECALL_QUALITY_CORRECTION_SCORER_VERSION, "recall-quality-correction-order-v2");
  assert.equal(scorePreparedRecallQualityCase({
    confidence: "ambiguous",
    sources: ["fact:home_city", "d:budget", "fact:home_city_old"]
  }, testCase).ok, true);
  for (const sources of [
    ["d:budget", "fact:home_city", "fact:home_city_old"],
    ["fact:home_city_old", "fact:home_city"],
    ["fact:home_city"]
  ]) {
    assert.equal(scorePreparedRecallQualityCase({ confidence: "confident", sources }, testCase).ok, false, sources.join(","));
  }
});

test("v2 production scorer keeps ordinary confidence/wrong-top and absent abstention teeth", () => {
  assert.equal(scorePreparedRecallQualityCase({ confidence: "confident", sources: ["fact:car"] }, POSITIVE).ok, true);
  assert.equal(scorePreparedRecallQualityCase({ confidence: "ambiguous", sources: ["fact:car"] }, POSITIVE).ok, false);
  assert.equal(scorePreparedRecallQualityCase({ confidence: "confident", sources: ["d:budget"] }, ABSENT).ok, false);
  assert.equal(scorePreparedRecallQualityCase({ confidence: "ambiguous", sources: ["d:budget"] }, ABSENT).ok, true);
});

test("mutation: stale retained/current absent plus unrelated fresh is explicit retention failure, never confident-unrelated", () => {
  const testCase = {
    expectedSource: "fact:home_city",
    freshness: { currentSource: "fact:home_city", staleSource: "fact:home_city_old" },
  };
  let demoteCalled = false;
  const observed = observeCorrectionFreshness([
    { cosine: 0.9, source: "d:budget", text: "unrelated but fresh" },
    { cosine: 0.8, source: "fact:home_city_old", text: "stale" },
  ], testCase, { demoteStale: () => { demoteCalled = true; return []; } });
  assert.deepEqual(observed, { currentPresent: false, stalePresent: true, status: "unverified" });
  assert.equal(demoteCalled, false, "an incomplete raw pair must fail before freshness reordering");
  assert.equal("confidence" in observed, false);
  assert.equal("topSource" in observed, false);
  const verdict = scoreCorrectionFreshnessCase(observed, testCase);
  assert.equal(verdict.ok, false);
  assert.match(verdict.detail, /retention failure.*current absent.*stale retained.*unverified\/abstain/iu);
});

test("positive: confident recall of the EXPECTED entry passes", () => {
  const r = scoreRecallQualityCase({ confidence: "confident", topSource: "fact:car" }, POSITIVE);
  assert.equal(r.ok, true);
});

test("positive: confident recall of the WRONG entry fails (mutation guard)", () => {
  const r = scoreRecallQualityCase({ confidence: "confident", topSource: "fact:home_city" }, POSITIVE);
  assert.equal(r.ok, false);
  assert.match(r.detail, /WRONG entry/);
});

test("positive: abstaining on a PRESENT fact fails (under-recall guard)", () => {
  for (const conf of ["ambiguous", "none"]) {
    const r = scoreRecallQualityCase({ confidence: conf, topSource: "fact:car" }, POSITIVE);
    assert.equal(r.ok, false, `confidence=${conf} must fail a present fact`);
  }
});

test("absent: abstaining (ambiguous|none) passes", () => {
  for (const conf of ["ambiguous", "none"]) {
    const r = scoreRecallQualityCase({ confidence: conf, topSource: null }, ABSENT);
    assert.equal(r.ok, true, `confidence=${conf} must pass an absent fact`);
  }
});

test("absent: a CONFIDENT verdict on an absent fact fails (fabrication guard)", () => {
  const r = scoreRecallQualityCase({ confidence: "confident", topSource: "d:budget" }, ABSENT);
  assert.equal(r.ok, false);
  assert.match(r.detail, /did NOT abstain/);
});

test("dataset integrity: every expectedSource resolves to a real corpus entry (or null)", () => {
  const sources = new Set(RECALL_MEMORY_CORPUS.map((m) => m.source));
  for (const c of RECALL_QUALITY_CASES) {
    if (c.expectedSource !== null) {
      assert.ok(sources.has(c.expectedSource), `case "${c.note}" expects missing source ${c.expectedSource}`);
    }
  }
});

test("dataset integrity: the correction pair keeps BOTH the current and stale entry", () => {
  const sources = new Set(RECALL_MEMORY_CORPUS.map((m) => m.source));
  // the temporal test only has teeth if the stale value is present as a distractor
  assert.ok(sources.has("fact:home_city"), "current home-city entry must exist");
  assert.ok(sources.has("fact:home_city_old"), "stale home-city entry must exist as a distractor");
  const correction = RECALL_QUALITY_CASES.find((c) => /correction/.test(c.note));
  assert.ok(correction, "a correction case must exist");
  assert.equal(correction.expectedSource, "fact:home_city", "the CURRENT value must be the expected recall");
});

test("dataset integrity: at least one absent (abstain) case exists", () => {
  assert.ok(RECALL_QUALITY_CASES.some((c) => c.expectedSource === null), "need a negative/abstain case");
});

test("dataset integrity: calibration-grade size — enough positives AND absents", () => {
  const positives = RECALL_QUALITY_CASES.filter((c) => c.expectedSource !== null).length;
  const absents = RECALL_QUALITY_CASES.filter((c) => c.expectedSource === null).length;
  // a fabrication-critical bar can only be calibrated against a real distribution,
  // not 7 points (fire 3 lesson): require breadth on both arms.
  assert.ok(positives >= 16, `need >=16 positives for a calibration-grade distribution, have ${positives}`);
  assert.ok(absents >= 8, `need >=8 absents to bound the fabrication floor, have ${absents}`);
});

test("dataset integrity: both correction pairs keep the stale distractor (teeth)", () => {
  const sources = new Set(RECALL_MEMORY_CORPUS.map((m) => m.source));
  for (const [current, stale] of [["fact:home_city", "fact:home_city_old"], ["fact:gym", "fact:gym_old"]]) {
    assert.ok(sources.has(current), `${current} (current) must exist`);
    assert.ok(sources.has(stale), `${stale} (stale distractor) must exist for the correction to have teeth`);
  }
  const correctionPairs = RECALL_QUALITY_CASES.filter((c) => c.freshness);
  assert.equal(correctionPairs.length, 2);
  assert.deepEqual(
    correctionPairs.map((c) => c.freshness),
    [
      { currentSource: "fact:home_city", staleSource: "fact:home_city_old" },
      { currentSource: "fact:gym", staleSource: "fact:gym_old" },
    ]
  );
});

// --- fire 2: hit@1 (retrieval) split from the confidence gate ---

test("hit@1: right entry top-1 passes regardless of confidence (the under-confidence case)", () => {
  // ambiguous + right top-1 = retrieval HIT even though the gate would abstain
  const r = scoreRecallHit1({ confidence: "ambiguous", topSource: "fact:car" }, POSITIVE);
  assert.equal(r.ok, true);
  assert.equal(r.applicable, true);
});

test("hit@1: wrong entry top-1 fails (a real retrieval miss)", () => {
  const r = scoreRecallHit1({ confidence: "confident", topSource: "fact:home_city" }, POSITIVE);
  assert.equal(r.ok, false);
});

test("hit@1: absent case is not applicable (never counted)", () => {
  const r = scoreRecallHit1({ confidence: "none", topSource: "d:budget" }, ABSENT);
  assert.equal(r.applicable, false);
});

test("classifyRecallOutcome: the four positive outcomes are distinguished", () => {
  assert.equal(classifyRecallOutcome({ confidence: "confident", topSource: "fact:car" }, POSITIVE), "confident-correct");
  assert.equal(classifyRecallOutcome({ confidence: "ambiguous", topSource: "fact:car" }, POSITIVE), "under-confidence");
  assert.equal(classifyRecallOutcome({ confidence: "none", topSource: "d:budget" }, POSITIVE), "wrong-entry");
  assert.equal(classifyRecallOutcome({ confidence: "confident", topSource: "d:budget" }, POSITIVE), "confident-wrong");
});

test("classifyRecallOutcome: absent case returns null (outside the retrieval triad)", () => {
  assert.equal(classifyRecallOutcome({ confidence: "none", topSource: "d:budget" }, ABSENT), null);
});
