import { randomUUID } from "node:crypto";

import { denyPendingApproval } from "@muse/messaging";
import { appendActionLog as defaultAppendActionLog, type ActionLogEntry } from "@muse/stores";

import type { ChatApprovalExecuteResult } from "./chat-approval-execute.js";

/**
 * Confirm-deny for `POST /api/chat/approvals/:id/deny` (outbound-safety
 * draft-first, fail-close symmetry with `executeChatApproval`): denial can
 * never execute a tool — there is no resolver parameter at all, structurally.
 * The pending entry first wins the same atomic race as approve and becomes a
 * durable `denied` tombstone. The action log is appended afterwards; if that
 * audit append fails, the response is 5xx but the denial remains durable and
 * the approval can never be replayed.
 */
export async function denyChatApproval(opts: {
  readonly id: string;
  readonly pendingFile: string;
  readonly actionLogFile: string;
  /**
   * The authenticated caller (when auth is on). Mirrors `executeChatApproval`'s
   * user-scope rule: a pending entry that RECORDED a `userId` may be denied
   * only by that same user — a different authenticated user is refused (403).
   */
  readonly requestUserId?: string;
  readonly appendActionLog?: (file: string, entry: ActionLogEntry) => Promise<void>;
  readonly now?: () => Date;
}): Promise<ChatApprovalExecuteResult> {
  const id = opts.id.trim();
  const now = opts.now ?? (() => new Date());
  const append = opts.appendActionLog ?? defaultAppendActionLog;
  const denied = await denyPendingApproval(
    opts.pendingFile,
    id,
    { surface: "api", ...(opts.requestUserId ? { requestUserId: opts.requestUserId } : {}) },
    "denied by the user in chat",
    now
  );
  if (!denied.transitioned) {
    if (denied.state === "forbidden") {
      return { statusCode: 403, body: { error: "this approval belongs to a different user", state: "forbidden" } };
    }
    if (denied.state === "not-found" || denied.state === "expired") {
      return { statusCode: 404, body: { error: "no pending approval with that id (it may have expired)", state: denied.state } };
    }
    return { statusCode: 409, body: { error: "approval has already been claimed or resolved", state: denied.state } };
  }
  const entry = denied.approvalSnapshot;

  try {
    await append(opts.actionLogFile, {
      gateClass: entry.tool,
      id: randomUUID(),
      result: "refused",
      userId: entry.userId ?? opts.requestUserId ?? `${entry.providerId}:${entry.source}`,
      what: `Muse drafted "${entry.tool}" (${entry.risk})${entry.draft ? ` — ${entry.draft}` : ""}`,
      when: now().toISOString(),
      why: "denied by the user in chat — the drafted action was not confirmed"
    });
  } catch {
    return { statusCode: 500, body: { denied: true, error: "approval was denied but its action log could not be recorded", state: "denied" } };
  }

  return { statusCode: 200, body: { denied: true, state: "denied", tool: entry.tool } };
}
