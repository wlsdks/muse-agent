# 731 — P17 remote: opt-in in-chat approval completion — a channel "yes" re-runs the pending tool end-to-end

## Why

730 detected an inbound approval reply and bridged it to the CLI
(`muse approvals approve <id>`). The remaining half — actually re-running
the tool in-chat so the whole loop happens in Telegram/chat — needed the
actuator orchestration callable server-side (the API agent runtime
doesn't register the actuator tools; only `muse ask --actuators` does).
This adds the shared dispatcher and wires it in behind an OPT-IN flag, so
the capability ships without changing the default safety posture.

## Slice

- `packages/mcp/src/run-actuator-by-name.ts` (new): `runActuatorByName(
  tool, args, deps)` — dispatches `email_send` / `web_action` /
  `home_action` to their proven `*WithApproval` orchestrations (via the
  709 tool factories) with an INJECTED approval gate + env-resolved
  providers; returns `{ran}` / `{ran:false, reason}`. The shared
  re-run primitive (CLI passes a clack gate; chat passes auto-approve).
- `apps/api/src/inbound-approval-handler.ts`: `handleInboundApprovalReply`
  gains an opt-in `autoRun` path — when supplied AND exactly ONE
  un-expired pending exists, re-run + clear on success (replay-guard) +
  report; multiple pending is ambiguous (lists ids, never guesses);
  default (no `autoRun`) keeps the 730 bridge ack.
- `apps/api/src/server.ts`: when `MUSE_INBOUND_AUTO_APPROVE=true`, build
  the `autoRun` closure = `runActuatorByName` with auto-approve gates +
  env providers; otherwise omit it (default off).

## Verify

- `@muse/mcp` run-actuator-by-name.test.ts (663): each actuator
  approve→one HTTP-faked send / deny→declined / unavailable (no
  token/config) / unknown-tool → no fire.
- `@muse/api` inbound-approval-handler.test.ts (307): autoRun + single
  pending → runs + cleared (replay → empty); failed run → stays pending
  + CLI hint; MULTIPLE pending → ambiguous, autoRun NOT called.
  **Mutation-proven**: loosening the single-pending guard (`=== 1` →
  `>= 1`) fails the ambiguity test. Restored; green.
- `pnpm check`: EXIT=0. `pnpm lint`: 0/0 (standalone — fixed an unused
  test var). `pnpm check:capabilities`: ✓.
- No LLM request/response path touched — the approval handling
  short-circuits BEFORE the agent run.

## Decisions

- **Opt-in, default OFF** — auto-firing an outbound action on a parsed
  "yes" is a real posture choice; default-off keeps the deliberate
  `muse approvals approve` CLI confirm as the path, and the user opts
  into in-chat auto-completion explicitly via `MUSE_INBOUND_AUTO_APPROVE`.
  This ships the capability without unilaterally widening the autonomous
  send surface.
- **Single-pending only** — a "yes" with multiple pending is ambiguous;
  the handler refuses to guess and lists the ids instead, so the wrong
  action can't fire.
- **Auto-approve is outbound-safety-compliant here** — the draft was
  shown in the channel prompt (712) when the gate first refused; the
  reply is the user's explicit confirm of THAT content, not the agent
  acting on its own judgement.
- **Shared `runActuatorByName` in @muse/mcp** — one tested dispatch point
  for both the CLI-approve (729) and chat paths; the API never imports
  the CLI's `buildActuatorTools`.

## Remaining

- `muse approvals approve` (729, CLI) still has its own buildActuatorTools
  dispatch; a later refactor could delegate it to `runActuatorByName` to
  fully de-dup. Not done here to keep this slice focused + 729 untouched.
