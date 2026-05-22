import { isApprovalReply, listPendingApprovals, type PendingApproval } from "@muse/messaging";

/**
 * When an inbound channel message reads as a bare approval ("yes") AND
 * a pending approval exists for that exact channel, return a deterministic
 * acknowledgement pointing at the working completion path
 * (`muse approvals approve <id>`) — so the reply isn't wasted on a
 * confused agent turn. Returns `undefined` (let the normal agent run
 * handle it) when the message isn't a bare approval, or there's nothing
 * pending for this channel.
 *
 * In-chat auto-execution (running the tool right here on "yes") is a
 * separate slice: it needs the actuator orchestration wired server-side,
 * which the API agent runtime does not register today.
 */
export async function handleInboundApprovalReply(opts: {
  readonly text: string;
  readonly providerId: string;
  readonly source: string;
  readonly pendingFile: string;
  readonly now?: () => Date;
  readonly listPending?: (
    file: string,
    now?: () => Date,
    scope?: { readonly providerId: string; readonly source: string }
  ) => Promise<readonly PendingApproval[]>;
}): Promise<string | undefined> {
  if (!isApprovalReply(opts.text)) {
    return undefined;
  }
  const list = opts.listPending ?? listPendingApprovals;
  const pending = await list(opts.pendingFile, opts.now, { providerId: opts.providerId, source: opts.source });
  const latest = pending[0];
  if (!latest) {
    return undefined;
  }
  return (
    `Got it — "${latest.tool}: ${latest.draft}" is awaiting your approval. `
    + `Approve it with \`muse approvals approve ${latest.id}\`, or \`muse approvals clear ${latest.id}\` to dismiss.`
  );
}
