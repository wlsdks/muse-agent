import { randomUUID } from "node:crypto";

import { resolveThirdPartySendRoute } from "@muse/agent-core";
import {
  createThirdPartySendDraftBinding,
  recordPendingApproval as defaultRecordPendingApproval,
  type ChannelApprovalRefusal,
  type PendingApproval
} from "@muse/messaging";

const DEFAULT_PENDING_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Bridges the channel-approval gate's `recordRefusal` hook to the
 * pending-approval store: a risky tool an inbound channel message tried
 * to trigger (and the gate refused) is persisted as a live, expiring
 * worklist item carrying the structured `tool` + `arguments` needed to
 * re-run it once approved. Parallel to `createChannelRefusalRecorder`
 * (which writes the immutable audit log); both run on a refusal.
 */
export function createChannelPendingRecorder(deps: {
  readonly pendingFile: string;
  readonly providerId: string;
  readonly source: string;
  readonly ttlMs?: number;
  readonly recordPendingApproval?: (file: string, entry: PendingApproval) => Promise<void>;
  readonly now?: () => Date;
}): (refusal: ChannelApprovalRefusal) => Promise<PendingApproval> {
  const record = deps.recordPendingApproval ?? defaultRecordPendingApproval;
  const now = deps.now ?? (() => new Date());
  const ttlMs = deps.ttlMs !== undefined && Number.isFinite(deps.ttlMs) && deps.ttlMs > 0
    ? deps.ttlMs
    : DEFAULT_PENDING_TTL_MS;
  return async (refusal) => {
    const at = now();
    const expiresAt = new Date(at.getTime() + ttlMs).toISOString();
    const route = resolveThirdPartySendRoute(refusal.tool, refusal.arguments);
    if (route.kind === "unbound") {
      throw new Error(`cannot stage unbound third-party send: ${route.reason}`);
    }
    const entry: PendingApproval = {
      arguments: refusal.arguments,
      createdAt: at.toISOString(),
      draft: refusal.draft,
      expiresAt,
      id: randomUUID(),
      providerId: deps.providerId,
      risk: refusal.risk,
      source: deps.source,
      tool: refusal.tool,
      ...(route.kind === "bound"
        ? {
            thirdPartySend: createThirdPartySendDraftBinding({
              arguments: refusal.arguments,
              channel: route.channel,
              draft: refusal.draft,
              expiresAt,
              recipient: route.recipient,
              tool: refusal.tool
            })
          }
        : {}),
      ...(refusal.userId ? { userId: refusal.userId } : {})
    };
    await record(deps.pendingFile, entry);
    return entry;
  };
}
