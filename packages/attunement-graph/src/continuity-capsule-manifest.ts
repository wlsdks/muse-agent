import { createHash } from "node:crypto";

import {
  ContinuityScopedSourceObservationError,
  verifyScopedContinuitySourceObservation,
  type ContinuityScopedSourceObservationReceipt
} from "@muse/attunement/continuity-source-observations";
import {
  ARTIFACT_ROLES,
  ARTIFACT_TYPES,
  isCoherentArtifactProvider,
  type ArtifactReference,
  type ContinuityEvidence,
  type ResolvedArtifact
} from "@muse/attunement";

import { compareVerifiedContinuityObservationReceipts } from "./continuity-observation-comparison.js";
import {
  ContinuityObservationError,
  verifyContinuityObservation,
  type ContinuityObservationReceipt
} from "./continuity-observation.js";
import { continuitySourceGraphPairMatches } from "./continuity-source-graph-binding.js";
import { ContinuityChangeQueryError } from "./continuity-change-primitives.js";
import type { ExplainedContinuityChangeResult } from "./continuity-change-contracts.js";

export const CONTINUITY_CAPSULE_MANIFEST_FORMAT_VERSION =
  "muse.continuity-capsule-manifest.v1" as const;

export const CONTINUITY_CAPSULE_MANIFEST_LIMITS = Object.freeze({
  maxExpectedMinutes: 1_440,
  maxManifestBytes: 65_536,
  maxPreparedContentBytes: 16_384,
  maxPreparedTitleBytes: 1_200,
  maxPreparedTitleScalars: 300,
  maxSupportingEvidence: 16,
  maxSourceDisplayBytes: 16_384
});

const HASH_DOMAIN = "muse.attunement.continuity-capsule-manifest.v1\0";
const MANIFEST_ID_PREFIX = "muse-continuity-capsule-manifest:v1:sha256:";
const MANIFEST_ID_PLACEHOLDER = `${MANIFEST_ID_PREFIX}${"0".repeat(64)}`;
const MANIFEST_ID_PATTERN =
  /^muse-continuity-capsule-manifest:v1:sha256:[0-9a-f]{64}$/u;
const SOURCE_RECEIPT_ID_PATTERN =
  /^muse-continuity-scoped-source-observation:v1:sha256:[0-9a-f]{64}$/u;
const GRAPH_RECEIPT_ID_PATTERN =
  /^muse-continuity-observation:v1:sha256:[0-9a-f]{64}$/u;
const CHANGE_RESULT_ID_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const PREPARED_TITLE_CONTROL = /[\u0000-\u001F\u007F]/u;
const PREPARED_CONTENT_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;

export type ContinuityCapsuleManifestErrorCode =
  | "INVALID_INPUT"
  | "INVALID_MANIFEST"
  | "INVALID_DEPENDENCY"
  | "DEPENDENCY_MISMATCH"
  | "MISSING_RESUME_EVIDENCE"
  | "BUDGET_EXCEEDED"
  | "INTEGRITY_MISMATCH";

export class ContinuityCapsuleManifestError extends Error {
  readonly code: ContinuityCapsuleManifestErrorCode;
  readonly details: Readonly<Record<string, number | string>>;

  constructor(
    code: ContinuityCapsuleManifestErrorCode,
    message: string,
    details: Readonly<Record<string, number | string>> = {}
  ) {
    super(message);
    this.name = "ContinuityCapsuleManifestError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export interface CapsuleArtifactSnapshot {
  readonly reference: ArtifactReference;
  readonly status: "available" | "unavailable";
  readonly title?: string;
  readonly summary?: string;
}

export interface ContinuityCapsulePreparedWork {
  readonly kind: "draft" | "action-preview";
  readonly actionMode: "display-only" | "requires-new-approval";
  readonly title: string;
  readonly content: string;
  readonly expectedMinutes: number;
}

export interface ContinuityCapsuleManifest {
  readonly schemaVersion: 1;
  readonly formatVersion: typeof CONTINUITY_CAPSULE_MANIFEST_FORMAT_VERSION;
  readonly authority: "caller-declared-preparation";
  readonly thread: { readonly id: string; readonly title: string };
  readonly previousObservedAt: string;
  readonly currentObservedAt: string;
  readonly preparedAt: string;
  readonly previousSourceObservationReceiptId: string;
  readonly previousGraphObservationReceiptId: string;
  readonly currentSourceObservationReceiptId: string;
  readonly currentGraphObservationReceiptId: string;
  readonly changeResultId: string;
  readonly stoppingPoint: CapsuleArtifactSnapshot;
  readonly stoppingPointCurrentAvailability: "available" | "unavailable";
  readonly currentNextStep: CapsuleArtifactSnapshot;
  readonly supportingEvidence: readonly CapsuleArtifactSnapshot[];
  readonly preparedWork: ContinuityCapsulePreparedWork;
  readonly manifestId: string;
}

export interface ContinuityCapsuleCompilation {
  readonly manifest: ContinuityCapsuleManifest;
  readonly changeResult: ExplainedContinuityChangeResult;
}

interface ParsedPreparation {
  readonly preparedAt: string;
  readonly supportingEvidenceRefs: readonly ArtifactReference[];
  readonly preparedWork: ContinuityCapsulePreparedWork;
}

interface ParsedCompilerInput {
  readonly previousSourceObservationReceipt: unknown;
  readonly previousGraphObservationReceipt: unknown;
  readonly currentSourceObservationReceipt: unknown;
  readonly currentGraphObservationReceipt: unknown;
  readonly preparation: ParsedPreparation;
}

type ManifestBody = Omit<ContinuityCapsuleManifest, "manifestId">;
type InvalidCode = "INVALID_INPUT" | "INVALID_MANIFEST";

function fail(
  code: ContinuityCapsuleManifestErrorCode,
  message: string,
  details: Readonly<Record<string, number | string>> = {}
): never {
  throw new ContinuityCapsuleManifestError(code, message, details);
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function freezeArray<T>(value: readonly T[]): readonly T[] {
  return Object.freeze([...value]);
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (Number.isFinite(value)) return value;
    throw new TypeError("canonical capsule data contains a non-finite number");
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) output[key] = canonicalValue(child);
    }
    return output;
  }
  throw new TypeError("canonical capsule data contains an unsupported value");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function shallowRecord(
  value: unknown,
  label: string,
  allowed: readonly string[],
  required: readonly string[],
  invalidCode: InvalidCode
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(invalidCode, `${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(invalidCode, `${label} must be a plain object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) {
    fail(invalidCode, `${label} must not contain symbol properties`);
  }
  const names = keys as string[];
  if (names.some((key) => !allowed.includes(key)) || required.some((key) => !names.includes(key))) {
    fail(invalidCode, `${label} has missing or unknown fields`);
  }
  const output: Record<string, unknown> = Object.create(null);
  for (const name of names) {
    const descriptor = descriptors[name];
    if (!descriptor || !("value" in descriptor)) {
      fail(invalidCode, `${label} must contain only data properties`);
    }
    output[name] = descriptor.value;
  }
  return Object.freeze(output);
}

function strictArray(value: unknown, label: string, invalidCode: InvalidCode): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    fail(invalidCode, `${label} must be a dense plain array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = value.length;
  if (!Number.isSafeInteger(length) || length < 0) {
    fail(invalidCode, `${label} has an invalid length`);
  }
  const output: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const key = index.toString();
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor)) {
      fail(invalidCode, `${label} must be dense data`);
    }
    output.push(descriptor.value);
  }
  const allowed = new Set(["length", ...output.map((_, index) => index.toString())]);
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || !allowed.has(key))) {
    fail(invalidCode, `${label} has unknown properties`);
  }
  return freezeArray(output);
}

function canonicalInstant(value: unknown, label: string, invalidCode: InvalidCode): string {
  if (typeof value !== "string") fail(invalidCode, `${label} must be a parseable instant`);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) fail(invalidCode, `${label} must be a parseable instant`);
  const canonical = date.toISOString();
  if (canonical !== value) fail(invalidCode, `${label} must be a canonical instant`);
  return canonical;
}

function requiredText(value: unknown, label: string, invalidCode: InvalidCode): string {
  if (typeof value !== "string" || value.length === 0) fail(invalidCode, `${label} must be non-empty text`);
  return value;
}

function referenceKey(reference: ArtifactReference): string {
  return JSON.stringify([
    reference.artifactId,
    reference.artifactType,
    reference.providerId,
    reference.role
  ]);
}

function compareCanonicalText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function parseReference(value: unknown, label: string, invalidCode: InvalidCode): ArtifactReference {
  const record = shallowRecord(value, label, ["artifactId", "artifactType", "providerId", "role"], ["artifactId", "artifactType", "providerId", "role"], invalidCode);
  const artifactId = requiredText(record.artifactId, `${label}.artifactId`, invalidCode);
  const artifactTypeValue = requiredText(record.artifactType, `${label}.artifactType`, invalidCode);
  const providerId = requiredText(record.providerId, `${label}.providerId`, invalidCode);
  const roleValue = requiredText(record.role, `${label}.role`, invalidCode);
  const artifactType = ARTIFACT_TYPES.find((candidate) =>
    candidate === artifactTypeValue
  );
  const role = ARTIFACT_ROLES.find((candidate) => candidate === roleValue);
  if (!artifactType || !role) {
    fail(invalidCode, `${label} has an unsupported artifact type or role`);
  }
  if (!isCoherentArtifactProvider(artifactType, providerId)) {
    fail(invalidCode, `${label} has an incoherent provider`);
  }
  for (const [field, fieldValue] of [
    ["artifactId", artifactId],
    ["providerId", providerId]
  ] as const) {
    if (
      utf8Bytes(fieldValue)
      > CONTINUITY_CAPSULE_MANIFEST_LIMITS.maxSourceDisplayBytes
    ) {
      fail("BUDGET_EXCEEDED", `${label}.${field} exceeds its source budget`);
    }
  }
  return Object.freeze({ artifactId, artifactType, providerId, role });
}

function sameReference(left: ArtifactReference, right: ArtifactReference): boolean {
  return referenceKey(left) === referenceKey(right);
}

function parsePreparedWork(value: unknown, invalidCode: InvalidCode): ContinuityCapsulePreparedWork {
  const record = shallowRecord(value, "preparation.preparedWork", ["kind", "actionMode", "title", "content", "expectedMinutes"], ["kind", "actionMode", "title", "content", "expectedMinutes"], invalidCode);
  if (record.kind !== "draft" && record.kind !== "action-preview") {
    fail(invalidCode, "preparedWork.kind is unsupported");
  }
  const expectedMode = record.kind === "draft" ? "display-only" : "requires-new-approval";
  if (record.actionMode !== expectedMode) fail(invalidCode, "preparedWork.actionMode is incoherent");
  const title = requiredText(record.title, "preparedWork.title", invalidCode);
  const titleScalars = Array.from(title).length;
  const titleBytes = utf8Bytes(title);
  if (titleScalars > CONTINUITY_CAPSULE_MANIFEST_LIMITS.maxPreparedTitleScalars || titleBytes > CONTINUITY_CAPSULE_MANIFEST_LIMITS.maxPreparedTitleBytes) {
    fail("BUDGET_EXCEEDED", "preparedWork.title exceeds its budget");
  }
  if (PREPARED_TITLE_CONTROL.test(title)) fail(invalidCode, "preparedWork.title contains control characters");
  const content = requiredText(record.content, "preparedWork.content", invalidCode);
  if (utf8Bytes(content) > CONTINUITY_CAPSULE_MANIFEST_LIMITS.maxPreparedContentBytes) {
    fail("BUDGET_EXCEEDED", "preparedWork.content exceeds its byte budget");
  }
  if (PREPARED_CONTENT_CONTROL.test(content)) fail(invalidCode, "preparedWork.content contains control characters");
  if (typeof record.expectedMinutes !== "number" || !Number.isSafeInteger(record.expectedMinutes)) fail(invalidCode, "preparedWork.expectedMinutes must be an integer");
  const expectedMinutes = record.expectedMinutes;
  if (expectedMinutes < 1 || expectedMinutes > CONTINUITY_CAPSULE_MANIFEST_LIMITS.maxExpectedMinutes) {
    fail("BUDGET_EXCEEDED", "preparedWork.expectedMinutes exceeds its budget");
  }
  return Object.freeze({
    kind: record.kind,
    actionMode: expectedMode,
    title,
    content,
    expectedMinutes
  });
}

function parsePreparation(value: unknown, invalidCode: InvalidCode): ParsedPreparation {
  const record = shallowRecord(value, "preparation", ["preparedAt", "supportingEvidenceRefs", "preparedWork"], ["preparedAt", "supportingEvidenceRefs", "preparedWork"], invalidCode);
  const preparedAt = canonicalInstant(record.preparedAt, "preparation.preparedAt", invalidCode);
  const rawReferences = strictArray(record.supportingEvidenceRefs, "preparation.supportingEvidenceRefs", invalidCode);
  if (rawReferences.length > CONTINUITY_CAPSULE_MANIFEST_LIMITS.maxSupportingEvidence) {
    fail("BUDGET_EXCEEDED", "preparation.supportingEvidenceRefs exceeds its item budget");
  }
  const references = rawReferences.map((entry, index) => parseReference(entry, `preparation.supportingEvidenceRefs[${index}]`, invalidCode));
  const keys = new Set(references.map(referenceKey));
  if (keys.size !== references.length) fail(invalidCode, "preparation.supportingEvidenceRefs must be unique");
  return Object.freeze({
    preparedAt,
    supportingEvidenceRefs: freezeArray([...references].sort((left, right) =>
      compareCanonicalText(referenceKey(left), referenceKey(right))
    )),
    preparedWork: parsePreparedWork(record.preparedWork, invalidCode)
  });
}

function parseCompilerInput(value: unknown): ParsedCompilerInput {
  const record = shallowRecord(value, "capsule compiler input", ["schemaVersion", "previousSourceObservationReceipt", "previousGraphObservationReceipt", "currentSourceObservationReceipt", "currentGraphObservationReceipt", "preparation"], ["schemaVersion", "previousSourceObservationReceipt", "previousGraphObservationReceipt", "currentSourceObservationReceipt", "currentGraphObservationReceipt", "preparation"], "INVALID_INPUT");
  if (record.schemaVersion !== 1) fail("INVALID_INPUT", "capsule compiler input.schemaVersion must be 1");
  return Object.freeze({
    previousSourceObservationReceipt: record.previousSourceObservationReceipt,
    previousGraphObservationReceipt: record.previousGraphObservationReceipt,
    currentSourceObservationReceipt: record.currentSourceObservationReceipt,
    currentGraphObservationReceipt: record.currentGraphObservationReceipt,
    preparation: parsePreparation(record.preparation, "INVALID_INPUT")
  });
}

function mapDependency(cause: unknown): never {
  if (cause instanceof ContinuityScopedSourceObservationError) {
    fail(cause.code === "BUDGET_EXCEEDED" ? "BUDGET_EXCEEDED" : "INVALID_DEPENDENCY", cause.message, cause.details);
  }
  if (cause instanceof ContinuityObservationError) {
    fail(cause.code === "BUDGET_EXCEEDED" ? "BUDGET_EXCEEDED" : "INVALID_DEPENDENCY", cause.message, cause.details);
  }
  throw cause;
}

function mapComparison(cause: unknown): never {
  if (cause instanceof ContinuityChangeQueryError) {
    fail(cause.code === "INVALID_INPUT" ? "DEPENDENCY_MISMATCH" : "BUDGET_EXCEEDED", cause.message, cause.details);
  }
  throw cause;
}

function snapshot(reference: ArtifactReference, status: "available" | "unavailable", artifact?: ResolvedArtifact): CapsuleArtifactSnapshot {
  const output: { reference: ArtifactReference; status: "available" | "unavailable"; title?: string; summary?: string } = {
    reference: Object.freeze({
      artifactId: reference.artifactId,
      artifactType: reference.artifactType,
      providerId: reference.providerId,
      role: reference.role
    }) as ArtifactReference,
    status
  };
  if (artifact?.title !== undefined) output.title = artifact.title;
  if (artifact?.summary !== undefined) output.summary = artifact.summary;
  return Object.freeze(output);
}

function evidenceFor(reference: ArtifactReference, evidence: readonly ContinuityEvidence[]): ContinuityEvidence | undefined {
  return evidence.find((entry) => sameReference(entry.reference, reference));
}

function snapshotFromAvailableEvidence(reference: ArtifactReference, evidence: readonly ContinuityEvidence[], label: string): CapsuleArtifactSnapshot {
  const entry = evidenceFor(reference, evidence);
  if (!entry || entry.status !== "available" || !entry.artifact) {
    fail("MISSING_RESUME_EVIDENCE", `${label} is not available current evidence`);
  }
  return snapshot(reference, "available", entry.artifact);
}

function snapshotFromResolved(artifact: ResolvedArtifact): CapsuleArtifactSnapshot {
  return snapshot(artifact, "available", artifact);
}

function availability(reference: ArtifactReference, evidence: readonly ContinuityEvidence[]): "available" | "unavailable" {
  return evidenceFor(reference, evidence)?.status === "available" ? "available" : "unavailable";
}

function manifestBody(
  previousSource: ContinuityScopedSourceObservationReceipt,
  previousGraph: ContinuityObservationReceipt,
  currentSource: ContinuityScopedSourceObservationReceipt,
  currentGraph: ContinuityObservationReceipt,
  preparation: ParsedPreparation,
  changeResult: ExplainedContinuityChangeResult
): ManifestBody {
  const previousProjection = previousSource.observation.projection;
  const currentProjection = currentSource.observation.projection;
  if (!previousProjection.nextStep) fail("MISSING_RESUME_EVIDENCE", "previous source receipt has no resolved next step");
  if (!currentProjection.nextStep) fail("MISSING_RESUME_EVIDENCE", "current source receipt has no resolved next step");
  if (preparation.preparedAt !== currentSource.observation.observedAt) {
    fail("DEPENDENCY_MISMATCH", "preparation.preparedAt must equal the current observation time");
  }
  const stoppingPoint = snapshotFromResolved(previousProjection.nextStep);
  const currentNextStep = snapshotFromAvailableEvidence(currentProjection.nextStep, currentProjection.evidence, "current next step");
  const supportingEvidence = freezeArray(preparation.supportingEvidenceRefs.map((reference) =>
    snapshotFromAvailableEvidence(reference, currentProjection.evidence, "supporting evidence")
  ));
  return Object.freeze({
    schemaVersion: 1 as const,
    formatVersion: CONTINUITY_CAPSULE_MANIFEST_FORMAT_VERSION,
    authority: "caller-declared-preparation" as const,
    thread: Object.freeze({ id: currentProjection.thread.id, title: currentProjection.thread.title }),
    previousObservedAt: previousSource.observation.observedAt,
    currentObservedAt: currentSource.observation.observedAt,
    preparedAt: preparation.preparedAt,
    previousSourceObservationReceiptId: previousSource.receiptId,
    previousGraphObservationReceiptId: previousGraph.receiptId,
    currentSourceObservationReceiptId: currentSource.receiptId,
    currentGraphObservationReceiptId: currentGraph.receiptId,
    changeResultId: changeResult.resultId,
    stoppingPoint,
    stoppingPointCurrentAvailability: availability(stoppingPoint.reference, currentProjection.evidence),
    currentNextStep,
    supportingEvidence,
    preparedWork: preparation.preparedWork
  });
}

function manifestId(body: ManifestBody): string {
  return `${MANIFEST_ID_PREFIX}${createHash("sha256").update(HASH_DOMAIN, "utf8").update(canonicalJson(body), "utf8").digest("hex")}`;
}

function assertManifestBytes(body: ManifestBody, id: string): void {
  const bytes = utf8Bytes(canonicalJson({ ...body, manifestId: id }));
  if (bytes > CONTINUITY_CAPSULE_MANIFEST_LIMITS.maxManifestBytes) {
    fail("BUDGET_EXCEEDED", "continuity capsule manifest exceeds its serialized byte budget", { bytes, limit: CONTINUITY_CAPSULE_MANIFEST_LIMITS.maxManifestBytes });
  }
}

function finalizeManifest(body: ManifestBody): ContinuityCapsuleManifest {
  assertManifestBytes(body, MANIFEST_ID_PLACEHOLDER);
  const id = manifestId(body);
  return Object.freeze({ ...body, manifestId: id });
}

export function compileContinuityCapsuleManifest(input: unknown): ContinuityCapsuleCompilation {
  const parsed = parseCompilerInput(input);
  let previousSource: ContinuityScopedSourceObservationReceipt;
  let previousGraph: ContinuityObservationReceipt;
  let currentSource: ContinuityScopedSourceObservationReceipt;
  let currentGraph: ContinuityObservationReceipt;
  try { previousSource = verifyScopedContinuitySourceObservation(parsed.previousSourceObservationReceipt); } catch (cause) { mapDependency(cause); }
  try { previousGraph = verifyContinuityObservation(parsed.previousGraphObservationReceipt); } catch (cause) { mapDependency(cause); }
  try { currentSource = verifyScopedContinuitySourceObservation(parsed.currentSourceObservationReceipt); } catch (cause) { mapDependency(cause); }
  try { currentGraph = verifyContinuityObservation(parsed.currentGraphObservationReceipt); } catch (cause) { mapDependency(cause); }
  if (!continuitySourceGraphPairMatches(previousSource, previousGraph) || !continuitySourceGraphPairMatches(currentSource, currentGraph)) {
    fail("DEPENDENCY_MISMATCH", "source and graph observation receipts do not bind the same projection");
  }
  let changeResult: ExplainedContinuityChangeResult;
  try { changeResult = compareVerifiedContinuityObservationReceipts(previousGraph, currentGraph); } catch (cause) { mapComparison(cause); }
  const body = manifestBody(previousSource, previousGraph, currentSource, currentGraph, parsed.preparation, changeResult);
  return Object.freeze({ manifest: finalizeManifest(body), changeResult });
}

function parseSnapshot(value: unknown, label: string): CapsuleArtifactSnapshot {
  const record = shallowRecord(value, label, ["reference", "status", "title", "summary"], ["reference", "status"], "INVALID_MANIFEST");
  if (record.status !== "available" && record.status !== "unavailable") fail("INVALID_MANIFEST", `${label}.status is unsupported`);
  const reference = parseReference(record.reference, `${label}.reference`, "INVALID_MANIFEST");
  const title = record.title === undefined ? undefined : requiredText(record.title, `${label}.title`, "INVALID_MANIFEST");
  if (record.summary !== undefined && typeof record.summary !== "string") fail("INVALID_MANIFEST", `${label}.summary must be text`);
  const summary = record.summary as string | undefined;
  if ((title !== undefined && utf8Bytes(title) > CONTINUITY_CAPSULE_MANIFEST_LIMITS.maxSourceDisplayBytes) || (summary !== undefined && utf8Bytes(summary) > CONTINUITY_CAPSULE_MANIFEST_LIMITS.maxSourceDisplayBytes)) {
    fail("BUDGET_EXCEEDED", `${label} display text exceeds its source budget`);
  }
  return Object.freeze({ reference, status: record.status, ...(title === undefined ? {} : { title }), ...(summary === undefined ? {} : { summary }) });
}

function parseManifest(input: unknown): ContinuityCapsuleManifest {
  const record = shallowRecord(input, "capsule manifest", ["schemaVersion", "formatVersion", "authority", "thread", "previousObservedAt", "currentObservedAt", "preparedAt", "previousSourceObservationReceiptId", "previousGraphObservationReceiptId", "currentSourceObservationReceiptId", "currentGraphObservationReceiptId", "changeResultId", "stoppingPoint", "stoppingPointCurrentAvailability", "currentNextStep", "supportingEvidence", "preparedWork", "manifestId"], ["schemaVersion", "formatVersion", "authority", "thread", "previousObservedAt", "currentObservedAt", "preparedAt", "previousSourceObservationReceiptId", "previousGraphObservationReceiptId", "currentSourceObservationReceiptId", "currentGraphObservationReceiptId", "changeResultId", "stoppingPoint", "stoppingPointCurrentAvailability", "currentNextStep", "supportingEvidence", "preparedWork", "manifestId"], "INVALID_MANIFEST");
  if (record.schemaVersion !== 1 || record.formatVersion !== CONTINUITY_CAPSULE_MANIFEST_FORMAT_VERSION || record.authority !== "caller-declared-preparation") fail("INVALID_MANIFEST", "capsule manifest envelope is unsupported");
  const dependencyIds: readonly [unknown, RegExp, string][] = [
    [record.previousSourceObservationReceiptId, SOURCE_RECEIPT_ID_PATTERN, "previous source receipt ID"],
    [record.previousGraphObservationReceiptId, GRAPH_RECEIPT_ID_PATTERN, "previous graph receipt ID"],
    [record.currentSourceObservationReceiptId, SOURCE_RECEIPT_ID_PATTERN, "current source receipt ID"],
    [record.currentGraphObservationReceiptId, GRAPH_RECEIPT_ID_PATTERN, "current graph receipt ID"],
    [record.changeResultId, CHANGE_RESULT_ID_PATTERN, "change result ID"],
    [record.manifestId, MANIFEST_ID_PATTERN, "manifest ID"]
  ];
  for (const [value, pattern, label] of dependencyIds) if (typeof value !== "string" || !pattern.test(value)) fail("INVALID_MANIFEST", `${label} is invalid`);
  const threadRecord = shallowRecord(record.thread, "capsule manifest.thread", ["id", "title"], ["id", "title"], "INVALID_MANIFEST");
  const thread = Object.freeze({ id: requiredText(threadRecord.id, "thread.id", "INVALID_MANIFEST"), title: requiredText(threadRecord.title, "thread.title", "INVALID_MANIFEST") });
  if (
    utf8Bytes(thread.id) > CONTINUITY_CAPSULE_MANIFEST_LIMITS.maxSourceDisplayBytes
    || utf8Bytes(thread.title) > CONTINUITY_CAPSULE_MANIFEST_LIMITS.maxSourceDisplayBytes
  ) {
    fail("BUDGET_EXCEEDED", "capsule manifest thread display exceeds its source budget");
  }
  const previousObservedAt = canonicalInstant(record.previousObservedAt, "previousObservedAt", "INVALID_MANIFEST");
  const currentObservedAt = canonicalInstant(record.currentObservedAt, "currentObservedAt", "INVALID_MANIFEST");
  const preparedAt = canonicalInstant(record.preparedAt, "preparedAt", "INVALID_MANIFEST");
  const stoppingPoint = parseSnapshot(record.stoppingPoint, "stoppingPoint");
  const currentNextStep = parseSnapshot(record.currentNextStep, "currentNextStep");
  const rawSupporting = strictArray(record.supportingEvidence, "supportingEvidence", "INVALID_MANIFEST");
  if (rawSupporting.length > CONTINUITY_CAPSULE_MANIFEST_LIMITS.maxSupportingEvidence) fail("BUDGET_EXCEEDED", "supportingEvidence exceeds its item budget");
  const supportingEvidence = freezeArray(rawSupporting.map((entry, index) => parseSnapshot(entry, `supportingEvidence[${index}]`)));
  const preparedWork = parsePreparedWork(record.preparedWork, "INVALID_MANIFEST");
  if (record.stoppingPointCurrentAvailability !== "available" && record.stoppingPointCurrentAvailability !== "unavailable") fail("INVALID_MANIFEST", "stoppingPointCurrentAvailability is invalid");
  if (
    stoppingPoint.status !== "available"
    || currentNextStep.status !== "available"
    || supportingEvidence.some((entry) => entry.status !== "available")
  ) {
    fail("INVALID_MANIFEST", "Capsule selections must be available at their observation");
  }
  const keys = supportingEvidence.map((entry) => referenceKey(entry.reference));
  if (
    new Set(keys).size !== keys.length
    || keys.some((key, index) =>
      index > 0 && compareCanonicalText(keys[index - 1]!, key) > 0
    )
  ) {
    fail("INVALID_MANIFEST", "supportingEvidence must be sorted unique references");
  }
  if (new Date(previousObservedAt).getTime() > new Date(currentObservedAt).getTime() || preparedAt !== currentObservedAt) fail("INVALID_MANIFEST", "capsule manifest times are incoherent");
  const body: ManifestBody = Object.freeze({
    schemaVersion: 1,
    formatVersion: CONTINUITY_CAPSULE_MANIFEST_FORMAT_VERSION,
    authority: "caller-declared-preparation",
    thread,
    previousObservedAt,
    currentObservedAt,
    preparedAt,
    previousSourceObservationReceiptId: record.previousSourceObservationReceiptId as string,
    previousGraphObservationReceiptId: record.previousGraphObservationReceiptId as string,
    currentSourceObservationReceiptId: record.currentSourceObservationReceiptId as string,
    currentGraphObservationReceiptId: record.currentGraphObservationReceiptId as string,
    changeResultId: record.changeResultId as string,
    stoppingPoint,
    stoppingPointCurrentAvailability: record.stoppingPointCurrentAvailability,
    currentNextStep,
    supportingEvidence,
    preparedWork
  });
  assertManifestBytes(body, record.manifestId as string);
  if (manifestId(body) !== record.manifestId) fail("INTEGRITY_MISMATCH", "manifestId does not bind the capsule manifest");
  return Object.freeze({ ...body, manifestId: record.manifestId as string });
}

export function verifyContinuityCapsuleManifest(input: unknown): ContinuityCapsuleManifest {
  return parseManifest(input);
}

export function verifyContinuityCapsuleCompilation(input: unknown): ContinuityCapsuleCompilation {
  const record = shallowRecord(input, "capsule compilation verification input", ["manifest", "previousSourceObservationReceipt", "previousGraphObservationReceipt", "currentSourceObservationReceipt", "currentGraphObservationReceipt"], ["manifest", "previousSourceObservationReceipt", "previousGraphObservationReceipt", "currentSourceObservationReceipt", "currentGraphObservationReceipt"], "INVALID_INPUT");
  const manifest = verifyContinuityCapsuleManifest(record.manifest);
  const compilation = compileContinuityCapsuleManifest({
    schemaVersion: 1,
    previousSourceObservationReceipt: record.previousSourceObservationReceipt,
    previousGraphObservationReceipt: record.previousGraphObservationReceipt,
    currentSourceObservationReceipt: record.currentSourceObservationReceipt,
    currentGraphObservationReceipt: record.currentGraphObservationReceipt,
    preparation: {
      preparedAt: manifest.preparedAt,
      supportingEvidenceRefs: manifest.supportingEvidence.map((entry) => entry.reference),
      preparedWork: manifest.preparedWork
    }
  });
  if (canonicalJson(compilation.manifest) !== canonicalJson(manifest)) {
    fail("DEPENDENCY_MISMATCH", "manifest does not match the verified compilation dependencies");
  }
  return compilation;
}
