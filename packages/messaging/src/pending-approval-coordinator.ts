import { classifyPendingApprovalToolOutcome } from "./pending-approval-outcome.js";
import {
  beginPendingApprovalExecution,
  claimPendingApproval,
  declinePendingApprovalClaim,
  finalizePendingApprovalExecution,
  observePendingApprovalState,
  type PendingApproval,
  type PendingApprovalActor,
  type PendingApprovalObservedState
} from "./pending-approval-store.js";

export type PendingApprovalPreparation =
  | { readonly kind: "execute"; readonly execute: () => Promise<unknown> }
  | { readonly kind: "decline"; readonly detail: string }
  | { readonly kind: "unknown"; readonly detail: string };

export type PendingApprovalCoordinatorPhase = "claim" | "decline" | "begin" | "finalize";
export type PendingApprovalCoordinatorState = PendingApprovalObservedState | "forbidden";

export type CompletePendingApprovalResult =
  | { readonly kind: "unavailable"; readonly state: "not-found" | "expired" | "forbidden" }
  | { readonly kind: "conflict"; readonly phase: PendingApprovalCoordinatorPhase; readonly state: PendingApprovalCoordinatorState }
  | { readonly kind: "denied"; readonly approvalSnapshot: PendingApproval; readonly detail: string }
  | { readonly kind: "unknown"; readonly approvalSnapshot: PendingApproval; readonly detail: string; readonly effectAttempted: boolean }
  | { readonly kind: "succeeded"; readonly approvalSnapshot: PendingApproval; readonly output: unknown }
  | {
      readonly kind: "persistence-uncertain";
      readonly phase: PendingApprovalCoordinatorPhase;
      readonly effectAttempted: boolean;
      readonly error: string;
      readonly certainty: "observed";
      readonly state: PendingApprovalObservedState;
    }
  | {
      readonly kind: "persistence-uncertain";
      readonly phase: PendingApprovalCoordinatorPhase;
      readonly effectAttempted: boolean;
      readonly error: string;
      readonly certainty: "unobserved";
    };

export interface PendingApprovalCoordinatorOperations {
  readonly claim?: typeof claimPendingApproval;
  readonly decline?: typeof declinePendingApprovalClaim;
  readonly begin?: typeof beginPendingApprovalExecution;
  readonly finalize?: typeof finalizePendingApprovalExecution;
  readonly observe?: typeof observePendingApprovalState;
}

export interface CompletePendingApprovalOptions {
  readonly file: string;
  readonly id: string;
  readonly actor: PendingApprovalActor;
  readonly prepare: (snapshot: PendingApproval) => Promise<PendingApprovalPreparation>;
  readonly now?: () => Date;
  readonly operations?: PendingApprovalCoordinatorOperations;
}

function message(cause: unknown): string {
  try {
    return cause instanceof Error ? cause.message : String(cause);
  } catch {
    return "unknown error";
  }
}

export async function completePendingApproval(options: CompletePendingApprovalOptions): Promise<CompletePendingApprovalResult> {
  const operations = {
    begin: options.operations?.begin ?? beginPendingApprovalExecution,
    claim: options.operations?.claim ?? claimPendingApproval,
    decline: options.operations?.decline ?? declinePendingApprovalClaim,
    finalize: options.operations?.finalize ?? finalizePendingApprovalExecution,
    observe: options.operations?.observe ?? observePendingApprovalState
  };
  const uncertain = async (
    phase: PendingApprovalCoordinatorPhase,
    effectAttempted: boolean,
    cause: unknown
  ): Promise<CompletePendingApprovalResult> => {
    const error = message(cause);
    try {
      const state = await operations.observe(options.file, options.id, options.now);
      return { certainty: "observed", effectAttempted, error, kind: "persistence-uncertain", phase, state };
    } catch {
      return { certainty: "unobserved", effectAttempted, error, kind: "persistence-uncertain", phase };
    }
  };

  let claim: Awaited<ReturnType<typeof claimPendingApproval>>;
  try {
    claim = await operations.claim(options.file, options.id, options.actor, options.now);
  } catch (cause) {
    return uncertain("claim", false, cause);
  }
  if (!claim.claimedByThisCall) {
    return claim.state === "not-found" || claim.state === "expired" || claim.state === "forbidden"
      ? { kind: "unavailable", state: claim.state }
      : { kind: "conflict", phase: "claim", state: claim.state };
  }

  const snapshot = claim.approvalSnapshot;
  let preparation: PendingApprovalPreparation;
  try {
    preparation = await options.prepare(snapshot);
  } catch (cause) {
    preparation = { detail: `preparation failed: ${message(cause)}`, kind: "decline" };
  }

  if (preparation.kind === "decline") {
    try {
      const declined = await operations.decline(options.file, snapshot.id, claim.claimToken, preparation.detail, options.now);
      return declined.transitioned
        ? { approvalSnapshot: snapshot, detail: preparation.detail, kind: "denied" }
        : { kind: "conflict", phase: "decline", state: declined.state };
    } catch (cause) {
      return uncertain("decline", false, cause);
    }
  }

  let begun: Awaited<ReturnType<typeof beginPendingApprovalExecution>>;
  try {
    begun = await operations.begin(options.file, snapshot.id, claim.claimToken, options.now);
  } catch (cause) {
    return uncertain("begin", false, cause);
  }
  if (!begun.transitioned) {
    return { kind: "conflict", phase: "begin", state: begun.state };
  }

  const finalize = async (
    state: "succeeded" | "unknown",
    detail: string | undefined,
    effectAttempted: boolean,
    output?: unknown
  ): Promise<CompletePendingApprovalResult> => {
    try {
      const finalized = await operations.finalize(options.file, snapshot.id, claim.claimToken, state, detail, options.now);
      if (!finalized.transitioned) {
        return { kind: "conflict", phase: "finalize", state: finalized.state };
      }
      return state === "succeeded"
        ? { approvalSnapshot: snapshot, kind: "succeeded", output }
        : { approvalSnapshot: snapshot, detail: detail ?? "outcome unknown", effectAttempted, kind: "unknown" };
    } catch (cause) {
      return uncertain("finalize", effectAttempted, cause);
    }
  };

  if (preparation.kind === "unknown") {
    return finalize("unknown", preparation.detail, false);
  }

  let output: unknown;
  try {
    output = await preparation.execute();
  } catch (cause) {
    return finalize("unknown", `execution failed: ${message(cause)}`, true);
  }
  return classifyPendingApprovalToolOutcome(output) === "succeeded"
    ? finalize("succeeded", undefined, true, output)
    : finalize("unknown", "tool result did not prove success", true);
}
