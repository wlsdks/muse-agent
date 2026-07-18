import { createHash } from "node:crypto";

import type {
  AttunementState,
  ContinuityInteractionAnchor,
  ContinuityInteractionReceipt,
  ContinuityEvidenceClass,
  ContinuityOutcome,
  PersonalThreadKind
} from "./types.js";

const INTERACTION_STATES = ["exact", "none", "unavailable"] as const;
type ContinuityInteractionState = (typeof INTERACTION_STATES)[number];

export const CONTINUITY_INTERACTION_EXACT_PER_KIND = 10;
export const CONTINUITY_INTERACTION_DISTINCT_DATES_PER_KIND = 2;

export interface ContinuityInteractionLatencyDigest {
  readonly maxMs: number | null;
  readonly medianMs: number | null;
  readonly minMs: number | null;
  readonly p95Ms: number | null;
  readonly sampleSize: number;
}

export interface ContinuityInteractionDigestSlice {
  readonly completionLatencyMs: ContinuityInteractionLatencyDigest;
  readonly states: Readonly<Record<ContinuityInteractionState, {
    readonly count: number;
    readonly ratio: number;
  }>>;
  readonly totalDeliveries: number;
}

export interface ContinuityInteractionDigest {
  readonly byThreadKind: Readonly<Record<PersonalThreadKind, ContinuityInteractionDigestSlice>>;
  readonly overall: ContinuityInteractionDigestSlice;
}

export interface ContinuityInteractionKindAudit {
  readonly distinctUtcOpenedDates: number;
  readonly distinctUtcOpenedDatesTarget: number;
  readonly exactInteractions: number;
  readonly exactInteractionsTarget: number;
  readonly remainingDates: number;
  readonly remainingExactInteractions: number;
}

export interface ContinuityInteractionAudit {
  readonly byThreadKind: Readonly<Record<PersonalThreadKind, ContinuityInteractionKindAudit>>;
  readonly reason: string;
  readonly status: "collecting" | "audit-required";
}

export interface ContinuityInteractionReport {
  readonly audit: ContinuityInteractionAudit;
  readonly digest: ContinuityInteractionDigest;
  readonly interactions: readonly ContinuityInteractionProjectionItem[];
  readonly schemaVersion: 2;
  readonly technicalEvidence: ContinuityInteractionTechnicalEvidenceDigest;
}

export interface ContinuityInteractionTechnicalEvidenceSlice {
  readonly deliveries: Readonly<Record<ContinuityEvidenceClass, number>>;
  readonly receipts: Readonly<Record<ContinuityEvidenceClass, number>>;
  readonly states: Readonly<Record<ContinuityInteractionState, number>>;
}

export interface ContinuityInteractionTechnicalEvidenceDigest {
  readonly byThreadKind: Readonly<Record<PersonalThreadKind, ContinuityInteractionTechnicalEvidenceSlice>>;
  readonly overall: ContinuityInteractionTechnicalEvidenceSlice;
}

export interface ContinuityTaskInteractionSource {
  readonly artifactId: string;
  readonly createdAt: string;
  readonly status: "open" | "done";
  readonly updatedAt: string;
}

export type ContinuityTaskInteractionSourceResolver = (
  artifactId: string
) => Promise<ContinuityTaskInteractionSource | undefined>;

export interface ContinuityInteractionProjectionItem {
  readonly deliveryId: string;
  readonly deliveryEvidenceClass: ContinuityEvidenceClass;
  readonly explicitOutcome?: ContinuityOutcome;
  readonly interaction: {
    readonly receipt?: ContinuityInteractionReceipt;
    readonly reason?: string;
    readonly state: "exact" | "none" | "unavailable";
  };
  readonly openedAt: string;
  readonly runId?: string;
  readonly threadId: string;
  readonly threadKind: PersonalThreadKind;
}

export function fingerprintContinuityTaskState(input: {
  readonly artifactId: string;
  readonly status: "open" | "done";
  readonly updatedAt: string;
}): string {
  return createHash("sha256").update(JSON.stringify({
    artifactId: input.artifactId,
    status: input.status,
    updatedAt: input.updatedAt
  })).digest("hex");
}

/** Read-only projection. Explicit outcomes and factual interactions never collapse into one signal. */
export async function buildContinuityInteractionProjection(
  state: AttunementState,
  resolveCurrentTask: ContinuityTaskInteractionSourceResolver
): Promise<readonly ContinuityInteractionProjectionItem[]> {
  const receipts = new Map(state.interactionReceipts.map((receipt) => [receipt.deliveryId, receipt]));
  return Promise.all(state.deliveries
    .slice()
    .sort((left, right) => right.openedAt.localeCompare(left.openedAt) || left.id.localeCompare(right.id))
    .map(async (delivery): Promise<ContinuityInteractionProjectionItem> => {
      const thread = state.threads.find((entry) => entry.id === delivery.threadId);
      if (!thread) throw new Error(`delivery '${delivery.id}' references a missing personal thread`);
      const base = {
        deliveryId: delivery.id,
        deliveryEvidenceClass: delivery.evidenceClass,
        ...(delivery.outcome ? { explicitOutcome: delivery.outcome.outcome } : {}),
        openedAt: delivery.openedAt,
        ...(delivery.runId ? { runId: delivery.runId } : {}),
        threadId: delivery.threadId,
        threadKind: thread.kind
      };
      const receipt = receipts.get(delivery.id);
      if (receipt) return { ...base, interaction: { receipt, state: "exact" } };
      const anchor = delivery.interactionAnchor;
      if (!anchor || !delivery.runId) {
        return { ...base, interaction: { reason: "delivery has no interaction anchor or run id", state: "unavailable" } };
      }
      const link = thread.links.find((entry) => exactAnchorLink(entry, anchor));
      if (!link) {
        return { ...base, interaction: { reason: "exact user-authored local next-step link is unavailable", state: "unavailable" } };
      }
      try {
        const current = await resolveCurrentTask(anchor.artifactId);
        if (!current || current.artifactId !== anchor.artifactId) {
          return { ...base, interaction: { reason: "exact local task is unavailable", state: "unavailable" } };
        }
        const expectedOpenStateFingerprint = fingerprintContinuityTaskState({
          artifactId: current.artifactId,
          status: "open",
          updatedAt: current.createdAt
        });
        if (expectedOpenStateFingerprint !== anchor.openStateFingerprint) {
          return { ...base, interaction: { reason: "exact local task identity no longer matches the delivery anchor", state: "unavailable" } };
        }
        return { ...base, interaction: { state: "none" } };
      } catch {
        return { ...base, interaction: { reason: "exact local task cannot be read or validated", state: "unavailable" } };
      }
    }));
}

/** Deterministic factual summary. It never consumes outcomes or changes persisted state. */
export function buildContinuityInteractionDigest(
  interactions: readonly ContinuityInteractionProjectionItem[]
): ContinuityInteractionDigest {
  const seenDeliveryIds = new Set<string>();
  const seenReceiptEventIds = new Set<string>();
  const seenReceiptIds = new Set<string>();
  const validated = interactions.map((item) => {
    if (!nonEmpty(item.deliveryId) || !nonEmpty(item.threadId)) throw new Error("interaction identity must be non-empty");
    if (seenDeliveryIds.has(item.deliveryId)) throw new Error(`duplicate interaction delivery '${item.deliveryId}'`);
    seenDeliveryIds.add(item.deliveryId);
    if (item.threadKind !== "life" && item.threadKind !== "work") {
      throw new Error(`interaction '${item.deliveryId}' has an invalid thread kind`);
    }
    if (!INTERACTION_STATES.includes(item.interaction.state)) {
      throw new Error(`interaction '${item.deliveryId}' has an invalid state`);
    }
    const openedAt = Date.parse(item.openedAt);
    if (!Number.isFinite(openedAt)) throw new Error(`interaction '${item.deliveryId}' has invalid chronology`);
    const receipt = item.interaction.receipt;
    if (item.interaction.state !== "exact") {
      if (receipt) throw new Error(`non-exact interaction '${item.deliveryId}' unexpectedly has a receipt`);
      return { item };
    }
    if (!receipt || receipt.deliveryId !== item.deliveryId) {
      throw new Error(`exact interaction '${item.deliveryId}' requires its canonical receipt`);
    }
    if (!nonEmpty(receipt.id) || !nonEmpty(receipt.eventId) || !nonEmpty(receipt.artifactId)
      || !/^[a-f0-9]{64}$/u.test(receipt.openStateFingerprint)
      || !/^[a-f0-9]{64}$/u.test(receipt.doneStateFingerprint)
      || receipt.providerId !== "local" || receipt.role !== "next-step" || receipt.transition !== "open-to-done") {
      throw new Error(`exact interaction '${item.deliveryId}' has an invalid canonical receipt`);
    }
    if (seenReceiptIds.has(receipt.id)) throw new Error(`duplicate receipt id '${receipt.id}'`);
    if (seenReceiptEventIds.has(receipt.eventId)) throw new Error(`duplicate receipt event id '${receipt.eventId}'`);
    seenReceiptIds.add(receipt.id);
    seenReceiptEventIds.add(receipt.eventId);
    if (!item.runId || receipt.runId !== item.runId || receipt.threadId !== item.threadId) {
      throw new Error(`exact interaction '${item.deliveryId}' has contradictory receipt binding`);
    }
    const completedAt = Date.parse(receipt.completedAt);
    const linkedAt = Date.parse(receipt.linkedAt);
    const recordedAt = Date.parse(receipt.recordedAt);
    const latencyMs = completedAt - openedAt;
    if (!Number.isFinite(completedAt) || !Number.isFinite(linkedAt) || !Number.isFinite(recordedAt)
      || !Number.isSafeInteger(latencyMs) || latencyMs <= 0 || linkedAt > openedAt || recordedAt < completedAt) {
      throw new Error(`exact interaction '${item.deliveryId}' has invalid chronology`);
    }
    return { item, latencyMs };
  });

  const slice = (kind?: PersonalThreadKind): ContinuityInteractionDigestSlice => {
    const entries = kind ? validated.filter(({ item }) => item.threadKind === kind) : validated;
    const count = (state: ContinuityInteractionState): number => entries.filter(({ item }) => item.interaction.state === state).length;
    const totalDeliveries = entries.length;
    const ratio = (state: ContinuityInteractionState): number => totalDeliveries === 0 ? 0 : count(state) / totalDeliveries;
    const latencies = entries.flatMap((entry) => entry.latencyMs === undefined ? [] : [entry.latencyMs]).sort((left, right) => left - right);
    return {
      completionLatencyMs: latencyDigest(latencies),
      states: {
        exact: { count: count("exact"), ratio: ratio("exact") },
        none: { count: count("none"), ratio: ratio("none") },
        unavailable: { count: count("unavailable"), ratio: ratio("unavailable") }
      },
      totalDeliveries
    };
  };

  return {
    byThreadKind: { life: slice("life"), work: slice("work") },
    overall: slice()
  };
}

/** Numeric collection coverage only. It never certifies naturalness, usefulness, or permission. */
export function buildContinuityInteractionAudit(
  interactions: readonly ContinuityInteractionProjectionItem[]
): ContinuityInteractionAudit {
  // Reuse the canonical fail-closed evidence validation before counting any coverage.
  buildContinuityInteractionDigest(interactions);

  const slice = (kind: PersonalThreadKind): ContinuityInteractionKindAudit => {
    const exact = interactions.filter((item) =>
      item.threadKind === kind &&
      item.deliveryEvidenceClass === "organic" &&
      item.interaction.state === "exact" &&
      item.interaction.receipt?.evidenceClass === "organic"
    );
    const distinctDates = new Set(exact.map((item) => new Date(Date.parse(item.openedAt)).toISOString().slice(0, 10)));
    return {
      distinctUtcOpenedDates: distinctDates.size,
      distinctUtcOpenedDatesTarget: CONTINUITY_INTERACTION_DISTINCT_DATES_PER_KIND,
      exactInteractions: exact.length,
      exactInteractionsTarget: CONTINUITY_INTERACTION_EXACT_PER_KIND,
      remainingDates: Math.max(0, CONTINUITY_INTERACTION_DISTINCT_DATES_PER_KIND - distinctDates.size),
      remainingExactInteractions: Math.max(0, CONTINUITY_INTERACTION_EXACT_PER_KIND - exact.length)
    };
  };
  const byThreadKind = { life: slice("life"), work: slice("work") };
  const complete = Object.values(byThreadKind).every((entry) =>
    entry.remainingDates === 0 && entry.remainingExactInteractions === 0);
  return complete
    ? {
        byThreadKind,
        reason: "Numeric interaction coverage is complete; human audit is still required for natural timing, usefulness, causality, and permission.",
        status: "audit-required"
      }
    : {
        byThreadKind,
        reason: "Continue collecting canonical exact interactions across both life and work dates; numeric coverage does not grant permission.",
        status: "collecting"
      };
}

export async function buildContinuityInteractionReport(
  state: AttunementState,
  resolveCurrentTask: ContinuityTaskInteractionSourceResolver
): Promise<ContinuityInteractionReport> {
  const interactions = await buildContinuityInteractionProjection(state, resolveCurrentTask);
  const naturalInteractions = interactions.filter((item) =>
    item.deliveryEvidenceClass === "organic" &&
    (item.interaction.state !== "exact" || item.interaction.receipt?.evidenceClass === "organic")
  );
  return {
    audit: buildContinuityInteractionAudit(naturalInteractions),
    digest: buildContinuityInteractionDigest(naturalInteractions),
    interactions,
    schemaVersion: 2,
    technicalEvidence: buildInteractionTechnicalEvidence(interactions)
  };
}

function buildInteractionTechnicalEvidence(
  interactions: readonly ContinuityInteractionProjectionItem[]
): ContinuityInteractionTechnicalEvidenceDigest {
  const classes: readonly ContinuityEvidenceClass[] = ["organic", "controlled", "unclassified"];
  const slice = (kind?: PersonalThreadKind): ContinuityInteractionTechnicalEvidenceSlice => {
    const entries = kind ? interactions.filter((item) => item.threadKind === kind) : interactions;
    const deliveries = { controlled: 0, organic: 0, unclassified: 0 };
    const receipts = { controlled: 0, organic: 0, unclassified: 0 };
    const states = { exact: 0, none: 0, unavailable: 0 };
    for (const item of entries) {
      deliveries[item.deliveryEvidenceClass] += 1;
      states[item.interaction.state] += 1;
      const receiptClass = item.interaction.receipt?.evidenceClass;
      if (receiptClass) receipts[receiptClass] += 1;
    }
    return {
      deliveries: Object.fromEntries(classes.map((value) => [value, deliveries[value]])) as Record<ContinuityEvidenceClass, number>,
      receipts: Object.fromEntries(classes.map((value) => [value, receipts[value]])) as Record<ContinuityEvidenceClass, number>,
      states
    };
  };
  return { byThreadKind: { life: slice("life"), work: slice("work") }, overall: slice() };
}

function latencyDigest(sorted: readonly number[]): ContinuityInteractionLatencyDigest {
  if (sorted.length === 0) {
    return { maxMs: null, medianMs: null, minMs: null, p95Ms: null, sampleSize: 0 };
  }
  const nearestRank = (percentile: number): number => sorted[Math.ceil(percentile * sorted.length) - 1]!;
  return {
    maxMs: sorted[sorted.length - 1]!,
    medianMs: nearestRank(0.5),
    minMs: sorted[0]!,
    p95Ms: nearestRank(0.95),
    sampleSize: sorted.length
  };
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function exactAnchorLink(
  link: AttunementState["threads"][number]["links"][number],
  anchor: ContinuityInteractionAnchor
): boolean {
  return link.artifactId === anchor.artifactId
    && link.artifactType === "task"
    && link.linkedAt === anchor.linkedAt
    && link.linkedBy === "user"
    && link.providerId === "local"
    && link.role === "next-step";
}
