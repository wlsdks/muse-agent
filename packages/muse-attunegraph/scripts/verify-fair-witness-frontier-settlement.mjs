import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import {
  deriveFairWitnessLaneV1
} from "../dist/fair-witness-frontier-settlement.js";
import {
  compileThreadRootedWitnessDocuments
} from "../dist/thread-rooted-witness-documents.js";

const now = "2026-07-29T10:00:00.000Z";
const earlier = "2026-07-29T09:59:00.000Z";
const scope = { sourceId: "dogfood", threadId: "thread-1" };
const thread = { id: scope.threadId, kind: "thread" };
const hub = { id: "hub", kind: "artifact" };
const snapshot = {
  authority: "caller-declared-read-snapshot",
  commitHash: `sha256:${"a".repeat(64)}`,
  commitSequence: 7,
  generationId: "generation-7"
};

function assertion(id, subject, predicate, object) {
  return {
    derivation: { kind: "projection", version: "verifier-v1" },
    epistemicClass: "source-observed",
    id,
    object,
    predicate,
    recordedAt: "2026-07-29T09:00:00.000Z",
    schemaVersion: 1,
    sourceRefs: [{ id: `source-${id}`, namespace: "dogfood" }],
    subject
  };
}

const core = assertion("core-edge", hub, "LINKED_TO", thread);
const optionals = Array.from({ length: 255 }, (_, index) => {
  const first = index === 0;
  return {
    assertion: assertion(
      `optional-${index.toString().padStart(3, "0")}`,
      first ? hub : thread,
      "PRECEDED",
      { id: `artifact-${index.toString().padStart(3, "0")}`, kind: "artifact" }
    ),
    nominationId: `nomination-${index.toString().padStart(3, "0")}`,
    observedAt: first ? now : earlier
  };
});
const assertions = [core, ...optionals.map((item) => item.assertion)];
const refs = new Map();
for (const item of assertions) {
  for (const ref of [item.subject, item.object]) {
    refs.set(JSON.stringify([ref.kind, ref.id]), ref);
  }
}

const input = {
  boundedResult: {
    assertions: assertions.map((item) => ({
      assertion: item,
      memberships: [scope]
    })),
    diagnostics: {
      consideredAssertions: assertions.length,
      maxDepthReached: 2,
      visitedRefs: refs.size
    },
    refs: [...refs.values()],
    truncated: false
  },
  budget: {
    maxAssertions: 2,
    maxConsideredAssertions: 1024,
    maxDepth: 12,
    maxEstimatedTokens: 1_000_000,
    maxOutputBytes: 4_000_000,
    maxVisitedRefs: 1024
  },
  declaredFreshness: {
    assessedAt: now,
    observedAt: now,
    status: "fresh"
  },
  nominations: {
    core: {
      assertionId: core.id,
      kind: "core",
      nominationId: "core-context",
      observedAt: now
    },
    optionals: optionals.map((item) => ({
      assertionId: item.assertion.id,
      kind: "support",
      nominationId: item.nominationId,
      observedAt: item.observedAt
    }))
  },
  operatorVersion: "muse.thread-rooted-witness-documents.v1",
  query: {
    direction: "both",
    maxAssertions: 256,
    maxConsideredAssertions: 512,
    maxDepth: 4,
    maxVisitedRefs: 512,
    predicates: ["LINKED_TO", "PRECEDED"],
    recordedAtOrBefore: now,
    seeds: [thread],
    validAt: now
  },
  schemaVersion: 1,
  scope,
  snapshot
};

const startedAt = performance.now();
const result = compileThreadRootedWitnessDocuments(
  JSON.parse(JSON.stringify(input))
);
const elapsedMilliseconds = performance.now() - startedAt;
assert.equal(result.status, "partial");
assert.equal(result.frontier?.receipt.metrics.witnessedOptional, 255);
assert.equal(result.frontier?.receipt.metrics.ordered, 255);
assert.equal(result.frontier?.receipt.metrics.attemptedCandidates, 255);
assert.equal(result.frontier?.receipt.metrics.settlementInvocations, 256);
assert.equal(result.frontier?.order.entries.length, 255);
assert.equal(
  result.frontier?.receipt.dispositions.find((item) =>
    item.nominationId === "nomination-000"
  )?.status,
  "capacity-excluded"
);
assert.equal(
  result.frontier?.receipt.dispositions.some((item) =>
    item.status === "budget-admitted" && item.rank > 0
  ),
  true
);
assert.equal(
  result.frontier?.receipt.dispositions.filter((item) =>
    item.status === "budget-admitted"
  ).length,
  1
);
assert.equal(
  result.frontier?.receipt.dispositions.filter((item) =>
    item.status === "capacity-excluded"
  ).length,
  254
);
assert.equal(result.settlement?.status, "partial");
if (result.settlement?.status !== "partial") {
  throw new Error("expected partial settlement");
}
assert.equal(result.settlement.documents.length, 2);

const predicates = {
  LINKED_TO: undefined,
  NEXT_STEP_FOR: "continuity",
  CONTEXT_FOR: "continuity",
  SUPPORTED_BY: "evidence",
  DERIVED_FROM: "evidence",
  REVISION_OF: "change",
  SUPERSEDES: "change",
  OBSERVED_DURING: "evidence",
  DELIVERED_FOR: "continuity",
  PRODUCED_OUTCOME: "evidence",
  PROPOSES_POLICY: "policy",
  SCOPED_TO: "policy",
  GOVERNED_BY: "policy",
  PRECEDED: "continuity",
  CORRELATES_WITH: "evidence",
  AUTHORIZED_BY: "authority",
  PERFORMED: "authority"
};
for (const [predicate, expected] of Object.entries(predicates)) {
  assert.equal(deriveFairWitnessLaneV1(predicate), expected);
}

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical(value[key])}`
  ).join(",")}}`;
}

const receiptBody = JSON.parse(JSON.stringify(result.frontier.receipt));
delete receiptBody.receiptId;
const digest = createHash("sha256")
  .update("muse.attunegraph.fair-witness-frontier-receipt.v1", "utf8")
  .update("\0", "utf8")
  .update(canonical(receiptBody), "utf8")
  .digest("hex");
assert.equal(
  result.frontier.receipt.receiptId,
  `muse-attunegraph-fair-witness-frontier-receipt:sha256:${digest}`
);
assert.equal(
  result.frontier.receipt.receiptId,
  "muse-attunegraph-fair-witness-frontier-receipt:sha256:aac7933d6f517f3a4d1df7f22386c04bfd756348e368c04d8548b86e7776c62b"
);
assert.equal(result.receipt.frontierReceiptId, result.frontier.receipt.receiptId);
assert.equal(result.receipt.settlementResultId, result.settlement.resultId);

process.stdout.write(JSON.stringify({
  admittedAfterOversizedFirst: true,
  elapsedMilliseconds: Math.round(elapsedMilliseconds * 100) / 100,
  optionals: 255,
  receiptId: result.frontier.receipt.receiptId,
  settlementInvocations: result.frontier.receipt.metrics.settlementInvocations,
  status: "PASS"
}) + "\n");
