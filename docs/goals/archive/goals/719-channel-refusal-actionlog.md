# 719 — P17 remote (audit half): channel-gate refusals are recorded to the action log, closing an outbound-safety gap

## Why

`outbound-safety.md` rule 4: *every outbound action — sent OR refused —
appends a rationale-bearing entry to the action log.* The
`createChannelApprovalGate` (the fail-closed gate for risky tools an
inbound channel message triggers) DENIED + posted an in-chat prompt but
recorded **nothing** — so a remote attempt to run a risky tool left no
trail, and `muse actions` couldn't show what the agent was blocked on.
This is both a compliance gap and the missing audit foundation for the
remote approve-completion round-trip (the genuine north-star: the agent
acts when addressed on a real channel).

## Slice

- `packages/messaging/src/channel-approval-gate.ts`: add an injected,
  optional `recordRefusal(refusal)` hook + `ChannelApprovalRefusal`
  type. On a refused risky tool the gate calls it **fail-soft** (a
  throwing recorder never flips the deny) before posting the prompt.
  `@muse/messaging` stays free of any `@muse/mcp` / action-log
  dependency — the caller owns where the refusal is recorded.
- `apps/api/src/channel-refusal-recorder.ts` (new):
  `createChannelRefusalRecorder` → builds a `refused` `ActionLogEntry`
  (`what = Muse wanted to run "<tool>" (<risk>) — <draft>`, `why =
  inbound <provider> message; fail-closed gate refused — awaiting
  approval`, `userId = providerId:source`) and `appendActionLog`s it.
- `apps/api/src/server.ts`: wire the recorder into the inbound runner's
  `createChannelApprovalGate` using `resolveActionLogFile(env)`.

## Verify

- `@muse/messaging` channel-approval-gate.test.ts (211): records on a
  risky deny with `{tool, risk, draft, userId}`; does NOT record for a
  read tool; **stays fail-closed when the recorder throws** (still
  denies + still posts). Mutation-proven (removing the `recordRefusal`
  call breaks the path).
- `@muse/api` channel-refusal-recorder.test.ts (296): appends a
  `refused` entry readable via `readActionLog` (what/why/result/when/
  userId); `providerId:source` userId fallback; delegates to the
  injected append fn with the resolved file.
- `pnpm check`: EXIT=0. `pnpm lint`: 0/0. `pnpm check:capabilities`: ✓.
- No LLM request/response path touched — the gate's decision logic is
  unchanged apart from the fail-soft record; the agent run is identical.

## Decisions

- **Injected `recordRefusal`, not an action-log import in messaging** —
  `@muse/messaging` depends only on `@muse/shared`; keeping it that way
  (same duck-typed approach as the gate's registry) means the
  action-log seam lives in apps/api, which already depends on both.
- **Fail-soft recording** — a wedged disk must never turn a fail-closed
  refusal into an allow; recording errors are swallowed, the deny holds.
- **Reuse the action log + `muse actions`, no new store/command** — the
  trail belongs with every other sent/refused action, and the read
  surface already exists; a bespoke pending-approvals store would be
  redundant for the audit half.

## Status

P17 REMOTE surface — audit half delivered + bullet flipped. The
completion half (an inbound "approve" reply re-runs the exact gated
tool — the approve-completion round-trip) is recorded as the next `[ ]`
P17 bullet; this iteration deliberately ships only the audit foundation,
not half of the round-trip.
