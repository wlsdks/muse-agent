import { isApprovalReply, listPendingApprovals, type PendingApproval } from "@muse/messaging";

/**
 * Handle an inbound channel message that reads as a bare approval
 * ("yes") of a pending refusal. Returns the reply string when handled,
 * or `undefined` to fall through to the normal agent run (not an
 * approval, or nothing pending for this channel).
 *
 * A matching reply only returns a deterministic acknowledgement pointing at
 * the working CLI completion (`muse approvals approve <id>`). It never runs or
 * clears the pending action; the effect still requires a deliberate local CLI
 * confirmation by id. Multiple pending approvals are listed rather than
 * guessing which action the reply meant.
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
  if (pending.length === 0) {
    return undefined;
  }

  if (pending.length > 1) {
    return (
      `You have ${pending.length.toString()} pending approvals — approve one by id: `
      + `${pending.map((e) => `\`muse approvals approve ${e.id}\` (${e.tool})`).join(", ")}.`
    );
  }

  const latest = pending[0]!;
  return (
    `Got it — "${latest.tool}: ${latest.draft}" is awaiting your approval. `
    + `Approve it with \`muse approvals approve ${latest.id}\`, or \`muse approvals clear ${latest.id}\` to dismiss.`
  );
}
