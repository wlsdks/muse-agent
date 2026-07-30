import assert from "node:assert/strict";
import { test } from "node:test";

import { stagesCompoundingArtifact } from "./guard-writeback.mjs";

test("recognizes a TypeScript test file as a regression lock", () => {
  assert.equal(stagesCompoundingArtifact(["packages/x/src/a.test.ts"]), true);
  assert.equal(stagesCompoundingArtifact(["apps/web/src/b.test.tsx"]), true);
});

test("recognizes a scripts/*.test.mjs node:test (the fix — was wrongly blocked)", () => {
  assert.equal(stagesCompoundingArtifact(["scripts/build-status-dashboard.test.mjs"]), true);
  assert.equal(stagesCompoundingArtifact(["scripts/guard-writeback.test.mjs"]), true);
});

test("recognizes a verify-/eval- golden-case battery", () => {
  assert.equal(stagesCompoundingArtifact(["apps/cli/scripts/verify-faithfulness-rate.mjs"]), true);
  assert.equal(stagesCompoundingArtifact(["scripts/eval-harness.mjs"]), true);
});

test("recognizes the backlog ledger advancing", () => {
  assert.equal(stagesCompoundingArtifact(["internal/goals/backlog.md"]), true);
});

test("a feat with ONLY product source and no compounding artifact is NOT recognized", () => {
  assert.equal(stagesCompoundingArtifact(["packages/x/src/feature.ts", "package.json"]), false);
});

test("a plain .mjs script (not a .test.mjs) is not mistaken for a test", () => {
  assert.equal(stagesCompoundingArtifact(["scripts/build-status-dashboard.mjs"]), false);
});

test("empty stage list is not recognized (nothing to compound)", () => {
  assert.equal(stagesCompoundingArtifact([]), false);
});
