/* global Buffer, console */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  ScopedProofDocumentSettlementError,
  compileScopedProofDocumentSettlement
} from "../dist/scoped-proof-document-settlement.js";

const REQUEST = Object.freeze({
  domain: "muse.attunement-graph.scoped-proof-document-settlement-request.v1",
  field: "requestId",
  prefix: "muse-scoped-proof-request:sha256:"
});
const DOCUMENT = Object.freeze({
  domain: "muse.attunement-graph.scoped-proof-document.v1",
  field: "documentId",
  prefix: "muse-scoped-proof-document:sha256:"
});
const INVENTORY = Object.freeze({
  domain: "muse.attunement-graph.candidate-inventory.v1",
  field: "inventoryId",
  prefix: "muse-candidate-inventory:sha256:"
});
const LEDGER = Object.freeze({
  domain: "muse.attunement-graph.candidate-settlement-ledger.v1",
  field: "ledgerId",
  prefix: "muse-candidate-ledger:sha256:"
});

const instant = "2026-07-29T00:00:00.000Z";
const scope = Object.freeze({ sourceId: "storefront", threadId: "계속-의도" });
const snapshot = Object.freeze({
  authority: "caller-declared-read-snapshot",
  commitHash: `sha256:${"a".repeat(64)}`,
  commitSequence: 7,
  generationId: "generation-7"
});
const freshness = Object.freeze({
  assessedAt: instant,
  observedAt: instant,
  status: "fresh"
});
const budget = Object.freeze({
  maxAssertions: 1_000_000,
  maxConsideredAssertions: 1_000_000,
  maxDepth: 1_000_000,
  maxEstimatedTokens: 1_000_000,
  maxOutputBytes: 1_000_000,
  maxVisitedRefs: 1_000_000
});

function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

function rawCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort(rawCompare).map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  ).join(",")}}`;
}

function literalEnvelope(value, spec) {
  const unsigned = copy(value);
  delete unsigned[spec.field];
  const unsignedJson = canonicalJson(unsigned);
  const digest = createHash("sha256")
    .update(spec.domain, "utf8")
    .update("\0", "utf8")
    .update(unsignedJson, "utf8")
    .digest("hex");
  const contentId = `${spec.prefix}${digest}`;
  const envelope = { ...unsigned, [spec.field]: contentId };
  const fullJson = canonicalJson(envelope);
  return Object.freeze({
    bytes: Buffer.byteLength(fullJson, "utf8"),
    contentId,
    envelope,
    fullJson,
    unsignedJson
  });
}

function evidenceKey(value) {
  return JSON.stringify([value.namespace, value.id, value.version ?? null]);
}

function assertion(id, sourceRefs, subjectId) {
  return {
    derivation: { kind: "projection", version: "v1" },
    epistemicClass: "source-observed",
    id,
    object: { id: "계속-의도", kind: "thread" },
    predicate: "LINKED_TO",
    recordedAt: instant,
    schemaVersion: 1,
    sourceRefs: copy(sourceRefs),
    subject: { id: subjectId, kind: "artifact" }
  };
}

function document(kind, index, sourceRefs) {
  const item = assertion(
    `assertion-${index.toString()}`,
    sourceRefs,
    `artifact-${index.toString()}`
  );
  return {
    authority: {
      action: "no-authority-granted",
      freshness: "caller-declared-not-verified",
      nomination: "caller-declared-non-exhaustive"
    },
    declaredFreshness: copy(freshness),
    documentVersion: "muse.scoped-proof-document.v1",
    kind,
    observedAt: instant,
    proof: {
      assertions: [{ assertion: item, memberships: [copy(scope)] }],
      paths: [[{ assertionId: item.id, direction: "outgoing" }]],
      sourceRefs: [...copy(sourceRefs)].sort((left, right) =>
        rawCompare(evidenceKey(left), evidenceKey(right))
      )
    },
    schemaVersion: 1,
    scope: copy(scope),
    semanticPriority: kind === "core" ? 0 : kind === "change" ? 1 : 2,
    snapshot: copy(snapshot)
  };
}

function candidate(documentValue) {
  return { document: documentValue, localStatus: { status: "eligible" } };
}

function makeRequest(optionals) {
  const localeFirst = { id: "a", namespace: "ä" };
  const rawFirst = { id: "a", namespace: "z" };
  assert(rawCompare(evidenceKey(rawFirst), evidenceKey(localeFirst)) < 0);
  assert(localeFirst.namespace.localeCompare(rawFirst.namespace) < 0);
  const value = {
    budget: copy(budget),
    core: candidate(document("core", 0, [localeFirst, rawFirst])),
    declaredFreshness: copy(freshness),
    operatorVersion: "muse.scoped-proof-document-settlement.v1",
    optionals,
    schemaVersion: 1,
    scope: copy(scope),
    snapshot: copy(snapshot)
  };
  const captured = literalEnvelope(value, REQUEST);
  return { ...value, requestId: captured.contentId };
}

function cost(documentEnvelope) {
  const outputBytes = 1 + documentEnvelope.bytes;
  return {
    assertions: 1,
    consideredAssertions: 1,
    depth: 1,
    estimatedTokens: Math.ceil(outputBytes / 4),
    outputBytes,
    visitedRefs: 2
  };
}

function deeplyFrozen(value) {
  if (value === null || typeof value !== "object") return true;
  if (!Object.isFrozen(value)) return false;
  if (Object.getPrototypeOf(value) !== (Array.isArray(value) ? Array.prototype : null)) {
    return false;
  }
  return Reflect.ownKeys(value).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return typeof key === "string"
      && descriptor !== undefined
      && "value" in descriptor
      && descriptor.writable === false
      && descriptor.configurable === false
      && (key === "length" || deeplyFrozen(descriptor.value));
  });
}

const change = candidate(document(
  "change",
  1,
  [{ id: "source-b", namespace: "notes" }]
));
const support = candidate(document(
  "support",
  2,
  [{ id: "source-c", namespace: "notes" }]
));
const input = makeRequest([support, change]);
const coreDocument = literalEnvelope(input.core.document, DOCUMENT);
const changeDocument = literalEnvelope(change.document, DOCUMENT);
const supportDocument = literalEnvelope(support.document, DOCUMENT);
const retained = [coreDocument, changeDocument, supportDocument];
const coreId = `core:${coreDocument.contentId.slice(-64)}`;
const changeId = `optional:${changeDocument.contentId.slice(-64)}`;
const supportId = `optional:${supportDocument.contentId.slice(-64)}`;
const optionalRanks = new Map([[changeId, 0], [supportId, 1]]);
const optionalInventory = [
  [changeId, changeDocument],
  [supportId, supportDocument]
].sort(([left], [right]) => rawCompare(left, right));
const inventoryBody = {
  budget: copy(budget),
  core: {
    candidateId: coreId,
    cost: cost(coreDocument),
    preflight: { status: "eligible" },
    rank: 0,
    role: "core"
  },
  optionals: optionalInventory.map(([candidateId, envelope]) => ({
    candidateId,
    cost: cost(envelope),
    preflight: { status: "eligible" },
    rank: optionalRanks.get(candidateId),
    role: "optional"
  })),
  schemaVersion: 1
};
const inventoryEnvelope = literalEnvelope(inventoryBody, INVENTORY);
const optionalEntries = [changeId, supportId]
  .sort(rawCompare)
  .map((candidateId) => ({
    candidateId,
    role: "optional",
    terminalState: "admitted"
  }));
const payloadBytes = retained.reduce((total, item) => total + 1 + item.bytes, 0);
const payloadTokens = retained.reduce(
  (total, item) => total + Math.ceil((1 + item.bytes) / 4),
  0
);
const ledgerBody = {
  counters: {
    admitted: 3,
    candidateCount: 3,
    consideredAssertions: 3,
    failed: 0,
    maxDepth: 1,
    rejected: 0,
    selectedAssertions: 3,
    selectedPayloadBytes: payloadBytes,
    selectedPayloadEstimatedTokens: payloadTokens,
    skipped: 0,
    visitedRefs: 6
  },
  entries: [
    { candidateId: coreId, role: "core", terminalState: "admitted" },
    ...optionalEntries
  ],
  inventoryId: inventoryEnvelope.contentId,
  mode: "normal",
  schemaVersion: 1
};
const ledgerEnvelope = literalEnvelope(ledgerBody, LEDGER);
const documentsByCandidate = new Map([
  [coreId, coreDocument],
  [changeId, changeDocument],
  [supportId, supportDocument]
]);
const admittedLiterals = ledgerBody.entries.map((entry) => {
  const value = documentsByCandidate.get(entry.candidateId);
  assert(value);
  return value.fullJson;
});
const expectedContext = [ledgerEnvelope.fullJson, ...admittedLiterals].join("\n");

const actual = compileScopedProofDocumentSettlement(input);
assert.equal(actual.status, "partial");
assert.equal(actual.resultId, ledgerEnvelope.contentId);
assert.equal(actual.settlement.ledger.inventoryId, inventoryEnvelope.contentId);
assert.equal(actual.settlement.canonicalJson, ledgerEnvelope.fullJson);
assert.equal(actual.settlement.canonicalByteLength, ledgerEnvelope.bytes);
assert.equal(actual.settlement.totalOutputBytes, ledgerEnvelope.bytes + payloadBytes);
assert.equal(
  actual.settlement.estimatedTokens,
  Math.ceil(ledgerEnvelope.bytes / 4) + payloadTokens
);
assert.deepEqual(copy(actual.settlement.ledger), {
  ...ledgerBody,
  ledgerId: ledgerEnvelope.contentId
});
assert.equal(actual.contextStream, expectedContext);
assert.equal(Buffer.byteLength(actual.contextStream, "utf8"), actual.settlement.totalOutputBytes);
assert.equal(actual.contextStream.startsWith("\uFEFF"), false);
assert.equal(actual.contextStream.endsWith("\n"), false);
assert.deepEqual(
  actual.documents.map((item) => item.documentId),
  ledgerBody.entries.map((entry) => documentsByCandidate.get(entry.candidateId).contentId)
);
assert(actual.documents.every((item) =>
  item.authority.nomination === "caller-declared-non-exhaustive"
  && item.authority.freshness === "caller-declared-not-verified"
  && item.authority.action === "no-authority-granted"
));
assert.equal(actual.completeness.canAssertAbsenceWithinSnapshot, false);
assert.equal(actual.completeness.canAssertCurrentWorldAbsence, false);
assert(deeplyFrozen(actual));

const reversed = compileScopedProofDocumentSettlement(
  makeRequest([copy(change), copy(support)])
);
assert.equal(reversed.status, "partial");
assert.equal(reversed.resultId, actual.resultId);
assert.equal(reversed.settlement.canonicalJson, actual.settlement.canonicalJson);
assert.equal(reversed.contextStream, actual.contextStream);

const unavailable = copy(input);
unavailable.declaredFreshness = {
  reasonId: "caller-unavailable",
  status: "unavailable"
};
unavailable.core.document.declaredFreshness = copy(unavailable.declaredFreshness);
for (const item of unavailable.optionals) {
  item.document.declaredFreshness = copy(unavailable.declaredFreshness);
}
delete unavailable.requestId;
const abstained = compileScopedProofDocumentSettlement(unavailable);
assert.equal(abstained.status, "abstained");
assert.deepEqual(abstained.completeness.reasons, [
  "freshness-unavailable",
  "mandatory-proof-not-admitted",
  "settlement-abstained"
]);
assert.equal(abstained.contextStream, abstained.settlement.canonicalJson);
assert.equal("documents" in abstained, false);
assert.equal(abstained.completeness.canAssertAbsenceWithinSnapshot, false);
assert.equal(abstained.completeness.canAssertCurrentWorldAbsence, false);

const tampered = copy(input);
tampered.core.document.documentId = `${DOCUMENT.prefix}${"0".repeat(64)}`;
delete tampered.requestId;
assert.throws(
  () => compileScopedProofDocumentSettlement(tampered),
  (error) => {
    assert(error instanceof ScopedProofDocumentSettlementError);
    assert.equal(error.code, "INVALID_REQUEST");
    assert.equal(error.message, "scoped-proof-document-settlement-failed");
    assert.equal(error.stack, undefined);
    assert.equal("cause" in error, false);
    assert.deepEqual(copy(error.details), {
      path: "/core/document/documentId",
      reason: "invalid-document-id"
    });
    return true;
  }
);

console.log("scoped proof document settlement independent golden and fault probes passed");
