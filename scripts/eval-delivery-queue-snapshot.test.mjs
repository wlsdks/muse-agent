import assert from "node:assert/strict";
import test from "node:test";

import { buildDeliveryQueueEvidence } from "./eval-delivery-queue-snapshot.mjs";

const source = {
  head: "a".repeat(40),
  tree: "b".repeat(40),
  upstream: "a".repeat(40),
  worktree: "clean"
};

const snapshot = {
  followups: {
    overdue: { count: 1, oldestAgeMs: 1_000 },
    scheduled: { count: 2, oldestAgeMs: 2_000 },
    status: "ok"
  },
  generatedAt: "2026-07-29T00:00:00.000Z",
  pendingDrafts: { count: 0, oldestAgeMs: null, status: "ok" },
  reminders: {
    overdue: { count: 0, oldestAgeMs: null },
    scheduled: { count: 1, oldestAgeMs: 500 },
    status: "ok"
  },
  status: "observed"
};

test("builds privacy-safe current-source queue evidence with explicit zero effects", () => {
  const report = buildDeliveryQueueEvidence(snapshot, source);
  assert.equal(report.status, "observed");
  assert.equal(report.readOnly, true);
  assert.match(report.inputHash, /^[0-9a-f]{64}$/u);
  assert.deepEqual(report.effects, {
    artifactWrite: 1,
    delete: 0,
    providerCall: 0,
    queueMutation: 0,
    reschedule: 0,
    send: 0
  });
  assert.doesNotMatch(JSON.stringify(report), /recipient|destination|payload|PRIVATE/u);
});

test("binds the hash to every safe queue denominator and age", () => {
  const baseline = buildDeliveryQueueEvidence(snapshot, source);
  const changed = buildDeliveryQueueEvidence({
    ...snapshot,
    followups: {
      ...snapshot.followups,
      overdue: { count: 2, oldestAgeMs: 1_001 }
    }
  }, source);
  assert.notEqual(changed.inputHash, baseline.inputHash);
});
