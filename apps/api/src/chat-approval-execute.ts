import {
  completePendingApproval,
  type CompletePendingApprovalResult,
  type PendingApprovalAcquisition
} from "@muse/messaging";
import type { JsonObject } from "@muse/shared";
import type { MuseTool } from "@muse/tools";
import { normalizeLocalTaskMutationOutcome } from "@muse/domain-tools";

export interface ChatApprovalExecuteResult {
  readonly statusCode: number;
  readonly body: Record<string, unknown>;
}

function mapCompletion(
  result: CompletePendingApprovalResult,
  executionFailed: boolean
): ChatApprovalExecuteResult {
  switch (result.kind) {
    case "unavailable":
      return result.state === "forbidden"
        ? { statusCode: 403, body: { error: "this approval belongs to a different user", state: result.state } }
        : { statusCode: 404, body: { error: "no pending approval with that id (it may have expired)", state: result.state } };
    case "conflict":
      return {
        statusCode: result.phase === "finalize" ? 500 : 409,
        body: {
          error: result.phase === "finalize"
            ? "tool may have run but approval finalization failed"
            : "approval has already been claimed or resolved",
          phase: result.phase,
          state: result.state
        }
      };
    case "denied":
      return {
        statusCode: 500,
        body: { error: "approved tool preparation failed", state: "denied", tool: result.approvalSnapshot.tool }
      };
    case "unknown":
      if (!result.effectAttempted) {
        return {
          statusCode: 409,
          body: { error: "tool no longer available", state: "unknown", tool: result.approvalSnapshot.tool }
        };
      }
      return executionFailed
        ? {
            statusCode: 500,
            body: { error: "approved tool execution failed", state: "unknown", tool: result.approvalSnapshot.tool }
          }
        : {
            statusCode: 200,
            body: { ran: false, state: "unknown", tool: result.approvalSnapshot.tool }
          };
    case "succeeded":
      return {
        statusCode: 200,
        body: {
          ran: true,
          result: result.output,
          state: "succeeded",
          tool: result.approvalSnapshot.tool
        }
      };
    case "persistence-uncertain":
      return {
        statusCode: 500,
        body: {
          certainty: result.certainty,
          effectAttempted: result.effectAttempted,
          error: `approval persistence is uncertain: ${result.error}`,
          phase: result.phase,
          ...(result.certainty === "observed" ? { state: result.state } : {})
        }
      };
  }
}

/**
 * Confirm-execute for `POST /api/chat/approvals/:id/approve` (outbound-safety
 * draft-first): a pending write/execute action Muse captured on the chat
 * surface runs ONLY here, after the user explicitly confirms it by id. Every
 * unknown/expired ids produce 404; an existing durable state produces 409.
 * The shared coordinator owns claim/begin/finalize ordering. This adapter only
 * resolves the claimed snapshot's tool, returns an effect-bearing closure, and
 * maps the coordinator's durable result to HTTP.
 */
export async function executeChatApproval(opts: {
  readonly acquisition?: PendingApprovalAcquisition;
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
  let executionFailed = false;
  const completion = await completePendingApproval({
    acquisition: opts.acquisition,
    actor: { surface: "api", ...(opts.requestUserId ? { requestUserId: opts.requestUserId } : {}) },
    file: opts.pendingFile,
    id,
    now: opts.now,
    prepare: async (snapshot) => {
      const tool = opts.resolveTool?.(snapshot.tool);
      if (!tool) {
        return { detail: "tool no longer available", kind: "unknown" };
      }
      return {
        execute: async () => {
          try {
            const output = await tool.execute(snapshot.arguments as JsonObject, { runId: `chat-approve-${snapshot.id}` });
            return opts.acquisition === "recover-stale-claim"
              ? normalizeLocalTaskMutationOutcome(snapshot.tool, output)
              : output;
          } catch (cause) {
            executionFailed = true;
            throw cause;
          }
        },
        kind: "execute"
      };
    }
  });
  return mapCompletion(completion, executionFailed);
}
