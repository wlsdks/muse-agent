import { inspectPendingApprovalStatus } from "@muse/messaging";

import type { ChatApprovalExecuteResult } from "./chat-approval-execute.js";

export async function getChatApprovalStatus(options: {
  readonly id: string;
  readonly pendingFile: string;
  readonly requestUserId?: string;
  readonly now?: () => Date;
}): Promise<ChatApprovalExecuteResult> {
  const result = await inspectPendingApprovalStatus(
    options.pendingFile,
    options.id.trim(),
    { surface: "api", ...(options.requestUserId ? { requestUserId: options.requestUserId } : {}) },
    options.now
  );
  if (result.found) {
    return { body: { ...result.status }, statusCode: 200 };
  }
  return result.state === "forbidden"
    ? { body: { error: "this approval belongs to a different user", state: "forbidden" }, statusCode: 403 }
    : { body: { error: "no pending approval with that id (it may have expired)", state: result.state }, statusCode: 404 };
}
