import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyCorrectedFactStages,
  projectScoredStage,
  task049CorpusHash
} from "./lib/task-049-corrected-fact-probe.mjs";

const oldId = "old-fact";
const currentId = "current-fact";
const old = { opaqueId: "chunk_old", sourceId: oldId };
const current = { opaqueId: "chunk_current", sourceId: currentId };
const distractor = { opaqueId: "chunk_distractor", sourceId: "distractor" };

test("classifier attributes a missing old/current pair to candidate collection", () => {
  assert.equal(classifyCorrectedFactStages({
    currentSourceId: currentId,
    oldSourceId: oldId,
    stages: {
      candidate: [old, distractor],
      policy: [old, distractor],
      rank: [old, distractor]
    },
    verdict: "ambiguous"
  }), "candidate_pair_missing");
});

test("classifier attributes a retained pair with stale top-1 to ranking", () => {
  assert.equal(classifyCorrectedFactStages({
    currentSourceId: currentId,
    oldSourceId: oldId,
    stages: {
      candidate: [old, current, distractor],
      policy: [current, old, distractor],
      rank: [old, current, distractor]
    },
    verdict: "ambiguous"
  }), "rank_current_not_top1");
});

test("classifier attributes a current top-ranked pair displaced after preparation to policy", () => {
  assert.equal(classifyCorrectedFactStages({
    currentSourceId: currentId,
    oldSourceId: oldId,
    stages: {
      candidate: [current, old, distractor],
      policy: [old, current, distractor],
      rank: [current, old, distractor]
    },
    verdict: "confident"
  }), "policy_current_not_top1");
});

test("classifier passes when the current correction remains top-1 through policy", () => {
  assert.equal(classifyCorrectedFactStages({
    currentSourceId: currentId,
    oldSourceId: oldId,
    stages: {
      candidate: [current, old, distractor],
      policy: [current, old, distractor],
      rank: [current, old, distractor]
    },
    verdict: "confident"
  }), "pass");
});

test("classifier fails closed for malformed evidence and duplicate identities", () => {
  assert.throws(
    () => classifyCorrectedFactStages(null),
    /invalid corrected-fact stage evidence/
  );
  assert.throws(
    () => classifyCorrectedFactStages({
      currentSourceId: currentId,
      oldSourceId: oldId,
      stages: {
        candidate: [current, current, old],
        policy: [current, old],
        rank: [current, old]
      },
      verdict: "confident"
    }),
    /duplicate corrected-fact stage identity/
  );
  assert.throws(
    () => classifyCorrectedFactStages({
      currentSourceId: currentId,
      oldSourceId: oldId,
      stages: {
        candidate: [current, old],
        policy: [current, old],
        rank: [
          current,
          { opaqueId: current.opaqueId, sourceId: old.sourceId }
        ]
      },
      verdict: "confident"
    }),
    /duplicate corrected-fact stage identity/
  );
});

test("fixed corpus and scored-stage projection are deterministic and content-blind", () => {
  assert.equal(
    task049CorpusHash(),
    "4961d4a80b0d79236d1dc8551ab7ea80614655625f47f66a69180526a604f7f5"
  );
  const projected = projectScoredStage([
    { chunk: { chunkIndex: 0, text: "must not leak" }, file: "/tmp/current.md", score: 1 }
  ], (file) => file === "/tmp/current.md" ? currentId : null);
  assert.deepEqual(projected, [{
    opaqueId: "f64117abfad7d4b879479a0f20575c996111f40ce2cbbd388d246136d29158b0",
    sourceId: currentId
  }]);
  assert.deepEqual(Object.keys(projected[0]), ["opaqueId", "sourceId"]);
});
