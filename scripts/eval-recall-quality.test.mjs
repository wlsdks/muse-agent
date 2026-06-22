// Deterministic unit tests for the eval:recall-quality scorer — the teeth that
// hold even when Ollama is down (a skip is not a pass).
// Run: node --test scripts/eval-recall-quality.test.mjs   (zero deps, no Ollama)

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  RECALL_MEMORY_CORPUS,
  RECALL_QUALITY_CASES,
  scoreRecallQualityCase
} from "./eval-recall-quality.mjs";

const POSITIVE = { note: "x", expectedSource: "fact:car" };
const ABSENT = { note: "x", expectedSource: null };

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
