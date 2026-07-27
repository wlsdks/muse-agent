import { isProxy } from "node:util/types";

export const FRESHNESS_SUPERSESSION_POLICY_V2 = "muse.freshness-supersession-policy.v2" as const;
export const FRESHNESS_SUPERSESSION_DECISION_SCHEMA_V2 = "muse.freshness-supersession-decision.v2" as const;
export const FRESHNESS_SUPERSESSION_MAX_LINKS_V2 = 16;

export type FreshnessSourceAuthorityV2 = "inferred" | "trusted-import" | "user-authored";

export interface FreshnessCandidateV2 {
  readonly confidence: number | null;
  readonly identity: string;
  readonly observedAt: string | null;
  readonly sourceAuthority: FreshnessSourceAuthorityV2 | null;
}

export interface FreshnessCorrectionLinkV2 {
  readonly currentIdentity: string;
  readonly staleIdentity: string;
  readonly verification: "audited-explicit-local-relation";
}

export interface FreshnessSupersessionInputV2 {
  readonly candidates: readonly FreshnessCandidateV2[];
  readonly correctionLinks: readonly FreshnessCorrectionLinkV2[];
  readonly policyVersion: typeof FRESHNESS_SUPERSESSION_POLICY_V2;
}

export type FreshnessSupersessionReasonV2 =
  | "explicit-correction"
  | "source-authority"
  | "event-time"
  | "confidence"
  | "complete-tie";

export type FreshnessSupersessionDimensionV2 =
  | "explicit-correction"
  | "source-authority"
  | "timestamp"
  | "confidence"
  | "none";

export interface FreshnessSupersessionDecisionV2 {
  readonly schema: typeof FRESHNESS_SUPERSESSION_DECISION_SCHEMA_V2;
  readonly policyVersion: typeof FRESHNESS_SUPERSESSION_POLICY_V2;
  readonly status: "selected" | "unresolved";
  readonly selectedIdentity: string | null;
  readonly orderedIdentities: readonly string[];
  readonly reason: FreshnessSupersessionReasonV2;
  readonly decisiveDimension: FreshnessSupersessionDimensionV2;
}

export class FreshnessSupersessionInputError extends Error {
  readonly code = "RECALL_FRESHNESS_INPUT_INVALID" as const;

  constructor() {
    super("Freshness supersession input is invalid.");
    this.name = "FreshnessSupersessionInputError";
    this.stack = "FreshnessSupersessionInputError: Freshness supersession input is invalid.";
  }
}

const AUTHORITY_RANK: Readonly<Record<FreshnessSourceAuthorityV2, number>> = Object.freeze({
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

function parseCandidate(value: unknown): FreshnessCandidateV2 {
  const data = exactDataRecord(value, CANDIDATE_KEYS);
  if (
    !validIdentity(data.identity)
    || (data.observedAt !== null && !canonicalTimestamp(data.observedAt))
    || (
      data.confidence !== null
      && (
        typeof data.confidence !== "number"
        || !Number.isFinite(data.confidence)
        || data.confidence < 0
        || data.confidence > 1
      )
    )
    || (
      data.sourceAuthority !== null
      && data.sourceAuthority !== "inferred"
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
  winner: FreshnessCandidateV2,
  loser: FreshnessCandidateV2,
  reason: Exclude<FreshnessSupersessionReasonV2, "complete-tie">,
  decisiveDimension: Exclude<FreshnessSupersessionDimensionV2, "none">
): FreshnessSupersessionDecisionV2 {
  return Object.freeze({
    decisiveDimension,
    orderedIdentities: Object.freeze([winner.identity, loser.identity]),
    policyVersion: FRESHNESS_SUPERSESSION_POLICY_V2,
    reason,
    schema: FRESHNESS_SUPERSESSION_DECISION_SCHEMA_V2,
    selectedIdentity: winner.identity,
    status: "selected"
  });
}

/**
 * V2 precedence is intentionally conservative:
 * verified explicit correction > epistemic source authority > confidence
 * > event timestamp. A complete tie remains unresolved instead of promoting an
 * arbitrary fact by input/import order. Unknown evidence is represented as
 * `null`; a dimension participates only when both candidates provide it.
 */
export function reduceFreshnessSupersessionV2(input: FreshnessSupersessionInputV2): FreshnessSupersessionDecisionV2 {
  try {
    return reduceFreshnessSupersessionV2Unchecked(input);
  } catch {
    return invalid();
  }
}

function reduceFreshnessSupersessionV2Unchecked(input: unknown): FreshnessSupersessionDecisionV2 {
  const data = exactDataRecord(input, INPUT_KEYS);
  if (data.policyVersion !== FRESHNESS_SUPERSESSION_POLICY_V2) return invalid();
  const candidates = exactDataArray(data.candidates, 2, 2).map(parseCandidate);
  const links = exactDataArray(data.correctionLinks, FRESHNESS_SUPERSESSION_MAX_LINKS_V2);
  if (candidates[0]!.identity === candidates[1]!.identity) return invalid();
  const byIdentity = new Map(candidates.map((candidate) => [candidate.identity, candidate]));
  const uniqueLinks = new Map<string, FreshnessCorrectionLinkV2>();
  for (const value of links) {
    const link = exactDataRecord(value, LINK_KEYS);
    const { currentIdentity, staleIdentity, verification } = link;
    if (
      !validIdentity(currentIdentity)
      || !validIdentity(staleIdentity)
      || verification !== "audited-explicit-local-relation"
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
  const [left, right] = ordered as [FreshnessCandidateV2, FreshnessCandidateV2];
  const authorityDelta = left.sourceAuthority !== null && right.sourceAuthority !== null
    ? AUTHORITY_RANK[left.sourceAuthority] - AUTHORITY_RANK[right.sourceAuthority]
    : 0;
  if (left.sourceAuthority !== null && right.sourceAuthority !== null && authorityDelta !== 0) {
    return authorityDelta > 0
      ? selected(left, right, "source-authority", "source-authority")
      : selected(right, left, "source-authority", "source-authority");
  }
  const confidenceDelta = left.confidence !== null && right.confidence !== null
    ? left.confidence - right.confidence
    : 0;
  if (left.confidence !== null && right.confidence !== null && confidenceDelta !== 0) {
    return confidenceDelta > 0
      ? selected(left, right, "confidence", "confidence")
      : selected(right, left, "confidence", "confidence");
  }
  const timeDelta = left.observedAt !== null && right.observedAt !== null
    ? Date.parse(left.observedAt) - Date.parse(right.observedAt)
    : 0;
  if (left.observedAt !== null && right.observedAt !== null && timeDelta !== 0) {
    return timeDelta > 0
      ? selected(left, right, "event-time", "timestamp")
      : selected(right, left, "event-time", "timestamp");
  }
  return Object.freeze({
    decisiveDimension: "none",
    orderedIdentities: Object.freeze(ordered.map((candidate) => candidate.identity)),
    policyVersion: FRESHNESS_SUPERSESSION_POLICY_V2,
    reason: "complete-tie",
    schema: FRESHNESS_SUPERSESSION_DECISION_SCHEMA_V2,
    selectedIdentity: null,
    status: "unresolved"
  });
}
