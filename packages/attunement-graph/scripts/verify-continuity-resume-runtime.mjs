import assert from "node:assert/strict";

import {
  CONTINUITY_RESUME_RUNTIME_LIMITS,
  createContinuityResumeRuntimeCoordinator
} from "@muse/attunement-graph/continuity-resume-runtime";
import * as root from "../dist/index.js";

assert.deepEqual(CONTINUITY_RESUME_RUNTIME_LIMITS, {
  maxBaselines: 16,
  maxCaptureSpanMs: 1_000,
  maxInFlight: 4,
  operationTimeoutMs: 5_000
});
assert.equal(
  Object.hasOwn(root, "createContinuityResumeRuntimeCoordinator"),
  false,
  "runtime coordinator must stay out of the package root"
);

let dependencyCalls = 0;
const coordinator = createContinuityResumeRuntimeCoordinator({
  captureCurrent: async () => {
    dependencyCalls += 1;
    throw new Error("invalid scope must not call the dependency");
  }
});
const invalid = await coordinator.preview({
  sourceId: "../invalid",
  threadId: ""
});
assert.equal(invalid.status, "unavailable");
assert.equal(invalid.reason, "invalid-scope");
assert.equal(dependencyCalls, 0);
assert.equal(Object.isFrozen(invalid), true);
assert.deepEqual(invalid.authority, {
  canAssertCurrentWorldTruth: false,
  canAssertSourceCompleteness: false,
  canGrantActionAuthority: false
});

console.log("continuity resume runtime built-output verification passed");
