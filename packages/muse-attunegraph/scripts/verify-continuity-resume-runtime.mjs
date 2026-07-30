import assert from "node:assert/strict";

import {
  CONTINUITY_RESUME_RUNTIME_LIMITS,
  createContinuityResumeRuntimeCaptureAdapter,
  createContinuityResumeRuntimeCoordinator,
  getContinuityResumeRuntimePack
} from "@muse/attunegraph/continuity-resume-runtime";

assert.deepEqual(CONTINUITY_RESUME_RUNTIME_LIMITS, {
  maxBaselines: 16,
  maxCaptureSpanMs: 1_000,
  maxInFlight: 4,
  operationTimeoutMs: 5_000
});
await assert.rejects(
  () => import("@muse/attunegraph"),
  (error) => error && error.code === "ERR_PACKAGE_PATH_NOT_EXPORTED",
  "the integration package must not expose a root entrypoint"
);
assert.equal(typeof createContinuityResumeRuntimeCaptureAdapter, "function");
assert.equal(typeof getContinuityResumeRuntimePack, "function");

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

const traps = { get: 0, ownKeys: 0 };
const hostile = new Proxy({}, {
  get() {
    traps.get += 1;
    throw new Error("Pack sidecar getter must not read properties");
  },
  ownKeys() {
    traps.ownKeys += 1;
    throw new Error("Pack sidecar getter must not enumerate");
  }
});
assert.equal(getContinuityResumeRuntimePack(hostile), undefined);
assert.deepEqual(traps, { get: 0, ownKeys: 0 });

console.log("continuity resume runtime built-output verification passed");
