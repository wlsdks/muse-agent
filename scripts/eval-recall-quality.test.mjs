// Deterministic unit tests for the eval:recall-quality scorer — the teeth that
// hold even when Ollama is down (a skip is not a pass).
// Run: node --test scripts/eval-recall-quality.test.mjs   (zero deps, no Ollama)

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classifyRecallOutcome,
  evaluateRecallQualityGate,
  observeCorrectionFreshness,
  observeRecallQuality,
  RECALL_MEMORY_CORPUS,
  RECALL_QUALITY_CASES,
  scoreRecallHit1,
  scoreRecallQualityCase,
  scoreCorrectionFreshnessCase
} from "./eval-recall-quality.mjs";

const POSITIVE = { note: "x", expectedSource: "fact:car" };
const ABSENT = { note: "x", expectedSource: null };

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
