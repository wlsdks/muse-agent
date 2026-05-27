# 730 — P17 remote: a channel "yes" reply is detected + acked (bridges to `muse approvals approve`)

## Why

After 712/719/728/729, a channel message that triggers a risky tool is
refused with a draft-bearing prompt (712), logged (719), queued as a
pending approval (728), and completable via `muse approvals approve <id>`
(729). But a user who simply replied "yes" on Telegram got a confused
agent turn (the LLM re-processing the bare word "yes" with no idea what
it confirms). This wires the reply: detect it, find the pending action,
and acknowledge it with the exact approve/clear commands.

Full in-CHAT auto-execution (running the tool right there on "yes") needs
the actuator orchestration registered server-side in the API agent
runtime — which doesn't exist today (only `muse ask --actuators` / the
CLI wires it). So this slice ships the SAFE, complete, reusable half
(detection + ack + bridge) and leaves the auto-execution bullet `[ ]`;
the `isApprovalReply` detector + scoped pending-lookup are exactly what
that next slice reuses.

## Slice

- `packages/messaging/src/is-approval-reply.ts` (new): `isApprovalReply`
  — CONSERVATIVE whole-message affirmation match (English + common
  Korean, emoji/punctuation tolerant); a longer sentence that merely
  contains "yes" is NOT an approval (it gates a state-changing action).
- `apps/api/src/inbound-approval-handler.ts` (new):
  `handleInboundApprovalReply` — on an approval reply with a pending
  action scoped to `{providerId, source}`, returns the ack string
  (`muse approvals approve/clear <id>`); else `undefined` (normal turn).
- `apps/api/src/server.ts`: the inbound runner extracts the latest user
  text and short-circuits to the ack BEFORE the agent run when it
  applies.

## Verify

- `@muse/messaging` is-approval-reply.test.ts (231): affirmations
  (case/punct/emoji/Korean) accepted; "yes but change the subject" /
  "yesterday" / questions / "no" rejected; **mutation-proven** (loosening
  to substring match fails the false-approval test).
- `@muse/api` inbound-approval-handler.test.ts (304): ack on
  approval+pending with both commands; `undefined` for non-approval /
  no-pending / different-channel-scope / expired entry.
- `pnpm check`: EXIT=0. `pnpm lint`: 0/0 (fixed a `no-useless-escape` in
  the strip regex). `pnpm check:capabilities`: ✓.
- No LLM request/response path touched — the ack short-circuits BEFORE
  the agent run; the agent turn itself is unchanged.

## Decisions

- **Conservative whole-message match** — a false positive would (once
  auto-execution lands) fire a state-changing action, so `isApprovalReply`
  matches only when the entire trimmed message is an affirmation, never a
  substring; mutation-proven.
- **Ack + bridge, not auto-run** — auto-executing in-chat needs
  server-side actuator wiring (absent today); shipping detection+ack is
  a complete, safe increment that makes the reply useful now and is fully
  reused by the future auto-run, rather than half-wiring an unverified
  server-side re-execution.
- **Scoped to the channel** — only a pending action for the SAME
  `providerId:source` matches, so a "yes" on one chat can't surface
  another chat's pending action.
