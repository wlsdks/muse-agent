import assert from "node:assert/strict";
import test from "node:test";

import {
  TASK_050_CORPUS,
  assessCorrectionPairRetention,
  assessOrdinaryTop1,
  task050CorpusHash
} from "./lib/task-050-pair-retention-probe.mjs";

test("fixed Task050 corpus is deterministic and contains two independent pairs", () => {
  assert.equal(TASK_050_CORPUS.cases.length, 2);
  assert.equal(new Set(TASK_050_CORPUS.notes.map((note) => note.sourceId)).size, 9);
  assert.equal(task050CorpusHash(), "6edd17271942cf0a5256402c58bf34f01b6024ef8b9f8cec052685596e05c002");
});

test("pair assessment requires the excluded counterpart to be added within fixed topK", () => {
  const result = assessCorrectionPairRetention({
    currentSourceId: "current",
    oldSourceId: "old",
    preMmrSourceIds: ["old", "noise-a", "noise-b"],
    retainedSourceIds: ["current", "old", "noise-a"],
    topK: 3
  });
  assert.equal(result.passed, true);
  assert.deepEqual(result.addedSourceIds, ["current"]);

  assert.equal(assessCorrectionPairRetention({
    currentSourceId: "current",
    oldSourceId: "old",
    preMmrSourceIds: ["old", "noise-a", "noise-b"],
    retainedSourceIds: ["old", "noise-a", "noise-b"],
    topK: 3
  }).passed, false);
});

test("pair assessment fails closed for duplicates and invalid bounds", () => {
  assert.throws(() => assessCorrectionPairRetention({
    currentSourceId: "current",
    oldSourceId: "old",
    preMmrSourceIds: ["old", "old", "noise"],
    retainedSourceIds: ["current", "old", "noise"],
    topK: 3
  }), /invalid pre-MMR identities/u);
  assert.throws(() => assessCorrectionPairRetention({
    currentSourceId: "current",
    oldSourceId: "old",
    preMmrSourceIds: ["old"],
    retainedSourceIds: ["current"],
    topK: 1
  }), /invalid correction-pair retention evidence/u);
});

test("ordinary assessment requires unchanged exact top-1 and bounded cardinality", () => {
  assert.equal(assessOrdinaryTop1({
    expectedTop1: "ordinary",
    rawSourceIds: ["ordinary"],
    retainedSourceIds: ["ordinary"],
    topK: 3
  }).passed, true);
  assert.equal(assessOrdinaryTop1({
    expectedTop1: "ordinary",
    rawSourceIds: ["ordinary", "noise-a", "noise-b"],
    retainedSourceIds: ["noise-a", "ordinary", "noise-b"],
    topK: 3
  }).passed, false);
});
