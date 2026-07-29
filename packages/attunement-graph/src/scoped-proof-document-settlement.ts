import { Buffer } from "node:buffer";

import {
  CanonicalImmutableEnvelopeError,
  canonicalizeImmutableEnvelope
} from "./canonical-immutable-envelope.js";
import {
  type BoundedSettlementResult,
  type CandidateSettlementResult,
  settleCandidateInventory
} from "./candidate-settlement-ledger.js";
import { AttunementGraphError } from "./error.js";
import type { GraphAssertion, GraphEvidenceRef, GraphRef } from "./types.js";
import {
  evidenceRefKey,
  graphRefKey,
  instantEpoch,
  normalizeGraphAssertion
} from "./validation.js";
import {
  GraphSnapshotProvenanceError,
  assertGraphSnapshotFreshnessPair,
  parseGraphDeclaredFreshness,
  parseGraphSnapshotProvenance,
  type GraphDeclaredFreshnessV1,
  type GraphSnapshotProvenanceV1
} from "./graph-snapshot-provenance.js";

const REQUEST_SPEC = Object.freeze({
  hashDomain: "muse.attunement-graph.scoped-proof-document-settlement-request.v1",
  idField: "requestId",
  idPrefix: "muse-scoped-proof-request:sha256:"
} as const);
const DOCUMENT_SPEC = Object.freeze({
  hashDomain: "muse.attunement-graph.scoped-proof-document.v1",
  idField: "documentId",
  idPrefix: "muse-scoped-proof-document:sha256:"
} as const);

const CONTROL = /[\u0000-\u001F\u007F]/u;
const REQUEST_ID = /^muse-scoped-proof-request:sha256:[0-9a-f]{64}$/u;
const DOCUMENT_ID = /^muse-scoped-proof-document:sha256:[0-9a-f]{64}$/u;
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const RAW = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const MAX_PROOF_ASSERTIONS = 64;
const MAX_ASSERTION_SOURCE_REFS = 128;
const MAX_PROOF_SOURCE_REFS = MAX_PROOF_ASSERTIONS * MAX_ASSERTION_SOURCE_REFS;

export type ScopedProofDocumentSettlementErrorCode =
  | "INVALID_REQUEST"
  | "INTERNAL_POSTCONDITION_FAILED";
export type ScopedProofDocumentSettlementErrorReason =
  | "invalid-field-set"
  | "invalid-container"
  | "invalid-schema-version"
  | "invalid-operator-version"
  | "invalid-string"
  | "invalid-number"
  | "invalid-instant"
  | "invalid-enum"
  | "invalid-order"
  | "duplicate-membership"
  | "scope-mismatch"
  | "snapshot-mismatch"
  | "freshness-mismatch"
  | "invalid-document-kind"
  | "invalid-priority"
  | "invalid-document-id"
  | "invalid-assertion"
  | "invalid-local-status"
  | "duplicate-document-id"
  | "too-many-optionals"
  | "invalid-envelope-contract"
  | "envelope-postcondition-failed"
  | "settlement-postcondition-failed"
  | "materialization-postcondition-failed"
  | "invalid-request-id"
  | "invalid-request-envelope"
  | "request-envelope-budget-exceeded"
  | "invalid-document-envelope"
  | "document-envelope-budget-exceeded";

export class ScopedProofDocumentSettlementError extends Error {
  readonly code: ScopedProofDocumentSettlementErrorCode;
  readonly details: Readonly<{ readonly path: string; readonly reason: ScopedProofDocumentSettlementErrorReason }>;

  constructor(
    code: ScopedProofDocumentSettlementErrorCode,
    reason: ScopedProofDocumentSettlementErrorReason,
    path: string
  ) {
    super("scoped-proof-document-settlement-failed");
    this.name = "ScopedProofDocumentSettlementError";
    this.code = code;
    this.details = freezeRecord({ path, reason });
    delete (this as { stack?: unknown }).stack;
    for (const key of ["message", "name", "code", "details"] as const) {
      const value = this[key];
      Object.defineProperty(this, key, {
        configurable: false,
        enumerable: key === "code" || key === "details",
        value,
        writable: false
      });
    }
  }
}

type Scope = Readonly<{ readonly sourceId: string; readonly threadId: string }>;
type Snapshot = GraphSnapshotProvenanceV1;
type Freshness = GraphDeclaredFreshnessV1;
type LocalReason = "proof-path-disconnected" | "proof-source-unclosed" | "proof-duplicate-assertion" | "proof-duplicate-path";
type LocalStatus = Readonly<{ readonly status: "eligible" }> | Readonly<{ readonly status: "rejected"; readonly reasonId: LocalReason }>;
type Direction = "outgoing" | "incoming";
type Step = Readonly<{ readonly assertionId: string; readonly direction: Direction }>;
type ScopedAssertion = Readonly<{ readonly assertion: GraphAssertion; readonly memberships: readonly Scope[] }>;
type Proof = Readonly<{ readonly assertions: readonly ScopedAssertion[]; readonly paths: readonly (readonly Step[])[]; readonly sourceRefs: readonly GraphEvidenceRef[] }>;
type Authority = Readonly<{ readonly nomination: "caller-declared-non-exhaustive"; readonly freshness: "caller-declared-not-verified" | "provider-capture-freshness-unassessed"; readonly action: "no-authority-granted" }>;
type Document = Readonly<{ readonly schemaVersion: 1; readonly documentVersion: "muse.scoped-proof-document.v1"; readonly documentId: string; readonly kind: "core" | "change" | "support"; readonly scope: Scope; readonly snapshot: Snapshot; readonly declaredFreshness: Freshness; readonly observedAt: string; readonly semanticPriority: 0 | 1 | 2; readonly proof: Proof; readonly authority: Authority }>;
type Candidate = Readonly<{ readonly document: Document; readonly localStatus: LocalStatus; readonly retainedCanonicalJson: string; readonly retainedCanonicalByteLength: number; readonly candidateId: string; readonly forcedFreshness: boolean }>;
type Budget = Readonly<{ readonly maxDepth: number; readonly maxConsideredAssertions: number; readonly maxVisitedRefs: number; readonly maxAssertions: number; readonly maxEstimatedTokens: number; readonly maxOutputBytes: number }>;

type CompletenessPartial = Readonly<{ readonly status: "partial"; readonly canAssertAbsenceWithinSnapshot: false; readonly canAssertCurrentWorldAbsence: false; readonly reasons: readonly ("nomination-not-exhaustive" | "freshness-not-authoritative" | "candidate-not-admitted")[] }>;
type CompletenessAbstained = Readonly<{ readonly status: "abstained"; readonly canAssertAbsenceWithinSnapshot: false; readonly canAssertCurrentWorldAbsence: false; readonly reasons: readonly ("freshness-unavailable" | "freshness-unassessed" | "mandatory-proof-not-admitted" | "settlement-abstained")[] }>;
export type ScopedProofDocumentSettlementResultV1 =
  | Readonly<{ readonly status: "partial"; readonly resultId: string; readonly scope: Scope; readonly snapshot: Snapshot; readonly declaredFreshness: Freshness; readonly completeness: CompletenessPartial; readonly settlement: BoundedSettlementResult; readonly documents: readonly Document[]; readonly contextStream: string }>
  | Readonly<{ readonly status: "abstained"; readonly resultId: string; readonly scope: Scope; readonly snapshot: Snapshot; readonly declaredFreshness: Freshness; readonly completeness: CompletenessAbstained; readonly settlement: BoundedSettlementResult; readonly contextStream: string }>
  | Readonly<{ readonly status: "invalid-input"; readonly resultId: string; readonly capacity: Extract<CandidateSettlementResult, { status: "invalid-input" }> }>;

function freezeRecord<T extends Record<string, unknown>>(value: T): Readonly<T> {
  return Object.freeze(Object.assign(Object.create(null) as Record<string, unknown>, value)) as Readonly<T>;
}
function freezeArray<T>(value: readonly T[]): readonly T[] { return Object.freeze([...value]); }
function escapePointer(segment: string): string { return segment.replaceAll("~", "~0").replaceAll("/", "~1"); }
function child(path: string, segment: string): string { return `${path}/${escapePointer(segment)}`; }
function error(code: ScopedProofDocumentSettlementErrorCode, reason: ScopedProofDocumentSettlementErrorReason, path: string): never { throw new ScopedProofDocumentSettlementError(code, reason, path); }
function invalid(reason: ScopedProofDocumentSettlementErrorReason, path: string): never { return error("INVALID_REQUEST", reason, path); }
function internal(reason: ScopedProofDocumentSettlementErrorReason, path = ""): never { return error("INTERNAL_POSTCONDITION_FAILED", reason, path); }
function record(value: unknown, fields: readonly string[], optional: readonly string[], path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid("invalid-container", path);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) invalid("invalid-field-set", path);
  const stringKeys = keys as string[];
  if (stringKeys.some((key) => !fields.includes(key) && !optional.includes(key)) || fields.some((key) => !Object.hasOwn(value, key))) invalid("invalid-field-set", path);
  return value as Record<string, unknown>;
}
function array(value: unknown, max: number, path: string): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) invalid("invalid-container", path);
  if (value.length > max || Reflect.ownKeys(value).some((key) => typeof key !== "string" || (key !== "length" && !/^(?:0|[1-9][0-9]*)$/u.test(key)))) invalid("invalid-container", path);
  for (let index = 0; index < value.length; index += 1) if (!Object.hasOwn(value, index)) invalid("invalid-container", path);
  return value;
}
function text(value: unknown, path: string, max = 512): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() || Array.from(value).length > max || CONTROL.test(value)) invalid("invalid-string", path);
  return value;
}
function instant(value: unknown, path: string): string {
  if (typeof value !== "string") invalid("invalid-instant", path);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) invalid("invalid-instant", path);
  return value;
}
function number(value: unknown, path: string): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalid("invalid-number", path); return value; }
function equal(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function sorted(values: readonly string[], path: string, strict: boolean): void { for (let index = 1; index < values.length; index += 1) if (RAW(values[index - 1]!, values[index]!) > 0 || (strict && values[index - 1] === values[index])) invalid("invalid-order", `${path}/${index}`); }

function scope(value: unknown, path: string): Scope {
  const root = record(value, ["sourceId", "threadId"], [], path);
  const sourceId = root.sourceId;
  if (typeof sourceId !== "string" || !SOURCE_ID.test(sourceId)) invalid("invalid-string", child(path, "sourceId"));
  return freezeRecord({ sourceId, threadId: text(root.threadId, child(path, "threadId"), 256) });
}
function snapshot(value: unknown, path: string): Snapshot {
  try { return parseGraphSnapshotProvenance(value, path); }
  catch (cause) {
    if (cause instanceof GraphSnapshotProvenanceError) {
      const reason = cause.details.reason === "invalid-container"
        || cause.details.reason === "invalid-field-set"
        ? cause.details.reason
        : cause.details.reason === "invalid-safe-integer"
          ? "invalid-number"
          : cause.details.reason === "invalid-literal"
            ? "invalid-enum"
            : "invalid-string";
      invalid(reason, cause.details.path);
    }
    throw cause;
  }
}
function freshness(value: unknown, path: string): Freshness {
  try { return parseGraphDeclaredFreshness(value, path); }
  catch (cause) {
    if (cause instanceof GraphSnapshotProvenanceError) {
      const reason = cause.details.reason === "invalid-container"
        || cause.details.reason === "invalid-field-set"
        || cause.details.reason === "invalid-instant"
        || cause.details.reason === "invalid-order"
        ? cause.details.reason
        : "invalid-enum";
      invalid(reason, cause.details.path);
    }
    throw cause;
  }
}
function snapshotFreshnessPair(snapshotValue: Snapshot, freshnessValue: Freshness): void {
  try { assertGraphSnapshotFreshnessPair(snapshotValue, freshnessValue, "/snapshot", "/declaredFreshness"); }
  catch (cause) { if (cause instanceof GraphSnapshotProvenanceError) invalid("freshness-mismatch", cause.details.path); throw cause; }
}
function authority(value: unknown, path: string): Authority {
  const root = record(value, ["nomination", "freshness", "action"], [], path);
  if (root.nomination !== "caller-declared-non-exhaustive" || (root.freshness !== "caller-declared-not-verified" && root.freshness !== "provider-capture-freshness-unassessed") || root.action !== "no-authority-granted") invalid("invalid-enum", path);
  return freezeRecord({ nomination: "caller-declared-non-exhaustive" as const, freshness: root.freshness, action: "no-authority-granted" as const });
}
function evidence(value: unknown, path: string): GraphEvidenceRef {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid("invalid-assertion", path);
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== "string")
    || keys.some((key) => key !== "id" && key !== "namespace" && key !== "version")
    || !Object.hasOwn(value, "id")
    || !Object.hasOwn(value, "namespace")
  ) {
    invalid("invalid-assertion", path);
  }
  const root = value as Record<string, unknown>;
  const validText = (candidate: unknown, max: number): candidate is string =>
    typeof candidate === "string"
    && candidate.length > 0
    && candidate === candidate.trim()
    && Array.from(candidate).length <= max
    && !CONTROL.test(candidate);
  if (!validText(root.id, 512) || !validText(root.namespace, 128)) {
    invalid("invalid-assertion", path);
  }
  const id = root.id;
  const namespace = root.namespace;
  const version = Object.hasOwn(root, "version") ? root.version : undefined;
  if (version !== undefined && !validText(version, 128)) {
    invalid("invalid-assertion", path);
  }
  return freezeRecord(version === undefined ? { id, namespace } : { id, namespace, version });
}
function canonicalValue(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  const root = value as Record<string, unknown>;
  return `{${Object.keys(root).sort(RAW).map((key) => `${JSON.stringify(key)}:${canonicalValue(root[key])}`).join(",")}}`;
}
function exactAssertion(raw: unknown, normalized: GraphAssertion): boolean { return canonicalValue(raw) === canonicalValue(normalized); }
function memberships(value: unknown, target: Scope, path: string): readonly Scope[] {
  const items = array(value, 8, path); if (items.length === 0) invalid("invalid-number", path);
  const output = items.map((item, index) => scope(item, `${path}/${index}`));
  for (let index = 1; index < output.length; index += 1) {
    const previous = output[index - 1]!;
    const current = output[index]!;
    const comparison = RAW(previous.sourceId, current.sourceId)
      || RAW(previous.threadId, current.threadId);
    if (comparison > 0) invalid("invalid-order", `${path}/${index.toString()}`);
  }
  const keys = output.map((item) => JSON.stringify([item.sourceId, item.threadId]));
  if (new Set(keys).size !== keys.length) invalid("duplicate-membership", path);
  if (!output.some((item) => equal(item, target))) invalid("scope-mismatch", path);
  return freezeArray(output);
}
function assertion(value: unknown, target: Scope, path: string): ScopedAssertion {
  const root = record(value, ["assertion", "memberships"], [], path);
  let normalized: GraphAssertion;
  try {
    normalized = normalizeGraphAssertion(root.assertion);
  } catch (cause) {
    if (cause instanceof AttunementGraphError) {
      invalid("invalid-assertion", child(path, "assertion"));
    }
    internal("envelope-postcondition-failed", child(path, "assertion"));
  }
  if (!exactAssertion(root.assertion, normalized)) {
    invalid("invalid-assertion", child(path, "assertion"));
  }
  return freezeRecord({ assertion: root.assertion as GraphAssertion, memberships: memberships(root.memberships, target, child(path, "memberships")) });
}
function step(value: unknown, path: string): Step {
  const root = record(value, ["assertionId", "direction"], [], path);
  const assertionId = text(root.assertionId, child(path, "assertionId"));
  if (root.direction !== "outgoing" && root.direction !== "incoming") invalid("invalid-enum", child(path, "direction"));
  return freezeRecord({ assertionId, direction: root.direction });
}
function proof(value: unknown, target: Scope, path: string): Proof {
  const root = record(value, ["assertions", "paths", "sourceRefs"], [], path);
  const rawAssertions = array(root.assertions, MAX_PROOF_ASSERTIONS, child(path, "assertions")); if (rawAssertions.length === 0) invalid("invalid-number", child(path, "assertions"));
  const assertions = rawAssertions.map((item, index) => assertion(item, target, `${path}/assertions/${index}`)); sorted(assertions.map((item) => item.assertion.id), child(path, "assertions"), false);
  const rawPaths = array(root.paths, 16, child(path, "paths")); if (rawPaths.length === 0) invalid("invalid-number", child(path, "paths"));
  const paths = rawPaths.map((item, index) => { const steps = array(item, 12, `${path}/paths/${index}`); if (steps.length === 0) invalid("invalid-number", `${path}/paths/${index}`); return freezeArray(steps.map((part, partIndex) => step(part, `${path}/paths/${index}/${partIndex}`))); });
  const identities = paths.map((parts) => JSON.stringify(parts.map((part) => [part.assertionId, part.direction]))); sorted(identities, child(path, "paths"), false);
  const rawSources = array(root.sourceRefs, MAX_PROOF_SOURCE_REFS, child(path, "sourceRefs")); const sources = rawSources.map((item, index) => evidence(item, `${path}/sourceRefs/${index}`));
  sorted(sources.map(evidenceRefKey), child(path, "sourceRefs"), false);
  return freezeRecord({ assertions: freezeArray(assertions), paths: freezeArray(paths), sourceRefs: freezeArray(sources) });
}

function documentBody(value: unknown, owner: string): Record<string, unknown> {
  const root = record(value, ["schemaVersion", "documentVersion", "kind", "scope", "snapshot", "declaredFreshness", "observedAt", "semanticPriority", "proof", "authority"], ["documentId"], owner);
  return Object.assign(Object.create(null), root) as Record<string, unknown>;
}
function captureRequest(input: unknown): Record<string, unknown> {
  try { const output = canonicalizeImmutableEnvelope(input, "external-mutable", REQUEST_SPEC); const parsed = JSON.parse(output.canonicalJson) as unknown; if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) internal("envelope-postcondition-failed"); return parsed as Record<string, unknown>; } catch (cause) { mapCapture(cause, "request", "", "/requestId"); }
}
function mapCapture(cause: unknown, stage: "request" | "document", owner: string, idPath: string): never {
  const failInternal = (): never => internal("envelope-postcondition-failed", owner);
  if (!(cause instanceof CanonicalImmutableEnvelopeError)) return failInternal();
  const path = typeof cause.details.path === "string" && (cause.details.path === "" || cause.details.path.startsWith("/")) ? cause.details.path : "";
  const code = cause.code as string; const reason = cause.details.reason;
  if (code === "INVALID_CONTRACT") internal("invalid-envelope-contract", owner);
  if (code === "POSTCONDITION_FAILED") failInternal();
  if (code === "BUDGET_EXCEEDED") invalid(stage === "request" ? "request-envelope-budget-exceeded" : "document-envelope-budget-exceeded", stage === "request" ? path : owner);
  if (code === "INTEGRITY_MISMATCH") { if (reason === "content-id-mismatch") invalid(stage === "request" ? "invalid-request-id" : "invalid-document-id", idPath); failInternal(); }
  if (code === "INVALID_INPUT") {
    if (reason === "malformed-id" && path === (stage === "request" ? "/requestId" : "/documentId")) invalid(stage === "request" ? "invalid-request-id" : "invalid-document-id", idPath);
    if (stage === "request") invalid("invalid-request-envelope", path);
    failInternal();
  }
  if (code === "PROFILE_MISMATCH") { if (stage === "request") invalid("invalid-request-envelope", path); failInternal(); }
  return failInternal();
}
function captureDocument(raw: unknown, owner: string, idPath: string): { readonly body: Record<string, unknown>; readonly canonicalJson: string; readonly canonicalByteLength: number } {
  const body = documentBody(raw, owner);
  try {
    const first = canonicalizeImmutableEnvelope(body, "external-mutable", DOCUMENT_SPEC);
    const second = canonicalizeImmutableEnvelope(first.envelope, "muse-frozen", DOCUMENT_SPEC);
    if (first.contentId !== second.contentId || first.canonicalJson !== second.canonicalJson || first.canonicalByteLength !== second.canonicalByteLength) internal("envelope-postcondition-failed", owner);
    return { body: second.envelope as Record<string, unknown>, canonicalJson: first.canonicalJson, canonicalByteLength: first.canonicalByteLength };
  } catch (cause) { mapCapture(cause, "document", owner, idPath); }
}
function localFailure(proofValue: Proof): LocalReason | undefined {
  const ids = proofValue.assertions.map((item) => item.assertion.id);
  if (new Set(ids).size !== ids.length) return "proof-duplicate-assertion";
  for (const path of proofValue.paths) if (new Set(path.map((part) => part.assertionId)).size !== path.length) return "proof-duplicate-assertion";
  const identities = proofValue.paths.map((parts) => JSON.stringify(parts.map((part) => [part.assertionId, part.direction])));
  if (new Set(identities).size !== identities.length) return "proof-duplicate-path";
  const included = new Map(proofValue.assertions.map((item) => [item.assertion.id, item.assertion])); const used = new Set<string>();
  for (const path of proofValue.paths) {
    let end: GraphRef | undefined;
    for (const part of path) {
      const item = included.get(part.assertionId); if (!item) return "proof-path-disconnected"; used.add(part.assertionId);
      const start = part.direction === "outgoing" ? item.subject : item.object; const next = part.direction === "outgoing" ? item.object : item.subject;
      if (end !== undefined && graphRefKey(end) !== graphRefKey(start)) return "proof-path-disconnected";
      end = next;
    }
  }
  const expected = [...new Map(proofValue.assertions.flatMap((item) => item.assertion.sourceRefs.map((source) => [evidenceRefKey(source), source] as const))).entries()].sort(([left], [right]) => RAW(left, right)).map(([, source]) => source);
  if (used.size !== proofValue.assertions.length || proofValue.sourceRefs.length !== expected.length || proofValue.sourceRefs.some((source, index) => evidenceRefKey(source) !== evidenceRefKey(expected[index]!))) return "proof-source-unclosed";
  return undefined;
}
function localStatus(value: unknown, derived: LocalReason | undefined, path: string): LocalStatus {
  const root = record(value, ["status"], ["reasonId"], path);
  if (root.status === "eligible") { if (Object.hasOwn(root, "reasonId") || derived !== undefined) invalid("invalid-local-status", path); return freezeRecord({ status: "eligible" as const }); }
  if (root.status === "rejected") { if (!Object.hasOwn(root, "reasonId") || derived === undefined || root.reasonId !== derived) invalid("invalid-local-status", path); return freezeRecord({ status: "rejected" as const, reasonId: derived }); }
  invalid("invalid-local-status", child(path, "status"));
}
function parsedDocument(value: Record<string, unknown>, requestScope: Scope, requestSnapshot: Snapshot, requestFreshness: Freshness, owner: string): Document {
  if (value.schemaVersion !== 1) invalid("invalid-schema-version", child(owner, "schemaVersion"));
  if (value.documentVersion !== "muse.scoped-proof-document.v1") invalid("invalid-enum", child(owner, "documentVersion"));
  if (typeof value.documentId !== "string" || !DOCUMENT_ID.test(value.documentId)) invalid("invalid-document-id", child(owner, "documentId"));
  const kind = value.kind; if (kind !== "core" && kind !== "change" && kind !== "support") invalid("invalid-document-kind", child(owner, "kind"));
  const expectedPriority = kind === "core" ? 0 : kind === "change" ? 1 : 2; if (value.semanticPriority !== expectedPriority) invalid("invalid-priority", child(owner, "semanticPriority"));
  const actualScope = scope(value.scope, child(owner, "scope")); if (!equal(actualScope, requestScope)) invalid("scope-mismatch", child(owner, "scope"));
  const actualSnapshot = snapshot(value.snapshot, child(owner, "snapshot")); if (!equal(actualSnapshot, requestSnapshot)) invalid("snapshot-mismatch", child(owner, "snapshot"));
  const actualFreshness = freshness(value.declaredFreshness, child(owner, "declaredFreshness")); if (!equal(actualFreshness, requestFreshness)) invalid("freshness-mismatch", child(owner, "declaredFreshness"));
  const observedAt = instant(value.observedAt, child(owner, "observedAt")); if ((requestFreshness.status === "fresh" || requestFreshness.status === "stale") && instantEpoch(observedAt) > instantEpoch(requestFreshness.observedAt)) invalid("freshness-mismatch", child(owner, "observedAt"));
  const parsedAuthority = authority(value.authority, child(owner, "authority"));
  const expectedAuthorityFreshness = requestSnapshot.authority === "receipt-integrity-only"
    ? "provider-capture-freshness-unassessed"
    : "caller-declared-not-verified";
  if (parsedAuthority.freshness !== expectedAuthorityFreshness) {
    invalid("freshness-mismatch", child(child(owner, "authority"), "freshness"));
  }
  return freezeRecord({ schemaVersion: 1 as const, documentVersion: "muse.scoped-proof-document.v1" as const, documentId: value.documentId, kind, scope: actualScope, snapshot: actualSnapshot, declaredFreshness: actualFreshness, observedAt, semanticPriority: expectedPriority as 0 | 1 | 2, proof: proof(value.proof, requestScope, child(owner, "proof")), authority: parsedAuthority });
}
function candidate(raw: unknown, role: "core" | "optional", index: number | undefined, requestScope: Scope, requestSnapshot: Snapshot, requestFreshness: Freshness): Candidate {
  const base = role === "core" ? "/core" : `/optionals/${index!.toString()}`; const root = record(raw, ["document", "localStatus"], [], base); const owner = `${base}/document`;
  const captured = captureDocument(root.document, owner, `${owner}/documentId`);
  const document = parsedDocument(captured.body, requestScope, requestSnapshot, requestFreshness, owner);
  if ((role === "core" && document.kind !== "core") || (role === "optional" && document.kind === "core")) invalid("invalid-document-kind", `${owner}/kind`);
  const derived = localFailure(document.proof); const status = localStatus(root.localStatus, derived, `${base}/localStatus`); const forcedFreshness = role === "core" && (requestFreshness.status === "rebuilding" || requestFreshness.status === "unavailable" || requestFreshness.status === "unassessed");
  const digest = document.documentId.slice(-64); return freezeRecord({ document, localStatus: status, retainedCanonicalJson: captured.canonicalJson, retainedCanonicalByteLength: captured.canonicalByteLength, candidateId: `${role}:${digest}`, forcedFreshness });
}
function budget(value: unknown): Budget { const root = record(value, ["maxDepth", "maxConsideredAssertions", "maxVisitedRefs", "maxAssertions", "maxEstimatedTokens", "maxOutputBytes"], [], "/budget"); return freezeRecord({ maxDepth: number(root.maxDepth, "/budget/maxDepth"), maxConsideredAssertions: number(root.maxConsideredAssertions, "/budget/maxConsideredAssertions"), maxVisitedRefs: number(root.maxVisitedRefs, "/budget/maxVisitedRefs"), maxAssertions: number(root.maxAssertions, "/budget/maxAssertions"), maxEstimatedTokens: number(root.maxEstimatedTokens, "/budget/maxEstimatedTokens"), maxOutputBytes: number(root.maxOutputBytes, "/budget/maxOutputBytes") }); }
function cost(document: Document, bytes: number): Record<string, number> {
  const endpoints = new Set<string>(); for (const path of document.proof.paths) for (const item of path) { const assertion = document.proof.assertions.find((candidate) => candidate.assertion.id === item.assertionId)?.assertion; if (assertion) { const start = item.direction === "outgoing" ? assertion.subject : assertion.object; const end = item.direction === "outgoing" ? assertion.object : assertion.subject; endpoints.add(graphRefKey(start)); endpoints.add(graphRefKey(end)); } }
  const outputBytes = 1 + bytes; return { assertions: new Set(document.proof.assertions.map((item) => item.assertion.id)).size, consideredAssertions: document.proof.assertions.length, depth: Math.max(...document.proof.paths.map((path) => path.length)), estimatedTokens: Math.ceil(outputBytes / 4), outputBytes, visitedRefs: endpoints.size };
}
function inventory(core: Candidate, optionals: readonly Candidate[], value: Budget): Record<string, unknown> {
  const semantic = (item: Candidate): string | undefined => item.forcedFreshness ? `semantic:${item.document.declaredFreshness.status === "unassessed" ? "freshness-unassessed" : "freshness-unavailable"}` : item.localStatus.status === "rejected" ? `semantic:${item.localStatus.reasonId}` : undefined;
  const entry = (item: Candidate, role: "core" | "optional", rank: number): Record<string, unknown> => { const reason = semantic(item); return { candidateId: item.candidateId, cost: reason === undefined ? cost(item.document, item.retainedCanonicalByteLength) : { assertions: 0, consideredAssertions: 0, depth: 0, estimatedTokens: 0, outputBytes: 0, visitedRefs: 0 }, preflight: reason === undefined ? { status: "eligible" } : { status: "rejected", reasonId: reason }, rank, role }; };
  const eligible = optionals.filter((item) => semantic(item) === undefined).sort((left, right) => left.document.semanticPriority - right.document.semanticPriority || instantEpoch(right.document.observedAt) - instantEpoch(left.document.observedAt) || RAW(left.document.documentId, right.document.documentId));
  const ranks = new Map(eligible.map((item, index) => [item.candidateId, index]));
  const canonicalOptionals = [...optionals].sort((left, right) =>
    RAW(left.candidateId, right.candidateId)
  );
  return {
    schemaVersion: 1,
    budget: { ...value },
    core: entry(core, "core", 0),
    optionals: canonicalOptionals.map((item) =>
      entry(item, "optional", ranks.get(item.candidateId) ?? 0)
    )
  };
}
function deepFrozen(value: unknown): boolean { if (value === null || typeof value !== "object") return true; if (!Object.isFrozen(value) || Object.getPrototypeOf(value) !== (Array.isArray(value) ? Array.prototype : null)) return false; return Reflect.ownKeys(value).every((key) => { const descriptor = Object.getOwnPropertyDescriptor(value, key); return typeof key === "string" && descriptor !== undefined && "value" in descriptor && descriptor.writable === false && descriptor.configurable === false && (key === "length" || deepFrozen(descriptor.value)); }); }
function freezeTree<T>(value: T): T { if (value !== null && typeof value === "object") { for (const key of Reflect.ownKeys(value)) { const descriptor = Object.getOwnPropertyDescriptor(value, key); if (descriptor !== undefined && "value" in descriptor && key !== "length") freezeTree(descriptor.value); } Object.freeze(value); } return value; }
function materialize(settlement: BoundedSettlementResult, lookup: ReadonlyMap<string, Candidate>): { readonly documents: readonly Document[]; readonly contextStream: string } {
  if (settlement.ledger.entries.length !== lookup.size) {
    internal("materialization-postcondition-failed");
  }
  const seen = new Set<string>();
  const documents: Document[] = [];
  let stream = settlement.canonicalJson;
  let selectedPayloadBytes = 0;
  for (const entry of settlement.ledger.entries) {
    if (seen.has(entry.candidateId)) {
      internal("materialization-postcondition-failed");
    }
    seen.add(entry.candidateId);
    const candidateValue = lookup.get(entry.candidateId);
    if (candidateValue === undefined) {
      internal("materialization-postcondition-failed");
    }
    if (entry.terminalState !== "admitted") continue;
    if (
      !entry.candidateId.endsWith(candidateValue.document.documentId.slice(-64))
      || Buffer.byteLength(candidateValue.retainedCanonicalJson, "utf8")
        !== candidateValue.retainedCanonicalByteLength
    ) {
      internal("materialization-postcondition-failed");
    }
    documents.push(candidateValue.document);
    stream += `\n${candidateValue.retainedCanonicalJson}`;
    selectedPayloadBytes += 1 + candidateValue.retainedCanonicalByteLength;
  }
  if (
    seen.size !== lookup.size
    || settlement.ledger.counters.selectedPayloadBytes !== selectedPayloadBytes
    || stream.startsWith("\uFEFF")
    || stream.endsWith("\n")
    || Buffer.byteLength(stream, "utf8") !== settlement.totalOutputBytes
    || settlement.totalOutputBytes
      !== settlement.canonicalByteLength + selectedPayloadBytes
  ) {
    internal("materialization-postcondition-failed");
  }
  return { documents: freezeArray(documents), contextStream: stream };
}

export function compileScopedProofDocumentSettlement(input: unknown): ScopedProofDocumentSettlementResultV1 {
  const root = captureRequest(input);
  const request = record(root, ["schemaVersion", "operatorVersion", "scope", "snapshot", "declaredFreshness", "core", "optionals", "budget"], ["requestId"], "");
  if (request.schemaVersion !== 1) invalid("invalid-schema-version", "/schemaVersion"); if (request.operatorVersion !== "muse.scoped-proof-document-settlement.v1") invalid("invalid-operator-version", "/operatorVersion"); if (typeof request.requestId !== "string" || !REQUEST_ID.test(request.requestId)) invalid("invalid-request-id", "/requestId");
  const requestScope = scope(request.scope, "/scope"); const requestSnapshot = snapshot(request.snapshot, "/snapshot"); const requestFreshness = freshness(request.declaredFreshness, "/declaredFreshness"); snapshotFreshnessPair(requestSnapshot, requestFreshness); const requestBudget = budget(request.budget);
  const raws = array(request.optionals, 256, "/optionals");
  if (raws.length > 255) invalid("too-many-optionals", "/optionals");
  const core = candidate(request.core, "core", undefined, requestScope, requestSnapshot, requestFreshness);
  const optionals = raws.map((item, index) => candidate(item, "optional", index, requestScope, requestSnapshot, requestFreshness));
  const ids = new Set<string>();
  for (const [index, item] of [core, ...optionals].entries()) {
    if (ids.has(item.document.documentId) || ids.has(item.candidateId)) {
      invalid(
        "duplicate-document-id",
        index === 0
          ? "/core/document/documentId"
          : `/optionals/${(index - 1).toString()}/document/documentId`
      );
    }
    ids.add(item.document.documentId);
    ids.add(item.candidateId);
  }
  let settled: CandidateSettlementResult; try { settled = settleCandidateInventory(inventory(core, optionals, requestBudget)); } catch { internal("settlement-postcondition-failed"); }
  if (settled.status === "invalid-input") {
    const result = freezeRecord({
      status: "invalid-input" as const,
      resultId: settled.error.errorId,
      capacity: settled
    });
    if (!deepFrozen(result)) internal("materialization-postcondition-failed");
    return result;
  }
  const lookup = new Map<string, Candidate>([core, ...optionals].map((item) => [item.candidateId, item])); const produced = materialize(settled, lookup);
  if (settled.ledger.mode === "abstain") {
    if (produced.documents.length !== 0 || produced.contextStream !== settled.canonicalJson) internal("materialization-postcondition-failed"); const coreEntry = settled.ledger.entries.find((entry) => entry.role === "core"); if (!coreEntry) internal("materialization-postcondition-failed"); const reasons: ("freshness-unavailable" | "freshness-unassessed" | "mandatory-proof-not-admitted" | "settlement-abstained")[] = []; if (core.forcedFreshness && coreEntry.terminalState === "rejected") reasons.push(requestFreshness.status === "unassessed" ? "freshness-unassessed" : "freshness-unavailable"); if (coreEntry.terminalState !== "admitted") reasons.push("mandatory-proof-not-admitted"); reasons.push("settlement-abstained"); const result = freezeTree(freezeRecord({ status: "abstained" as const, resultId: settled.ledger.ledgerId, scope: requestScope, snapshot: requestSnapshot, declaredFreshness: requestFreshness, completeness: freezeRecord({ status: "abstained" as const, canAssertAbsenceWithinSnapshot: false as const, canAssertCurrentWorldAbsence: false as const, reasons: freezeArray(reasons) }), settlement: settled, contextStream: settled.canonicalJson })); if (!deepFrozen(result)) internal("materialization-postcondition-failed"); return result;
  }
  const reasons: ("nomination-not-exhaustive" | "freshness-not-authoritative" | "candidate-not-admitted")[] = ["nomination-not-exhaustive", "freshness-not-authoritative"]; if (settled.ledger.entries.some((entry) => entry.terminalState !== "admitted")) reasons.push("candidate-not-admitted"); const result = freezeTree(freezeRecord({ status: "partial" as const, resultId: settled.ledger.ledgerId, scope: requestScope, snapshot: requestSnapshot, declaredFreshness: requestFreshness, completeness: freezeRecord({ status: "partial" as const, canAssertAbsenceWithinSnapshot: false as const, canAssertCurrentWorldAbsence: false as const, reasons: freezeArray(reasons) }), settlement: settled, documents: produced.documents, contextStream: produced.contextStream })); if (!deepFrozen(result)) internal("materialization-postcondition-failed"); return result;
}
