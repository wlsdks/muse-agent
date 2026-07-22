import { isRecord } from "./json-utils.js";

export const RUN_GROUNDING_FRESHNESS_MS = 7 * 24 * 60 * 60 * 1_000;
export const ATTUNEMENT_OUTCOME_FRESHNESS_MS = 30 * 24 * 60 * 60 * 1_000;

export type DecisionMetricClaim = "technical-diagnostic" | "personal-effectiveness" | "learning" | "autonomy";
export type DecisionMetricEvidenceClass = "organic" | "controlled" | "unclassified";
export type DecisionMetricUnit = "ratio" | "count-of-total";
export type DecisionMetricActionId = "inspect-run-grounding" | "review-continuity-feedback" | "inspect-continuity-technical-evidence";
export type DecisionMetricFreshnessStatus = "fresh" | "stale";

export type DecisionMetricSource =
  | { readonly id: "run-grounding-log"; readonly version: 1 }
  | { readonly id: "attunement-state"; readonly version: 8 };

export interface DecisionMetricInput {
  readonly actionId: DecisionMetricActionId;
  readonly claim: DecisionMetricClaim;
  readonly evidenceClass: DecisionMetricEvidenceClass;
  readonly freshness: {
    readonly asOf: string;
    readonly evaluatedAt: string;
    readonly staleAfterMs: number;
    readonly status: DecisionMetricFreshnessStatus;
  };
  readonly id: string;
  readonly schemaVersion: 1;
  readonly source: DecisionMetricSource;
  readonly value: {
    readonly denominator: number;
    readonly numerator: number;
    readonly unit: DecisionMetricUnit;
  };
  readonly window: {
    readonly endedAt: string;
    readonly startedAt: string;
  };
}

export type DecisionMetric = DecisionMetricInput;

export type DecisionMetricExclusionReason =
  | "invalid-shape"
  | "unsupported-source"
  | "invalid-value"
  | "invalid-window"
  | "invalid-freshness"
  | "incoherent-source-contract";

export type DecisionMetricAdmission =
  | { readonly kind: "admitted"; readonly metric: DecisionMetric }
  | { readonly kind: "excluded"; readonly reason: DecisionMetricExclusionReason };

const TOP_KEYS = ["actionId", "claim", "evidenceClass", "freshness", "id", "schemaVersion", "source", "value", "window"] as const;

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function canonicalInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function safeCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function source(value: unknown): DecisionMetricSource | undefined {
  if (!isRecord(value) || !exactKeys(value, ["id", "version"])) return undefined;
  if (value.id === "run-grounding-log" && value.version === 1) return { id: value.id, version: value.version };
  if (value.id === "attunement-state" && value.version === 8) return { id: value.id, version: value.version };
  return undefined;
}

function coherent(metric: DecisionMetric): boolean {
  if (metric.source.id === "run-grounding-log") {
    return metric.id === "run.grounding.failure-rate"
      && metric.claim === "technical-diagnostic"
      && metric.evidenceClass === "unclassified"
      && metric.value.unit === "ratio"
      && metric.freshness.staleAfterMs === RUN_GROUNDING_FRESHNESS_MS
      && metric.actionId === "inspect-run-grounding";
  }
  const personal = /^continuity\.first-20\.(used|rejected)\.(overall|life|work)$/u.exec(metric.id);
  if (personal) {
    return metric.claim === "personal-effectiveness"
      && metric.evidenceClass === "organic"
      && metric.value.unit === "ratio"
      && metric.freshness.staleAfterMs === ATTUNEMENT_OUTCOME_FRESHNESS_MS
      && metric.actionId === "review-continuity-feedback";
  }
  const technical = /^continuity\.technical\.(delivery|outcome)\.(organic|controlled|unclassified)\.(overall|life|work)$/u.exec(metric.id);
  return Boolean(technical)
    && metric.claim === "technical-diagnostic"
    && metric.evidenceClass === technical?.[2]
    && metric.value.unit === "count-of-total"
    && metric.freshness.staleAfterMs === ATTUNEMENT_OUTCOME_FRESHNESS_MS
    && metric.actionId === "inspect-continuity-technical-evidence";
}

/** Validate the complete source/claim/action tuple; invalid or unknown provenance is excluded, never guessed. */
export function admitDecisionMetric(input: unknown): DecisionMetricAdmission {
  if (!isRecord(input) || !exactKeys(input, TOP_KEYS) || input.schemaVersion !== 1) {
    return { kind: "excluded", reason: "invalid-shape" };
  }
  const parsedSource = source(input.source);
  if (!parsedSource) return { kind: "excluded", reason: "unsupported-source" };
  if (!isRecord(input.value) || !exactKeys(input.value, ["denominator", "numerator", "unit"])
    || !safeCount(input.value.denominator) || input.value.denominator === 0
    || !safeCount(input.value.numerator) || input.value.numerator > input.value.denominator
    || (input.value.unit !== "ratio" && input.value.unit !== "count-of-total")) {
    return { kind: "excluded", reason: "invalid-value" };
  }
  if (!isRecord(input.window) || !exactKeys(input.window, ["endedAt", "startedAt"])
    || !canonicalInstant(input.window.startedAt) || !canonicalInstant(input.window.endedAt)
    || input.window.startedAt > input.window.endedAt) {
    return { kind: "excluded", reason: "invalid-window" };
  }
  if (!isRecord(input.freshness) || !exactKeys(input.freshness, ["asOf", "evaluatedAt", "staleAfterMs", "status"])
    || !canonicalInstant(input.freshness.asOf) || !canonicalInstant(input.freshness.evaluatedAt)
    || !Number.isSafeInteger(input.freshness.staleAfterMs) || Number(input.freshness.staleAfterMs) <= 0
    || (input.freshness.status !== "fresh" && input.freshness.status !== "stale")
    || input.window.endedAt > input.freshness.asOf || input.freshness.asOf > input.freshness.evaluatedAt) {
    return { kind: "excluded", reason: "invalid-freshness" };
  }
  const expectedStatus = Date.parse(input.freshness.evaluatedAt) - Date.parse(input.freshness.asOf) <= Number(input.freshness.staleAfterMs)
    ? "fresh"
    : "stale";
  if (input.freshness.status !== expectedStatus) return { kind: "excluded", reason: "invalid-freshness" };
  if (typeof input.id !== "string"
    || !["technical-diagnostic", "personal-effectiveness", "learning", "autonomy"].includes(String(input.claim))
    || !["organic", "controlled", "unclassified"].includes(String(input.evidenceClass))
    || !["inspect-run-grounding", "review-continuity-feedback", "inspect-continuity-technical-evidence"].includes(String(input.actionId))) {
    return { kind: "excluded", reason: "invalid-shape" };
  }
  const metric = { ...input, source: parsedSource } as unknown as DecisionMetric;
  return coherent(metric)
    ? { kind: "admitted", metric }
    : { kind: "excluded", reason: "incoherent-source-contract" };
}
