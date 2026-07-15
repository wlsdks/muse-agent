import { randomUUID } from "node:crypto";

import { clearPendingApproval, listPendingApprovals } from "@muse/messaging";
import { appendActionLog as defaultAppendActionLog, type ActionLogEntry } from "@muse/stores";

import type { ChatApprovalExecuteResult } from "./chat-approval-execute.js";

/**
 * Confirm-deny for `POST /api/chat/approvals/:id/deny` (outbound-safety
 * draft-first, fail-close symmetry with `executeChatApproval`): denial can
 * never execute a tool — there is no resolver parameter at all, structurally.
 * The refusal is recorded to the action log FIRST, then the pending entry is
 * cleared, so an action-log append failure leaves the entry pending rather
 * than silently dropping the denial (5xx, no state loss).
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
  const pending = await listPendingApprovals(opts.pendingFile, now);
  const entry = pending.find((candidate) => candidate.id === id);
  if (!entry) {
    return { statusCode: 404, body: { error: "no pending approval with that id (it may have expired)" } };
  }
  if (entry.userId !== undefined && opts.requestUserId !== undefined && entry.userId !== opts.requestUserId) {
    return { statusCode: 403, body: { error: "this approval belongs to a different user" } };
  }

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
    return { statusCode: 500, body: { error: "failed to record the denial — the pending approval was left in place" } };
  }

  // Only cleared AFTER the refusal is durably logged: a denial is never silently
  // dropped, even if this clear itself fails (the entry then stays pending, safe).
  await clearPendingApproval(opts.pendingFile, entry.id, now);
  return { statusCode: 200, body: { denied: true, tool: entry.tool } };
}
