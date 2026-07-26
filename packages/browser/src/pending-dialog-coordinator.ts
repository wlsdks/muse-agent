import { randomUUID } from "node:crypto";

export type PendingDialogType = "confirm" | "prompt";
export type PendingDialogDecision =
  | { readonly kind: "accept"; readonly promptResponse?: string }
  | { readonly kind: "dismiss" };
export type PendingDialogStatus =
  | "pending"
  | "claimed"
  | "acknowledged"
  | "failed"
  | "abandoned";

export interface PendingDialogIdentity {
  readonly dialogId: string;
  readonly sessionIncarnation: string;
  readonly pageTargetId: string;
  readonly generation: number;
  readonly type: PendingDialogType;
  readonly message: string;
  readonly pageUrl: string;
  readonly promptDefaultValue?: string;
}

export interface PendingDialogClaim {
  readonly identity: PendingDialogIdentity;
  readonly claimantId: string;
  readonly claimToken: string;
  readonly decision: PendingDialogDecision;
}

export interface PendingDialogDecisionReceipt {
  readonly schemaVersion: "muse.browser-dialog-decision-receipt/v1";
  readonly identity: PendingDialogIdentity;
  readonly claimantId: string;
  readonly decision: PendingDialogDecision;
  readonly status: "acknowledged";
}

export interface PendingDialogState {
  readonly identity: PendingDialogIdentity;
  readonly status: PendingDialogStatus;
  readonly claimantId?: string;
  readonly decision?: PendingDialogDecision;
  readonly failure?: "decision-executor-rejected";
  readonly abandonmentReason?: string;
  readonly receipt?: PendingDialogDecisionReceipt;
}

export type PendingDialogRejectionReason =
  | "dialog-already-active"
  | "dialog-id-collision"
  | "dialog-not-found"
  | "identity-mismatch"
  | "coordinator-busy"
  | "invalid-claimant"
  | "invalid-decision"
  | "claim-token-collision"
  | "not-pending"
  | "claim-mismatch"
  | "decision-already-started"
  | "not-claimed"
  | "terminal";

export type PendingDialogOpenResult =
  | { readonly ok: true; readonly identity: PendingDialogIdentity }
  | {
      readonly ok: false;
      readonly reason: "coordinator-busy" | "dialog-already-active" | "dialog-id-collision";
    };

export type PendingDialogClaimResult =
  | { readonly ok: true; readonly claim: PendingDialogClaim }
  | { readonly ok: false; readonly reason: PendingDialogRejectionReason };

export type PendingDialogExecutionResult =
  | { readonly ok: true; readonly receipt: PendingDialogDecisionReceipt }
  | { readonly ok: false; readonly reason: PendingDialogRejectionReason | "decision-executor-rejected" };

export type PendingDialogAbandonResult =
  | { readonly ok: true; readonly state: PendingDialogState }
  | { readonly ok: false; readonly reason: PendingDialogRejectionReason };

export interface OpenPendingDialogInput {
  readonly pageTargetId: string;
  readonly type: PendingDialogType;
  readonly message: string;
  readonly pageUrl: string;
  readonly promptDefaultValue?: string;
}

export interface ClaimPendingDialogInput {
  readonly identity: PendingDialogIdentity;
  readonly claimantId: string;
  readonly decision: PendingDialogDecision;
}

export interface PendingDialogCoordinatorOptions {
  readonly sessionIncarnation: string;
  readonly idFactory?: () => string;
}

interface PendingEntry {
  readonly identity: PendingDialogIdentity;
  status: PendingDialogStatus;
  claimantId?: string;
  claimToken?: string;
  decision?: PendingDialogDecision;
  executionStarted: boolean;
  failure?: "decision-executor-rejected";
  abandonmentReason?: string;
  receipt?: PendingDialogDecisionReceipt;
}

export class PendingDialogCoordinator {
  readonly #sessionIncarnation: string;
  readonly #idFactory: () => string;
  readonly #entries = new Map<string, PendingEntry>();
  readonly #issuedClaimTokens = new Set<string>();
  #generation = 0;
  #activeDialogId: string | undefined;
  #allocationInProgress = false;

  constructor(options: PendingDialogCoordinatorOptions) {
    this.#sessionIncarnation = exactText(options.sessionIncarnation, "sessionIncarnation");
    this.#idFactory = options.idFactory ?? randomUUID;
  }

  open(input: OpenPendingDialogInput): PendingDialogOpenResult {
    if (this.#allocationInProgress) return { ok: false, reason: "coordinator-busy" };
    if (this.#activeDialogId !== undefined) {
      const active = this.#entries.get(this.#activeDialogId);
      if (active && (active.status === "pending" || active.status === "claimed")) {
        return { ok: false, reason: "dialog-already-active" };
      }
      this.#activeDialogId = undefined;
    }

    const type = input.type;
    const promptDefaultValue = input.promptDefaultValue;
    if (type !== "confirm" && type !== "prompt") {
      throw new TypeError("unsupported dialog type");
    }
    if (type === "confirm" && promptDefaultValue !== undefined) {
      throw new TypeError("confirm dialog must not include promptDefaultValue");
    }
    if (type === "prompt" && promptDefaultValue === undefined) {
      throw new TypeError("prompt dialog requires exact promptDefaultValue");
    }
    // Browser dialog messages are exact untrusted page data and may legally be
    // empty or whitespace-only (`confirm("")`). Preserve them byte-for-byte.
    const message = exactString(input.message, "message");
    const pageTargetId = exactText(input.pageTargetId, "pageTargetId");
    const pageUrl = exactText(input.pageUrl, "pageUrl");
    const validatedPromptDefaultValue = promptDefaultValue === undefined
      ? undefined
      : exactString(promptDefaultValue, "promptDefaultValue");
    this.#allocationInProgress = true;
    try {
      const dialogId = `dlg_${exactText(this.#idFactory(), "dialogId")}`;
      if (this.#entries.has(dialogId)) return { ok: false, reason: "dialog-id-collision" };
      const generation = this.#generation + 1;
      const identity: PendingDialogIdentity = Object.freeze({
        dialogId,
        generation,
        message,
        pageTargetId,
        pageUrl,
        ...(validatedPromptDefaultValue !== undefined
          ? { promptDefaultValue: validatedPromptDefaultValue }
          : {}),
        sessionIncarnation: this.#sessionIncarnation,
        type
      });
      this.#generation = generation;
      this.#entries.set(dialogId, {
        executionStarted: false,
        identity,
        status: "pending"
      });
      this.#activeDialogId = dialogId;
      return { identity, ok: true };
    } finally {
      this.#allocationInProgress = false;
    }
  }

  claim(input: ClaimPendingDialogInput): PendingDialogClaimResult {
    if (this.#allocationInProgress) return { ok: false, reason: "coordinator-busy" };
    const resolved = this.#resolveIdentity(input.identity);
    if (!resolved.ok) return resolved;
    const entry = resolved.entry;
    if (entry.status !== "pending") {
      return { ok: false, reason: terminal(entry.status) ? "terminal" : "not-pending" };
    }
    let claimantId: string;
    try {
      claimantId = exactText(input.claimantId, "claimantId");
    } catch {
      return { ok: false, reason: "invalid-claimant" };
    }
    if (!validDecision(entry.identity, input.decision)) {
      return { ok: false, reason: "invalid-decision" };
    }
    const decision = snapshotDecision(input.decision);
    this.#allocationInProgress = true;
    try {
      const claimToken = `clm_${exactText(this.#idFactory(), "claimToken")}`;
      if (this.#issuedClaimTokens.has(claimToken)) {
        return { ok: false, reason: "claim-token-collision" };
      }
      this.#issuedClaimTokens.add(claimToken);
      entry.status = "claimed";
      entry.claimantId = claimantId;
      entry.claimToken = claimToken;
      entry.decision = decision;
      const claim: PendingDialogClaim = Object.freeze({
        claimantId,
        claimToken,
        decision: entry.decision,
        identity: entry.identity
      });
      return { claim, ok: true };
    } finally {
      this.#allocationInProgress = false;
    }
  }

  async execute(
    claim: PendingDialogClaim,
    executor: (decision: PendingDialogDecision) => Promise<void>
  ): Promise<PendingDialogExecutionResult> {
    const resolved = this.#resolveIdentity(claim.identity);
    if (!resolved.ok) return resolved;
    const entry = resolved.entry;
    if (entry.status !== "claimed") {
      return { ok: false, reason: terminal(entry.status) ? "terminal" : "not-claimed" };
    }
    if (
      entry.claimToken !== claim.claimToken
      || entry.claimantId !== claim.claimantId
      || !sameDecision(entry.decision, claim.decision)
    ) {
      return { ok: false, reason: "claim-mismatch" };
    }
    if (entry.executionStarted) return { ok: false, reason: "decision-already-started" };
    entry.executionStarted = true;

    try {
      await executor(entry.decision!);
    } catch {
      if (entry.status !== "claimed") {
        return { ok: false, reason: terminal(entry.status) ? "terminal" : "not-claimed" };
      }
      entry.status = "failed";
      entry.failure = "decision-executor-rejected";
      this.#releaseActive(entry.identity.dialogId);
      return { ok: false, reason: "decision-executor-rejected" };
    }

    if (entry.status !== "claimed") {
      return { ok: false, reason: terminal(entry.status) ? "terminal" : "not-claimed" };
    }
    const receipt: PendingDialogDecisionReceipt = Object.freeze({
      claimantId: entry.claimantId!,
      decision: entry.decision!,
      identity: entry.identity,
      schemaVersion: "muse.browser-dialog-decision-receipt/v1",
      status: "acknowledged"
    });
    entry.status = "acknowledged";
    entry.receipt = receipt;
    this.#releaseActive(entry.identity.dialogId);
    return { ok: true, receipt };
  }

  abandon(identity: PendingDialogIdentity, reason: string): PendingDialogAbandonResult {
    if (this.#allocationInProgress) return { ok: false, reason: "coordinator-busy" };
    const resolved = this.#resolveIdentity(identity);
    if (!resolved.ok) return resolved;
    const entry = resolved.entry;
    if (terminal(entry.status)) return { ok: false, reason: "terminal" };
    const abandonmentReason = exactText(reason, "abandonmentReason");
    entry.status = "abandoned";
    entry.abandonmentReason = abandonmentReason;
    this.#releaseActive(entry.identity.dialogId);
    return { ok: true, state: snapshotState(entry) };
  }

  inspect(identity: PendingDialogIdentity): PendingDialogState | undefined {
    const resolved = this.#resolveIdentity(identity);
    return resolved.ok ? snapshotState(resolved.entry) : undefined;
  }

  #resolveIdentity(
    identity: PendingDialogIdentity
  ): { readonly ok: true; readonly entry: PendingEntry } | { readonly ok: false; readonly reason: PendingDialogRejectionReason } {
    const entry = this.#entries.get(identity.dialogId);
    if (!entry) return { ok: false, reason: "dialog-not-found" };
    return sameIdentity(entry.identity, identity)
      ? { entry, ok: true }
      : { ok: false, reason: "identity-mismatch" };
  }

  #releaseActive(dialogId: string): void {
    if (this.#activeDialogId === dialogId) this.#activeDialogId = undefined;
  }
}

function exactText(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new TypeError(`${label} must be non-empty exact text`);
  }
  return value;
}

function exactString(value: string, label: string): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be exact text`);
  return value;
}

function validDecision(identity: PendingDialogIdentity, decision: PendingDialogDecision): boolean {
  if (decision.kind === "dismiss") {
    return !("promptResponse" in decision);
  }
  if (decision.kind !== "accept") return false;
  if (identity.type === "prompt") return typeof decision.promptResponse === "string";
  return !("promptResponse" in decision);
}

function snapshotDecision(decision: PendingDialogDecision): PendingDialogDecision {
  return Object.freeze(decision.kind === "accept"
    ? {
        kind: "accept" as const,
        ...(decision.promptResponse !== undefined
          ? { promptResponse: exactString(decision.promptResponse, "promptResponse") }
          : {})
      }
    : { kind: "dismiss" as const });
}

function sameDecision(
  left: PendingDialogDecision | undefined,
  right: PendingDialogDecision
): boolean {
  if (!left || left.kind !== right.kind) return false;
  if (left.kind === "dismiss") return !("promptResponse" in right);
  return right.kind === "accept" && left.promptResponse === right.promptResponse;
}

function sameIdentity(left: PendingDialogIdentity, right: PendingDialogIdentity): boolean {
  return left.dialogId === right.dialogId
    && left.sessionIncarnation === right.sessionIncarnation
    && left.pageTargetId === right.pageTargetId
    && left.generation === right.generation
    && left.type === right.type
    && left.message === right.message
    && left.pageUrl === right.pageUrl
    && left.promptDefaultValue === right.promptDefaultValue;
}

function terminal(status: PendingDialogStatus): boolean {
  return status === "acknowledged" || status === "failed" || status === "abandoned";
}

function snapshotState(entry: PendingEntry): PendingDialogState {
  return Object.freeze({
    ...(entry.abandonmentReason !== undefined
      ? { abandonmentReason: entry.abandonmentReason }
      : {}),
    ...(entry.claimantId !== undefined ? { claimantId: entry.claimantId } : {}),
    ...(entry.decision !== undefined ? { decision: entry.decision } : {}),
    ...(entry.failure !== undefined ? { failure: entry.failure } : {}),
    identity: entry.identity,
    ...(entry.receipt !== undefined ? { receipt: entry.receipt } : {}),
    status: entry.status
  });
}
