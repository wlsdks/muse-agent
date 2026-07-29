import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { stdout } from "node:process";
import { URL } from "node:url";

import {
  compileThreadRootedWitnessDocuments
} from "../dist/thread-rooted-witness-documents.js";

const now = "2026-07-29T10:00:00.000Z";
const scope = { sourceId: "dogfood", threadId: "thread-1" };
const thread = { id: "thread-1", kind: "thread" };
const artifactA = { id: "artifact-a", kind: "artifact" };
const artifactB = { id: "artifact-b", kind: "artifact" };

function edge(id, subject, predicate, object) {
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

const first = edge("edge-a", artifactA, "LINKED_TO", thread);
const second = edge("edge-b", artifactA, "REVISION_OF", artifactB);

function fixture() {
  return JSON.parse(JSON.stringify({
    boundedResult: {
      assertions: [
        { assertion: second, memberships: [scope] },
        { assertion: first, memberships: [scope] }
      ],
      diagnostics: {
        consideredAssertions: 2,
        maxDepthReached: 2,
        visitedRefs: 3
      },
      refs: [artifactB, thread, artifactA],
      truncated: false
    },
    budget: {
      maxAssertions: 64,
      maxConsideredAssertions: 256,
      maxDepth: 12,
      maxEstimatedTokens: 32_768,
      maxOutputBytes: 1_000_000,
      maxVisitedRefs: 128
    },
    declaredFreshness: {
      assessedAt: now,
      observedAt: now,
      status: "fresh"
    },
    nominations: {
      core: {
        assertionId: "edge-a",
        kind: "core",
        nominationId: "core-context",
        observedAt: now
      },
      optionals: [{
        assertionId: "edge-b",
        kind: "change",
        nominationId: "changed-flight",
        observedAt: now
      }]
    },
    operatorVersion: "muse.thread-rooted-witness-documents.v1",
    query: {
      direction: "both",
      maxAssertions: 16,
      maxConsideredAssertions: 32,
      maxDepth: 4,
      maxVisitedRefs: 16,
      predicates: ["LINKED_TO", "REVISION_OF"],
      recordedAtOrBefore: now,
      seeds: [thread],
      validAt: now
    },
    schemaVersion: 1,
    scope,
    snapshot: {
      authority: "caller-declared-read-snapshot",
      commitHash: `sha256:${"a".repeat(64)}`,
      commitSequence: 7,
      generationId: "generation-7"
    }
  }));
}

function raw(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort(raw).map((key) =>
    `${JSON.stringify(key)}:${canonical(value[key])}`
  ).join(",")}}`;
}

function contentId(value, field, domain, prefix) {
  const body = JSON.parse(JSON.stringify(value));
  delete body[field];
  const digest = createHash("sha256")
    .update(domain, "utf8")
    .update("\0", "utf8")
    .update(canonical(body), "utf8")
    .digest("hex");
  return `${prefix}${digest}`;
}

function independentPath(assertions, targetId) {
  const adjacency = new Map();
  for (const assertion of assertions) {
    const steps = [
      {
        assertionId: assertion.id,
        direction: "outgoing",
        from: assertion.subject,
        to: assertion.object
      },
      {
        assertionId: assertion.id,
        direction: "incoming",
        from: assertion.object,
        to: assertion.subject
      }
    ];
    for (const step of steps) {
      const key = JSON.stringify([step.from.kind, step.from.id]);
      const values = adjacency.get(key) ?? [];
      values.push(step);
      adjacency.set(key, values);
    }
  }
  for (const values of adjacency.values()) {
    values.sort((left, right) =>
      raw(left.assertionId, right.assertionId)
      || raw(left.direction, right.direction)
    );
  }
  const queue = [{ ref: thread, path: [] }];
  const visited = new Set([JSON.stringify([thread.kind, thread.id])]);
  for (let index = 0; index < queue.length; index += 1) {
    const item = queue[index];
    const key = JSON.stringify([item.ref.kind, item.ref.id]);
    for (const step of adjacency.get(key) ?? []) {
      const path = [...item.path, {
        assertionId: step.assertionId,
        direction: step.direction
      }];
      if (step.assertionId === targetId) return path;
      const next = JSON.stringify([step.to.kind, step.to.id]);
      if (!visited.has(next)) {
        visited.add(next);
        queue.push({ ref: step.to, path });
      }
    }
  }
  return undefined;
}

const input = fixture();
const result = compileThreadRootedWitnessDocuments(input);
assert.equal(result.status, "partial");
assert.equal(result.receipt.coverage.canAssertAbsenceWithinSnapshot, false);
assert.equal(result.receipt.coverage.canAssertCurrentWorldAbsence, false);
assert.equal(result.settlement?.status, "partial");
assert.equal(result.frontier?.receipt.status, "partial");
assert.equal(result.frontier?.receipt.dispositions[0]?.lane, "change");
assert.equal(result.frontier?.receipt.dispositions[0]?.status, "budget-admitted");
assert.equal(
  result.receipt.frontierReceiptId,
  result.frontier?.receipt.receiptId
);
assert.equal(
  result.frontier?.receipt.receiptId,
  contentId(
    result.frontier.receipt,
    "receiptId",
    "muse.attunement-graph.fair-witness-frontier-receipt.v1",
    "muse-fair-witness-frontier-receipt:sha256:"
  )
);
assert.equal(
  result.frontier?.receipt.receiptId,
  "muse-fair-witness-frontier-receipt:sha256:f26c8048d60d70df36c8b82b646d565bb89b4827fc5d9b53ba226a6a495356f3"
);
const change = result.settlement.documents.find((document) =>
  document.kind === "change"
);
const expectedPath = independentPath([first, second], "edge-b");
assert.equal(canonical(change?.proof.paths[0]), canonical(expectedPath));
assert.equal(
  result.receipt.receiptId,
  contentId(
    result.receipt,
    "receiptId",
    "muse.attunement-graph.thread-rooted-witness-receipt.v1",
    "muse-thread-rooted-witness-receipt:sha256:"
  )
);
assert.equal(
  result.receipt.receiptId,
  "muse-thread-rooted-witness-receipt:sha256:15249e146c03b10827b5e7872f8862eb417302226701f78b497b4c0b77734e44"
);

const tieInput = fixture();
const quoteEdge = edge("\"", artifactA, "LINKED_TO", thread);
const hashEdge = edge("#", artifactB, "LINKED_TO", thread);
const tieTarget = edge("tie-target", artifactA, "REVISION_OF", artifactB);
tieInput.boundedResult.assertions = [hashEdge, tieTarget, quoteEdge].map(
  (assertion) => ({ assertion, memberships: [scope] })
);
tieInput.boundedResult.diagnostics.consideredAssertions = 3;
tieInput.nominations.core = {
  assertionId: "tie-target",
  kind: "core",
  nominationId: "core-context",
  observedAt: now
};
tieInput.nominations.optionals = [];
const tieResult = compileThreadRootedWitnessDocuments(
  JSON.parse(JSON.stringify(tieInput))
);
assert.equal(tieResult.settlement?.status, "partial");
assert.equal(
  canonical(tieResult.settlement.documents[0].proof.paths[0]),
  canonical([
    { assertionId: "\"", direction: "incoming" },
    { assertionId: "tie-target", direction: "outgoing" }
  ])
);

const missingCore = fixture();
missingCore.nominations.core.assertionId = "absent";
const abstained = compileThreadRootedWitnessDocuments(missingCore);
assert.equal(abstained.status, "abstained");
assert.equal(abstained.settlement, undefined);
assert.equal(
  abstained.receipt.dispositions.find((item) => item.role === "core")?.status,
  "excluded"
);
assert.equal(
  abstained.receipt.receiptId,
  "muse-thread-rooted-witness-receipt:sha256:d74ee1e1cfd225fa1a096d174701924ab5333c64ebc2e8f21cb82694d61ff580"
);

const packageJson = JSON.parse(await readFile(
  new URL("../package.json", import.meta.url),
  "utf8"
));
assert.equal(packageJson.exports["./thread-rooted-witness-documents"], undefined);
const publicIndex = await readFile(new URL("../dist/index.js", import.meta.url), "utf8");
assert.equal(publicIndex.includes("thread-rooted-witness-documents"), false);

stdout.write(`${JSON.stringify({
  abstainedReceiptId: abstained.receipt.receiptId,
  frontierReceiptId: result.frontier?.receipt.receiptId,
  partialReceiptId: result.receipt.receiptId,
  status: "ok",
  witnessDepth: expectedPath.length
})}\n`);
