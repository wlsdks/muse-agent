import {
  beginPendingApprovalExecution,
  claimPendingApproval,
  classifyPendingApprovalToolOutcome,
  finalizePendingApprovalExecution,
  type PendingApprovalClaimResult
} from "@muse/messaging";
import { errorMessage, type JsonObject } from "@muse/shared";
import type { MuseTool } from "@muse/tools";

export interface ChatApprovalExecuteResult {
  readonly statusCode: number;
  readonly body: Record<string, unknown>;
}

function claimFailure(result: Exclude<PendingApprovalClaimResult, { readonly claimedByThisCall: true }>): ChatApprovalExecuteResult {
  if (result.state === "forbidden") {
    return { statusCode: 403, body: { error: "this approval belongs to a different user", state: result.state } };
  }
  if (result.state === "not-found" || result.state === "expired") {
    return { statusCode: 404, body: { error: "no pending approval with that id (it may have expired)", state: result.state } };
  }
  return { statusCode: 409, body: { error: "approval has already been claimed or resolved", state: result.state } };
}

/**
 * Confirm-execute for `POST /api/chat/approvals/:id/approve` (outbound-safety
 * draft-first): a pending write/execute action Muse captured on the chat
 * surface runs ONLY here, after the user explicitly confirms it by id. Every
 * unknown/expired ids produce 404; an existing durable state produces 409.
 * Before any effect, the pending entry is atomically claimed and moved to
 * `executing`. Success becomes `succeeded`; throws or results without an
 * explicit success marker become `unknown`. Every durable state is a replay
 * tombstone, so the same approval id is never executed automatically again.
 */
export async function executeChatApproval(opts: {
  readonly id: string;
  readonly pendingFile: string;
  readonly resolveTool?: (name: string) => MuseTool | undefined;
  /**
   * The authenticated caller (when auth is on). A pending entry that RECORDED a
   * `userId` may be approved only by that same user — a different authenticated
   * user is refused (403) with no execution. When either side is absent (the
   * single-user local posture, no auth) the id alone authorises, matching the
   * unguessable-UUID model the CLI `muse approvals approve` uses.
   */
  readonly requestUserId?: string;
  readonly now?: () => Date;
}): Promise<ChatApprovalExecuteResult> {
  const id = opts.id.trim();
  const claim = await claimPendingApproval(
    opts.pendingFile,
    id,
    { surface: "api", ...(opts.requestUserId ? { requestUserId: opts.requestUserId } : {}) },
    opts.now
  );
  if (!claim.claimedByThisCall) {
    return claimFailure(claim);
  }

  const entry = claim.approvalSnapshot;
  const tool = opts.resolveTool?.(entry.tool);
  if (!tool) {
    const begun = await beginPendingApprovalExecution(opts.pendingFile, id, claim.claimToken, opts.now);
    if (!begun.transitioned) {
      return { statusCode: 409, body: { error: "tool unavailable and approval execution could not begin", state: begun.state } };
    }
    const finalized = await finalizePendingApprovalExecution(
      opts.pendingFile,
      id,
      claim.claimToken,
      "unknown",
      "tool no longer available",
      opts.now
    );
    if (!finalized.transitioned) {
      return { statusCode: 500, body: { error: "tool unavailable but approval finalization failed", state: finalized.state } };
    }
    return { statusCode: 409, body: { error: "tool no longer available", state: "unknown" } };
  }
  const begun = await beginPendingApprovalExecution(opts.pendingFile, id, claim.claimToken, opts.now);
  if (!begun.transitioned) {
    return { statusCode: 409, body: { error: "approval execution could not begin", state: begun.state } };
  }

  let result: unknown;
  try {
    result = await tool.execute(entry.arguments as JsonObject, { runId: `chat-approve-${entry.id}` });
  } catch (cause) {
    const finalized = await finalizePendingApprovalExecution(
      opts.pendingFile,
      id,
      claim.claimToken,
      "unknown",
      errorMessage(cause),
      opts.now
    );
    if (!finalized.transitioned) {
      return { statusCode: 500, body: { error: "tool failed and approval finalization failed", state: finalized.state, tool: entry.tool } };
    }
    return { statusCode: 500, body: { error: "approved tool execution failed", state: "unknown", tool: entry.tool } };
  }
  if (classifyPendingApprovalToolOutcome(result) === "unknown") {
    const finalized = await finalizePendingApprovalExecution(
      opts.pendingFile,
      id,
      claim.claimToken,
      "unknown",
      "tool result did not prove success",
      opts.now
    );
    if (!finalized.transitioned) {
      return { statusCode: 500, body: { error: "tool result was uncertain and approval finalization failed", state: finalized.state, tool: entry.tool } };
    }
    return { statusCode: 200, body: { ran: false, state: "unknown", tool: entry.tool } };
  }
  const finalized = await finalizePendingApprovalExecution(
    opts.pendingFile,
    id,
    claim.claimToken,
    "succeeded",
    undefined,
    opts.now
  );
  if (!finalized.transitioned) {
    return { statusCode: 500, body: { error: "tool ran but approval finalization failed", state: finalized.state } };
  }
  return { statusCode: 200, body: { ran: true, state: "succeeded", tool: entry.tool, result } };
}
