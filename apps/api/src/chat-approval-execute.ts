import { clearPendingApproval, listPendingApprovals } from "@muse/messaging";
import type { JsonObject } from "@muse/shared";
import type { MuseTool } from "@muse/tools";

export interface ChatApprovalExecuteResult {
  readonly statusCode: number;
  readonly body: Record<string, unknown>;
}

/**
 * A tool result that reports its own failure — an object carrying a non-empty
 * `error` string, or an explicit `ok:false` / `success:false`. Such a result
 * must NOT clear the pending entry (the action didn't happen), so the user can
 * retry the same approval later.
 */
function isErrorShaped(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (typeof record["error"] === "string" && record["error"].length > 0) {
    return true;
  }
  return record["ok"] === false || record["success"] === false;
}

/**
 * Confirm-execute for `POST /api/chat/approvals/:id/approve` (outbound-safety
 * draft-first): a pending write/execute action Muse captured on the chat
 * surface runs ONLY here, after the user explicitly confirms it by id. Every
 * fail path produces NO execution — unknown/expired id → 404, no resolver /
 * unknown tool → 409 — and a successful run is cleared so a replayed approve
 * of the same id finds nothing (404). An error-shaped tool result leaves the
 * entry pending (`ran:false`).
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
  const pending = await listPendingApprovals(opts.pendingFile, opts.now);
  const entry = pending.find((candidate) => candidate.id === id);
  if (!entry) {
    return { statusCode: 404, body: { error: "no pending approval with that id (it may have expired)" } };
  }
  if (entry.userId !== undefined && opts.requestUserId !== undefined && entry.userId !== opts.requestUserId) {
    return { statusCode: 403, body: { error: "this approval belongs to a different user" } };
  }
  const tool = opts.resolveTool?.(entry.tool);
  if (!tool) {
    return { statusCode: 409, body: { error: "tool no longer available" } };
  }
  const result = await tool.execute(entry.arguments as JsonObject, { runId: `chat-approve-${entry.id}` });
  if (isErrorShaped(result)) {
    return { statusCode: 200, body: { ran: false, tool: entry.tool } };
  }
  // Replay-guard: only a successful run clears the entry, so a second approve
  // of the same id finds nothing and 404s — the action can never run twice.
  await clearPendingApproval(opts.pendingFile, entry.id, opts.now);
  return { statusCode: 200, body: { ran: true, tool: entry.tool, result } };
}
