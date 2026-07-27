import { isProxy } from "node:util/types";

export const FRESHNESS_SUPERSESSION_POLICY_V1 = "muse.freshness-supersession-policy.v1" as const;
export const FRESHNESS_SUPERSESSION_DECISION_SCHEMA_V1 = "muse.freshness-supersession-decision.v1" as const;
export const FRESHNESS_SUPERSESSION_MAX_LINKS_V1 = 16;

export type FreshnessSourceAuthorityV1 = "inferred" | "trusted-import" | "user-authored";

export interface FreshnessCandidateV1 {
  readonly confidence: number;
  readonly identity: string;
  readonly observedAt: string;
  readonly sourceAuthority: FreshnessSourceAuthorityV1;
}

export interface FreshnessCorrectionLinkV1 {
  readonly currentIdentity: string;
  readonly staleIdentity: string;
  readonly verification: "user-authored";
}

export interface FreshnessSupersessionInputV1 {
  readonly candidates: readonly FreshnessCandidateV1[];
  readonly correctionLinks: readonly FreshnessCorrectionLinkV1[];
  readonly policyVersion: typeof FRESHNESS_SUPERSESSION_POLICY_V1;
}

export type FreshnessSupersessionReasonV1 =
  | "explicit-correction"
  | "source-authority"
  | "event-time"
  | "confidence"
  | "complete-tie";

export type FreshnessSupersessionDimensionV1 =
  | "explicit-correction"
  | "source-authority"
  | "timestamp"
  | "confidence"
  | "none";

export interface FreshnessSupersessionDecisionV1 {
  readonly schema: typeof FRESHNESS_SUPERSESSION_DECISION_SCHEMA_V1;
  readonly policyVersion: typeof FRESHNESS_SUPERSESSION_POLICY_V1;
  readonly status: "selected" | "unresolved";
  readonly selectedIdentity: string | null;
  readonly orderedIdentities: readonly string[];
  readonly reason: FreshnessSupersessionReasonV1;
  readonly decisiveDimension: FreshnessSupersessionDimensionV1;
}

export class FreshnessSupersessionInputError extends Error {
  readonly code = "RECALL_FRESHNESS_INPUT_INVALID" as const;

  constructor() {
    super("Freshness supersession input is invalid.");
    this.name = "FreshnessSupersessionInputError";
    this.stack = "FreshnessSupersessionInputError: Freshness supersession input is invalid.";
  }
}

const AUTHORITY_RANK: Readonly<Record<FreshnessSourceAuthorityV1, number>> = Object.freeze({
  inferred: 0,
  "trusted-import": 1,
  "user-authored": 2
});
const INPUT_KEYS = Object.freeze(["candidates", "correctionLinks", "policyVersion"] as const);
const CANDIDATE_KEYS = Object.freeze(["confidence", "identity", "observedAt", "sourceAuthority"] as const);
const LINK_KEYS = Object.freeze(["currentIdentity", "staleIdentity", "verification"] as const);
const IDENTITY_RE = /^[a-z0-9](?:[a-z0-9._:-]{0,127})$/u;

function invalid(): never {
  throw new FreshnessSupersessionInputError();
}

function exactDataRecord(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || isProxy(value)
  ) return invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return invalid();
  const expected = [...keys].sort();
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== expected.length
    || ownKeys.some((key) => typeof key !== "string")
    || ownKeys.map(String).sort().some((key, index) => key !== expected[index])
  ) return invalid();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) return invalid();
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}

function exactDataArray(value: unknown, maximumLength: number, exactLength?: number): readonly unknown[] {
  if (!Array.isArray(value) || isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) return invalid();
  const length = value.length;
  if (
    !Number.isSafeInteger(length)
    || length > maximumLength
    || (exactLength !== undefined && length !== exactLength)
  ) return invalid();
  const ownKeys = Reflect.ownKeys(value);
  const expectedKeys = [...Array.from({ length }, (_item, index) => String(index)), "length"];
  if (
    ownKeys.length !== expectedKeys.length
    || ownKeys.some((key) => typeof key !== "string")
    || ownKeys.map(String).sort().some((key, index) => key !== [...expectedKeys].sort()[index])
  ) return invalid();
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) return invalid();
    result.push(descriptor.value);
  }
  return Object.freeze(result);
}

function validIdentity(value: unknown): value is string {
  return typeof value === "string" && IDENTITY_RE.test(value);
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value;
}

function parseCandidate(value: unknown): FreshnessCandidateV1 {
  const data = exactDataRecord(value, CANDIDATE_KEYS);
  if (
    !validIdentity(data.identity)
    || !canonicalTimestamp(data.observedAt)
    || typeof data.confidence !== "number"
    || !Number.isFinite(data.confidence)
    || data.confidence < 0
    || data.confidence > 1
    || (
      data.sourceAuthority !== "inferred"
      && data.sourceAuthority !== "trusted-import"
      && data.sourceAuthority !== "user-authored"
    )
  ) return invalid();
  return Object.freeze({
    confidence: data.confidence,
    identity: data.identity,
    observedAt: data.observedAt,
    sourceAuthority: data.sourceAuthority
  });
}

function selected(
  winner: FreshnessCandidateV1,
  loser: FreshnessCandidateV1,
  reason: Exclude<FreshnessSupersessionReasonV1, "complete-tie">,
  decisiveDimension: Exclude<FreshnessSupersessionDimensionV1, "none">
): FreshnessSupersessionDecisionV1 {
  return Object.freeze({
    decisiveDimension,
    orderedIdentities: Object.freeze([winner.identity, loser.identity]),
    policyVersion: FRESHNESS_SUPERSESSION_POLICY_V1,
    reason,
    schema: FRESHNESS_SUPERSESSION_DECISION_SCHEMA_V1,
    selectedIdentity: winner.identity,
    status: "selected"
  });
}

/**
 * V1 precedence is intentionally conservative:
 * verified explicit correction > epistemic source authority > confidence
 * > event timestamp. A complete tie remains unresolved instead of promoting an
 * arbitrary fact by input/import order.
 */
export function reduceFreshnessSupersessionV1(input: FreshnessSupersessionInputV1): FreshnessSupersessionDecisionV1 {
  try {
    return reduceFreshnessSupersessionV1Unchecked(input);
  } catch {
    return invalid();
  }
}

function reduceFreshnessSupersessionV1Unchecked(input: unknown): FreshnessSupersessionDecisionV1 {
  const data = exactDataRecord(input, INPUT_KEYS);
  if (data.policyVersion !== FRESHNESS_SUPERSESSION_POLICY_V1) return invalid();
  const candidates = exactDataArray(data.candidates, 2, 2).map(parseCandidate);
  const links = exactDataArray(data.correctionLinks, FRESHNESS_SUPERSESSION_MAX_LINKS_V1);
  if (candidates[0]!.identity === candidates[1]!.identity) return invalid();
  const byIdentity = new Map(candidates.map((candidate) => [candidate.identity, candidate]));
  const uniqueLinks = new Map<string, FreshnessCorrectionLinkV1>();
  for (const value of links) {
    const link = exactDataRecord(value, LINK_KEYS);
    const { currentIdentity, staleIdentity, verification } = link;
    if (
      !validIdentity(currentIdentity)
      || !validIdentity(staleIdentity)
      || verification !== "user-authored"
      || currentIdentity === staleIdentity
      || !byIdentity.has(currentIdentity)
      || !byIdentity.has(staleIdentity)
    ) return invalid();
    uniqueLinks.set(`${currentIdentity}\0${staleIdentity}`, Object.freeze({ currentIdentity, staleIdentity, verification }));
  }
  if (uniqueLinks.size > 1) return invalid();
  const explicit = [...uniqueLinks.values()][0];
  if (explicit) {
    return selected(
      byIdentity.get(explicit.currentIdentity)!,
      byIdentity.get(explicit.staleIdentity)!,
      "explicit-correction",
      "explicit-correction"
    );
  }

  const ordered = [...candidates].sort((left, right) => left.identity < right.identity ? -1 : left.identity > right.identity ? 1 : 0);
  const [left, right] = ordered as [FreshnessCandidateV1, FreshnessCandidateV1];
  const authorityDelta = AUTHORITY_RANK[left.sourceAuthority] - AUTHORITY_RANK[right.sourceAuthority];
  if (authorityDelta !== 0) {
    return authorityDelta > 0
      ? selected(left, right, "source-authority", "source-authority")
      : selected(right, left, "source-authority", "source-authority");
  }
  const confidenceDelta = left.confidence - right.confidence;
  if (confidenceDelta !== 0) {
    return confidenceDelta > 0
      ? selected(left, right, "confidence", "confidence")
      : selected(right, left, "confidence", "confidence");
  }
  const timeDelta = Date.parse(left.observedAt) - Date.parse(right.observedAt);
  if (timeDelta !== 0) {
    return timeDelta > 0
      ? selected(left, right, "event-time", "timestamp")
      : selected(right, left, "event-time", "timestamp");
  }
  return Object.freeze({
    decisiveDimension: "none",
    orderedIdentities: Object.freeze(ordered.map((candidate) => candidate.identity)),
    policyVersion: FRESHNESS_SUPERSESSION_POLICY_V1,
    reason: "complete-tie",
    schema: FRESHNESS_SUPERSESSION_DECISION_SCHEMA_V1,
    selectedIdentity: null,
    status: "unresolved"
  });
}
