import assert from "node:assert/strict";
import { test } from "node:test";

import { gradeMultifileFix } from "./lib/grade-multifile-fix.mjs";

test("passes a fixed, collateral-free outcome", () => {
  const { ok } = gradeMultifileFix({ addIntact: true, ranTest: true, stringsIntact: true, testPasses: true });
  assert.equal(ok, true);
});

test("passes a correct fix even when the model never self-ran the test (OUTCOME, not path)", () => {
  // The fire-9 residual: testPasses is verified by the harness, so ranTest=false
  // must NOT fail a correct, collateral-free fix.
  const result = gradeMultifileFix({ addIntact: true, ranTest: false, stringsIntact: true, testPasses: true });
  assert.equal(result.ok, true);
  assert.equal(result.ranTest, false); // still reported for observability
});

test("fails when the test does not pass", () => {
  assert.equal(gradeMultifileFix({ addIntact: true, ranTest: true, stringsIntact: true, testPasses: false }).ok, false);
});

test("fails on collateral damage to the add function", () => {
  assert.equal(gradeMultifileFix({ addIntact: false, ranTest: true, stringsIntact: true, testPasses: true }).ok, false);
});

test("fails on collateral damage to the noise file", () => {
  assert.equal(gradeMultifileFix({ addIntact: true, ranTest: true, stringsIntact: false, testPasses: true }).ok, false);
});

test("ranTest is observational only — true testPasses+intact always gates ok regardless of ranTest", () => {
  for (const ranTest of [true, false]) {
    assert.equal(gradeMultifileFix({ addIntact: true, ranTest, stringsIntact: true, testPasses: true }).ok, true);
  }
});
