/**
 * Provider-neutral personal-continuity domain. These records deliberately hold
 * links and receipts, not copied notes or inferred life facts: the user chooses
 * the thread and the exact local source, while adapters resolve it at display
 * time.
 */

export const THREAD_KINDS = ["life", "work"] as const;
export type PersonalThreadKind = (typeof THREAD_KINDS)[number];

export const ARTIFACT_TYPES = ["task", "note", "reminder", "calendar-event", "contact", "run", "checkpoint", "browsing-visit", "conversation", "work", "resource"] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

const CANONICAL_BROWSING_VISIT_ID = /^[1-9][0-9]{0,19}-[0-9a-f]{8}$/u;

export function isCanonicalBrowsingVisitId(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_BROWSING_VISIT_ID.test(value);
}

/**
 * A source provider id. `"local"` backs Muse-owned exact sources,
 * `calendar:<provider>` one configured calendar adapter, and `mcp:<server>` a
 * resource read at display time from a connected external MCP server. The
 * string is deliberately narrow: an unknown/malformed provider id is rejected
 * fail-close so a corrupt store never silently loads.
 */
export type ArtifactProviderId = string;

const MCP_PROVIDER_PATTERN = /^mcp:[A-Za-z0-9._-]+$/u;
const CALENDAR_PROVIDER_PATTERN = /^calendar:[A-Za-z0-9._-]+$/u;

/** `"local"`, `calendar:<provider>`, or `mcp:<server>` with a narrow suffix alphabet. */
export function isValidProviderId(value: unknown): value is ArtifactProviderId {
  return value === "local" || (typeof value === "string"
    && (MCP_PROVIDER_PATTERN.test(value) || CALENDAR_PROVIDER_PATTERN.test(value)));
}

/** Build the canonical provider id for an external MCP server. */
export function mcpProviderId(server: string): string {
  return `mcp:${server}`;
}

/** Build the canonical persisted provider id for one configured calendar adapter. */
export function calendarProviderId(providerId: string): string {
  return `calendar:${providerId}`;
}

/**
 * Provider/type coherence (the grounding invariant): resources are external,
 * calendar events name their configured adapter, and every other exact source
 * is Muse-local. Enforced at parse and link time so boundaries cannot cross.
 */
export function isCoherentArtifactProvider(artifactType: ArtifactType, providerId: string): boolean {
  if (artifactType === "resource") return MCP_PROVIDER_PATTERN.test(providerId);
  if (artifactType === "calendar-event") return CALENDAR_PROVIDER_PATTERN.test(providerId);
  return providerId === "local";
}

export const ARTIFACT_ROLES = ["context", "next-step"] as const;
export type ArtifactRole = (typeof ARTIFACT_ROLES)[number];

export const OUTCOMES = ["used", "adjusted", "ignored", "rejected"] as const;
export type ContinuityOutcome = (typeof OUTCOMES)[number];
export type { ContinuityEvidenceClass } from "./evidence-provenance.js";
import type { ContinuityEvidenceClass } from "./evidence-provenance.js";

export const DETAIL_LEVELS = ["standard", "compact"] as const;
export type ContinuityDetailLevel = (typeof DETAIL_LEVELS)[number];

export const NEXT_STEP_PRESENTATIONS = ["direct", "contextual", "hidden"] as const;
export type NextStepPresentation = (typeof NEXT_STEP_PRESENTATIONS)[number];

export const SUPPRESSION_MODES = ["none", "acknowledge-previous"] as const;
export type ContinuitySuppression = (typeof SUPPRESSION_MODES)[number];

export interface ArtifactReference {
  readonly artifactId: string;
  readonly artifactType: ArtifactType;
  readonly providerId: ArtifactProviderId;
  readonly role: ArtifactRole;
}

/** A user-authored, canonical reference; Slice A does not auto-link artifacts. */
export interface ArtifactLink extends ArtifactReference {
  readonly linkedAt: string;
  readonly linkedBy: "user";
  readonly threadId: string;
}

/** The only policy fields an outcome reducer may change. */
export interface ContinuityPolicyPresentation {
  readonly detail: ContinuityDetailLevel;
  readonly nextStep: NextStepPresentation;
  readonly suppression: ContinuitySuppression;
}

/** Version is concurrency/audit metadata, not an adaptive policy field. */
export interface ContinuityPolicy extends ContinuityPolicyPresentation {
  readonly version: number;
}

export interface PersonalThread {
  readonly createdAt: string;
  readonly id: string;
  readonly kind: PersonalThreadKind;
  readonly links: readonly ArtifactLink[];
  readonly policy: ContinuityPolicy;
  readonly title: string;
}

export interface ContinuityOutcomeRecord {
  readonly evidenceClass: ContinuityEvidenceClass;
  readonly outcome: ContinuityOutcome;
  readonly policyVersion: number;
  readonly recordedAt: string;
}

/** Immutable proof that a delivery observed one exact user-linked local task as open. */
export interface ContinuityInteractionAnchor {
  readonly artifactId: string;
  readonly linkedAt: string;
  readonly observedAt: string;
  readonly observedStatus: "open";
  readonly openStateFingerprint: string;
  readonly providerId: "local";
  readonly role: "next-step";
}

/** Factual local interaction evidence. It is deliberately not a usefulness outcome. */
export interface ContinuityInteractionReceipt {
  readonly artifactId: string;
  readonly completedAt: string;
  readonly deliveryId: string;
  readonly doneStateFingerprint: string;
  readonly eventId: string;
  readonly evidenceClass: ContinuityEvidenceClass;
  readonly id: string;
  readonly linkedAt: string;
  readonly openStateFingerprint: string;
  readonly providerId: "local";
  readonly recordedAt: string;
  readonly role: "next-step";
  readonly runId: string;
  readonly threadId: string;
  readonly transition: "open-to-done";
}

/** A delivery is opened before feedback; its outcome can be recorded once. */
export interface ContinuityDelivery {
  readonly evidenceClass: ContinuityEvidenceClass;
  readonly evidenceRefs: readonly ArtifactReference[];
  readonly id: string;
  readonly interactionAnchor?: ContinuityInteractionAnchor;
  readonly openedAt: string;
  readonly outcome?: ContinuityOutcomeRecord;
  readonly policyVersion: number;
  /** Stable correlation id for this delivery's local Continuity audit trail. */
  readonly runId?: string;
  readonly threadId: string;
}

/** Immutable record of a reset. It is never altered by an undo. */
export interface PolicyResetReceipt {
  readonly basePolicyVersion: number;
  readonly beforePolicy: ContinuityPolicy;
  readonly id: string;
  readonly resetPolicyVersion: number;
  readonly threadId: string;
}

/** Immutable record of a successful reset undo. */
export interface UndoResetReceipt {
  readonly id: string;
  readonly previousPolicyVersion: number;
  readonly resetId: string;
  readonly restoredPolicy: ContinuityPolicy;
  readonly threadId: string;
  readonly undoneAt: string;
  readonly undoPolicyVersion: number;
}

export interface AttunementState {
  readonly deliveries: readonly ContinuityDelivery[];
  readonly interactionReceipts: readonly ContinuityInteractionReceipt[];
  /** The next globally monotonic policy version. Initial thread policies use 0. */
  readonly nextPolicyVersion: number;
  readonly resetReceipts: readonly PolicyResetReceipt[];
  readonly schemaVersion: 11;
  readonly threads: readonly PersonalThread[];
  readonly undoResetReceipts: readonly UndoResetReceipt[];
}

/** An adapter-resolved artifact. The core never asks an adapter to search. */
export interface ResolvedArtifact extends ArtifactReference {
  readonly browsingUrl?: string;
  readonly browsingVisitedAt?: string;
  readonly conversationLastOwnerPrompt?: string;
  readonly conversationOrigin?: "cli" | "web";
  readonly conversationUpdatedAt?: string;
  readonly calendarAllDay?: boolean;
  readonly calendarEndsAt?: string;
  readonly calendarLocation?: string;
  readonly calendarStartsAt?: string;
  readonly calendarTimeState?: "upcoming" | "happening" | "ended";
  readonly contactBirthday?: string;
  readonly contactRelationship?: string;
  readonly checkpointPhase?: "start" | "act" | "failed" | "complete";
  readonly checkpointRecordedAt?: string;
  readonly checkpointStep?: number;
  readonly reminderDueAt?: string;
  /** Display-only temporal state for a pending reminder. */
  readonly reminderDueState?: "due" | "overdue";
  readonly reminderStatus?: "pending" | "fired";
  readonly runOutcome?: "abstain" | "grounded" | "misgrounded" | "contested" | "ungrounded" | "error" | null;
  readonly runRecordedAt?: string;
  readonly runSuccess?: boolean | null;
  readonly runToolNames?: readonly string[];
  readonly summary?: string;
  readonly taskDueAt?: string;
  /** Display-only temporal state derived once by Continuity preparation. */
  readonly taskDueState?: "due" | "overdue";
  readonly title: string;
  readonly taskStatus?: "open" | "done";
  readonly taskTags?: readonly string[];
  readonly updatedAt?: string;
  readonly workBoardTaskCount?: number;
  readonly workFlowCount?: number;
  readonly workOutcomeCount?: number;
  readonly workStatus?: "active" | "paused" | "done";
  readonly workUpdatedAt?: string;
}

export interface ContinuityEvidence {
  readonly artifact?: ResolvedArtifact;
  readonly reference: ArtifactReference;
  readonly status: "available" | "unavailable";
}

export interface ContinuityPack {
  readonly deliveryPolicyVersion: number;
  readonly evidence: readonly ContinuityEvidence[];
  readonly evidenceRefs: readonly ArtifactReference[];
  readonly interactionAnchor?: Omit<ContinuityInteractionAnchor, "observedAt">;
  readonly nextStep?: ResolvedArtifact;
  readonly policy: ContinuityPolicy;
  readonly previousOutcome?: ContinuityOutcome;
  readonly thread: Pick<PersonalThread, "id" | "kind" | "title">;
}

export type ExactArtifactResolver = (link: ArtifactLink) => Promise<ResolvedArtifact | undefined>;
