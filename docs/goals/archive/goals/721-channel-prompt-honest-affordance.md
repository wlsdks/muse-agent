# 721 — fix: the in-chat approval prompt stops promising "reply to approve" (no round-trip exists)

## Why

`createChannelApprovalGate` refuses a risky tool triggered by an inbound
channel message and posts a prompt that ended with *"reply to approve
before it can run."* But there is **no approve-completion round-trip** —
replying does nothing (it's the open `[ ]` P17 bullet). So the prompt was
a **false affordance** on a fail-closed safety surface: it told the user
an action they can't actually take. Misleading guidance on what Muse will
or won't do erodes the exact trust the gate exists to protect.

This continues the channel-actuation thread (712 draft prompt, 719
refusal logging) the autonomous loop has been building.

## Slice

- `packages/messaging/src/channel-approval-gate.ts`: replace the tail of
  the posted prompt. Was: `Approval needed: … reply to approve before it
  can run.` Now: `🔒 Muse wanted to run "<tool>" (<risk>) — <draft>. It
  was NOT executed — Muse won't run a state-changing action from a chat
  message on its own. It needs your explicit approval and has been logged
  for your review.` Truthful (matches 719's recorded-refusal behaviour),
  no mechanism it can't honour.

## Verify

- `@muse/messaging` channel-approval-gate.test.ts: the posted text
  contains "NOT executed" and does NOT contain "reply to approve"; the
  draft (recipient/subject) is still present and the body still omitted
  (712 invariant holds). HTTP-path `test/channel-approval-gate.test.ts`
  and `@muse/api` p1-seam.test.ts updated to assert the honest wording.
- `pnpm check`: EXIT=0 (caught two other tests pinning the old
  "Approval needed" string — both updated). `pnpm lint`: 0/0.
  `pnpm check:capabilities`: ✓.
- No LLM request/response path touched — the change is the gate's posted
  message text; the agent run is unchanged.

## Decisions

- **State the truth, don't echo a re-run command** — generating a
  ready-to-run CLI command would mean echoing the email body back into
  the chat transcript, the exact leak 712 closed; so the prompt explains
  *why* it stopped (Muse won't auto-act from chat) and that it's logged,
  rather than handing back a copy of the payload.
- **Not a regression of intent** — the approve-completion round-trip
  stays the open P17 bullet; when it lands, the prompt can promise a
  reply path again because one will actually exist. Until then, honesty
  beats an aspirational lie.
