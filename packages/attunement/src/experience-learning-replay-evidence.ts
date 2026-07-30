import { sha256Hex } from "@muse/shared";

import type { ExperienceLearningCandidate } from "./experience-learning-candidate.js";
import {
  compareExperienceLearningReplay,
  type ExperienceLearningReplay
} from "./experience-learning-replay.js";

export interface ExperienceReplayEvidenceReceipt {
  readonly caseId: string;
  readonly evaluator: {
    readonly id: string;
    readonly version: string;
  };
  readonly evidenceHash: string;
  readonly inputHash: string;
  readonly observedAt: string;
  readonly passed: boolean;
  readonly schemaVersion: 1;
  readonly variant: "baseline" | "challenger";
}

export interface ExperienceReplayEvidenceCase {
  readonly baseline: ExperienceReplayEvidenceReceipt;
  readonly caseId: string;
  readonly challenger: ExperienceReplayEvidenceReceipt;
}

export interface ExperienceLearningReplayBundle {
  readonly bundleId: string;
  readonly candidateId: string;
  readonly cases: readonly ExperienceReplayEvidenceCase[];
  readonly replay: ExperienceLearningReplay;
  readonly schemaVersion: 1;
  readonly status: "frozen";
}

export interface CreateExperienceReplayEvidenceInput {
  readonly caseId: string;
  readonly evaluator: {
    readonly id: string;
    readonly version: string;
  };
  readonly inputHash: string;
  readonly observedAt: string;
  readonly passed: boolean;
  readonly variant: "baseline" | "challenger";
}

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_EVALUATOR_VERSION_LENGTH = 64;

export function createExperienceReplayEvidenceReceipt(
  input: CreateExperienceReplayEvidenceInput
): ExperienceReplayEvidenceReceipt | undefined {
  if (!isExactRecord(input, [
    "caseId",
    "evaluator",
    "inputHash",
    "observedAt",
    "passed",
    "variant"
  ])
    || !isExactRecord(input.evaluator, ["id", "version"])
    || typeof input.caseId !== "string"
    || !SAFE_ID.test(input.caseId)
    || typeof input.evaluator.id !== "string"
    || !SAFE_ID.test(input.evaluator.id)
    || typeof input.evaluator.version !== "string"
    || input.evaluator.version.length === 0
    || input.evaluator.version.length > MAX_EVALUATOR_VERSION_LENGTH
    || !SHA256.test(input.inputHash)
    || !isCanonicalIso(input.observedAt)
    || typeof input.passed !== "boolean"
    || (input.variant !== "baseline" && input.variant !== "challenger")) {
    return undefined;
  }
  const core = {
    caseId: input.caseId,
    evaluator: Object.freeze({ ...input.evaluator }),
    inputHash: input.inputHash,
    observedAt: input.observedAt,
    passed: input.passed,
    schemaVersion: 1 as const,
    variant: input.variant
  };
  return Object.freeze({
    ...core,
    evidenceHash: sha256Hex(JSON.stringify(core))
  });
}

/**
 * Parses serialized replay evidence as data only. Unknown fields, accessors,
 * sparse arrays, drifted hashes, and non-comparable baseline/challenger pairs
 * fail closed.
 */
export function parseExperienceReplayEvidenceCases(
  value: unknown
): readonly ExperienceReplayEvidenceCase[] | undefined {
  if (!hasExactDenseDataArray(value) || value.length === 0) {
    return undefined;
  }
  const seen = new Set<string>();
  const parsed: ExperienceReplayEvidenceCase[] = [];
  for (const entry of value) {
    if (!isExactRecord(entry, ["baseline", "caseId", "challenger"])
      || typeof entry.caseId !== "string"
      || seen.has(entry.caseId)) {
      return undefined;
    }
    const baseline = parseEvidenceReceipt(entry.baseline, "baseline");
    const challenger = parseEvidenceReceipt(entry.challenger, "challenger");
    if (!baseline
      || !challenger
      || entry.caseId !== baseline.caseId
      || entry.caseId !== challenger.caseId
      || baseline.inputHash !== challenger.inputHash
      || baseline.evaluator.id !== challenger.evaluator.id
      || baseline.evaluator.version !== challenger.evaluator.version) {
      return undefined;
    }
    seen.add(entry.caseId);
    parsed.push(Object.freeze({ baseline, caseId: entry.caseId, challenger }));
  }
  parsed.sort((left, right) => left.caseId.localeCompare(right.caseId));
  return Object.freeze(parsed);
}

export function buildExperienceLearningReplayBundle(
  candidate: ExperienceLearningCandidate,
  evidenceCases: unknown
): ExperienceLearningReplayBundle | undefined {
  const cases = parseExperienceReplayEvidenceCases(evidenceCases);
  if (!cases) return undefined;
  const replay = compareExperienceLearningReplay(candidate, cases.map((entry) => ({
    baseline: { evidenceHash: entry.baseline.evidenceHash, passed: entry.baseline.passed },
    caseId: entry.caseId,
    challenger: { evidenceHash: entry.challenger.evidenceHash, passed: entry.challenger.passed }
  })));
  if (!replay) return undefined;
  const core = {
    candidateId: candidate.candidateId,
    cases,
    replay,
    schemaVersion: 1 as const,
    status: "frozen" as const
  };
  return Object.freeze({
    ...core,
    bundleId: sha256Hex(JSON.stringify(core))
  });
}

function parseEvidenceReceipt(
  value: unknown,
  expectedVariant: ExperienceReplayEvidenceReceipt["variant"]
): ExperienceReplayEvidenceReceipt | undefined {
  if (!isExactRecord(value, [
    "caseId",
    "evaluator",
    "evidenceHash",
    "inputHash",
    "observedAt",
    "passed",
    "schemaVersion",
    "variant"
  ])
    || !isExactRecord(value.evaluator, ["id", "version"])
    || typeof value.caseId !== "string"
    || typeof value.evaluator.id !== "string"
    || typeof value.evaluator.version !== "string"
    || typeof value.inputHash !== "string"
    || typeof value.observedAt !== "string"
    || typeof value.passed !== "boolean"
    || value.schemaVersion !== 1
    || value.variant !== expectedVariant) {
    return undefined;
  }
  const rebuilt = createExperienceReplayEvidenceReceipt({
    caseId: value.caseId,
    evaluator: { id: value.evaluator.id, version: value.evaluator.version },
    inputHash: value.inputHash,
    observedAt: value.observedAt,
    passed: value.passed,
    variant: expectedVariant
  });
  return rebuilt && rebuilt.evidenceHash === value.evidenceHash ? rebuilt : undefined;
}

function isCanonicalIso(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isExactRecord(
  value: unknown,
  fields: readonly string[]
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Object.getPrototypeOf(value) !== Object.prototype) {
    return false;
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length
    || keys.some((key) => typeof key !== "string" || !fields.includes(key))) {
    return false;
  }
  return fields.every((field) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    return descriptor !== undefined
      && Object.hasOwn(descriptor, "value")
      && descriptor.get === undefined
      && descriptor.set === undefined
      && descriptor.enumerable === true;
  });
}

function hasExactDenseDataArray(value: unknown): value is readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false;
  const expectedKeys = [
    ...Array.from({ length: value.length }, (_unused, index) => String(index)),
    "length"
  ];
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expectedKeys.length
    || keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))) {
    return false;
  }
  return expectedKeys.slice(0, -1).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined
      && Object.hasOwn(descriptor, "value")
      && descriptor.get === undefined
      && descriptor.set === undefined
      && descriptor.enumerable === true;
  });
}
