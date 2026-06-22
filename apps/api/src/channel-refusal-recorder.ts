import { randomUUID } from "node:crypto";

import { appendActionLog as defaultAppendActionLog, type ActionLogEntry } from "@muse/stores";
import type { ChannelApprovalRefusal } from "@muse/messaging";

/**
 * Bridges the channel-approval gate's `recordRefusal` hook to the
 * action log: a risky tool an inbound channel message tried to trigger,
 * and which the fail-closed gate refused, is recorded as a `refused`
 * entry — so `muse actions` shows what the agent was blocked on
 * (outbound-safety: every action, sent OR refused, leaves a trail).
 * `@muse/messaging` stays free of an `@muse/mcp` dependency; this
 * apps/api seam owns the action-log write.
 */
export function createChannelRefusalRecorder(deps: {
  readonly actionLogFile: string;
  readonly providerId: string;
  readonly source: string;
  readonly appendActionLog?: (file: string, entry: ActionLogEntry) => Promise<void>;
  readonly now?: () => Date;
}): (refusal: ChannelApprovalRefusal) => Promise<void> {
  const append = deps.appendActionLog ?? defaultAppendActionLog;
  const now = deps.now ?? (() => new Date());
  return async (refusal) => {
    await append(deps.actionLogFile, {
      detail: `channel ${deps.providerId}:${deps.source}; reply to approve`,
      id: randomUUID(),
      result: "refused",
      userId: refusal.userId ?? `${deps.providerId}:${deps.source}`,
      what: `Muse wanted to run "${refusal.tool}" (${refusal.risk})${refusal.draft ? ` — ${refusal.draft}` : ""}`,
      when: now().toISOString(),
      why: `triggered by an inbound ${deps.providerId} message; fail-closed gate refused — awaiting in-chat approval`
    });
  };
}
