# 712 — Safety: the in-chat approval prompt shows the DRAFT, not just the tool name; + first direct tests for the channel approval gate

## Why

`createChannelApprovalGate` is the fail-closed gate for risky tools
triggered by an inbound channel message (Telegram/etc.): a write/execute
tool is denied and an approval prompt is posted back to the channel. But
that prompt only named the tool (`Muse wants to run "email_send"`) — the
user couldn't see WHO/WHAT before approving, which is a draft-first gap
on the channel surface (`outbound-safety.md`: the user must confirm the
exact content). The gate also had NO direct test despite being a safety
seam.

## Slice

- `packages/messaging/src/channel-approval-gate.ts`: widen
  `ChannelApprovalGateInput.toolCall` to carry optional `arguments`
  (the agent runtime already passes the full `ModelToolCall`), and add
  `summarizeToolDraft(name, args)` → a short, channel-safe draft:
  email_send → `to <addr>, subject "<subj>"` (body omitted); web_action
  → `<METHOD> <url>`; home_action → `<service> on <entity>`; unknown →
  up to 3 scalar `key=value` pairs (objects skipped, values clipped).
  The posted prompt now appends `— <draft>`.
- New `channel-approval-gate.test.ts` (the seam had none).

## Verify

- `@muse/messaging` channel-approval-gate.test.ts (207 messaging tests):
  read passes without posting; a risky tool denies + posts a prompt that
  CONTAINS the recipient + subject but NOT the email body; fail-closed
  when `registry.send` throws; `summarizeToolDraft` per-actuator +
  generic + no-args.
- **Mutation-proven**: making the email draft include the body fails
  both the "omitting the body" and the post-content tests. Restored.
- `pnpm check`: EXIT=0. `pnpm lint`: 0/0. `pnpm check:capabilities`: ✓.
- No LLM request/response behavior changed — only the approval-prompt
  text; `smoke:live` is not the relevant gate.

## Decisions

- **Omit bulk/sensitive payloads from the draft** — email recipient +
  subject is enough to decide; echoing the full body back into a chat
  transcript would be noisy and a leak. The clip helper one-lines +
  truncates every field.
- **Widen the duck-typed input, no agent-core dependency** — kept the
  structural-shape approach (`@muse/messaging` stays free of an
  agent-core import); `arguments?` is a compatible superset read of the
  `ModelToolCall` the runtime already passes.
- **Frame as channel-surface hardening (P1)** — the gate governs ALL
  risky tools on the channel, not only the P17 actuators, so it deepens
  the two-way-channel target rather than P17 specifically.

## Remaining risks

- **No approve-completion round-trip yet** — the gate still denies the
  turn and posts the prompt; a "reply to approve → re-run the tool" flow
  is the larger remote-actuation epic, not this slice. The draft makes
  the deny + prompt genuinely informative in the meantime.
