/**
 * Provider-neutral personal-continuity domain. These records deliberately hold
 * links and receipts, not copied notes or inferred life facts: the user chooses
 * the thread and the exact local source, while adapters resolve it at display
 * time.
 */

export const THREAD_KINDS = ["life", "work"] as const;
export type PersonalThreadKind = (typeof THREAD_KINDS)[number];

export const ARTIFACT_TYPES = ["task", "note", "resource"] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

/**
 * A source provider id. `"local"` backs task/note artifacts read from Muse's
 * own on-disk stores; `mcp:<server>` backs a `resource` read at display time
 * from a connected external MCP server. The string is deliberately narrow: an
 * unknown/malformed provider id is rejected fail-close so a corrupt store never
 * silently loads, and only these two shapes are honoured.
 */
export type ArtifactProviderId = string;

const MCP_PROVIDER_PATTERN = /^mcp:[A-Za-z0-9._-]+$/u;

/** `"local"` or `mcp:<server>` (server = one or more of `[A-Za-z0-9._-]`). */
export function isValidProviderId(value: unknown): value is ArtifactProviderId {
  return value === "local" || (typeof value === "string" && MCP_PROVIDER_PATTERN.test(value));
}

/** Build the canonical provider id for an external MCP server. */
export function mcpProviderId(server: string): string {
  return `mcp:${server}`;
}

/**
 * Provider/type coherence (the grounding invariant): a `resource` is external
 * and MUST carry an `mcp:` provider; a `task`/`note` is Muse-local and MUST be
 * `local`. Enforced at parse and at link time so the two can never be crossed.
 */
export function isCoherentArtifactProvider(artifactType: ArtifactType, providerId: string): boolean {
  return artifactType === "resource"
    ? MCP_PROVIDER_PATTERN.test(providerId)
    : providerId === "local";
}

export const ARTIFACT_ROLES = ["context", "next-step"] as const;
export type ArtifactRole = (typeof ARTIFACT_ROLES)[number];

export const OUTCOMES = ["used", "adjusted", "ignored", "rejected"] as const;
export type ContinuityOutcome = (typeof OUTCOMES)[number];

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
  readonly outcome: ContinuityOutcome;
  readonly policyVersion: number;
  readonly recordedAt: string;
}

/** A delivery is opened before feedback; its outcome can be recorded once. */
export interface ContinuityDelivery {
  readonly evidenceRefs: readonly ArtifactReference[];
  readonly id: string;
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
  /** The next globally monotonic policy version. Initial thread policies use 0. */
  readonly nextPolicyVersion: number;
  readonly resetReceipts: readonly PolicyResetReceipt[];
  readonly schemaVersion: 1;
  readonly threads: readonly PersonalThread[];
  readonly undoResetReceipts: readonly UndoResetReceipt[];
}

/** An adapter-resolved artifact. The core never asks an adapter to search. */
export interface ResolvedArtifact extends ArtifactReference {
  readonly summary?: string;
  readonly title: string;
  readonly taskStatus?: "open" | "done";
  readonly updatedAt?: string;
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
  readonly nextStep?: ResolvedArtifact;
  readonly policy: ContinuityPolicy;
  readonly previousOutcome?: ContinuityOutcome;
  readonly thread: Pick<PersonalThread, "id" | "kind" | "title">;
}

export type ExactArtifactResolver = (link: ArtifactLink) => Promise<ResolvedArtifact | undefined>;
