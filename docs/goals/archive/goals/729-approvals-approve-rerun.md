# 729 — P17 remote: `muse approvals approve <id>` re-runs a pending channel action — the round-trip completes (via CLI)

## Why

728 shipped the pending-approval worklist: a channel-refused risky tool
is persisted with its structured `tool` + `arguments`, listable via
`muse approvals`. The remaining half was actually RE-RUNNING it once the
user approves. This delivers that completion via the CLI surface —
safe (a clack confirm shows the exact draft; no auto-fire from a parsed
chat reply), complete, and reusing the proven actuator orchestration.
The more-automated in-CHAT reply path (reply "yes" in Telegram → re-run
without leaving the chat) stays open — it needs reply-intent detection +
inbound-runner re-execution-without-re-gating, a separate slice.

## Slice

- `apps/cli/src/commands-approvals.ts`: `approvePendingApproval(opts)` —
  loads the un-expired pending entry by id, rebuilds the matching
  actuator tool via `buildActuatorTools` (709) with a clack confirm,
  calls its `execute(arguments)` (which runs resolve → confirm → send),
  and on success (`sent`/`performed` true) `clearPendingApproval`s it
  (replay-guard). `confirmAction` / `fetchImpl` are injectable for tests.
  Outcomes: `ran` / `declined` / `not-found` / `no-tool`.
- `muse approvals approve <id>` command maps those to stdout + exit codes.

## Verify

- `@muse/cli` commands-approvals.test.ts (1285): CONFIRM → one request
  fires, entry cleared, a replay approve → `not-found` (no second
  request); DENY at the confirm → no request, entry stays pending;
  unknown / expired id → `not-found`, nothing fired; a non-actuator
  pending tool → `no-tool`, not cleared.
- **Mutation-proven**: removing the clear-on-success makes the
  replay-guard assertion (second approve must not re-fire) fail.
  Restored; green.
- Dog-fooded the non-interactive path: `muse approvals approve ghost` →
  "No pending approval … (it may have expired)", exit 1.
- `pnpm check`: EXIT=0. `pnpm lint`: 0/0. `pnpm check:capabilities`: ✓.
- No LLM request/response path touched — re-run goes through the actuator
  tool's HTTP send (HTTP-faked in tests), not the model.

## Decisions

- **CLI-approve, not auto-fire-from-chat-reply** — re-running a
  state-changing action on a parsed "yes" from chat is a sharper
  posture; the CLI path keeps a real clack confirm of the exact draft
  (outbound-safety draft-first) and is where the actuator confirms
  already live (709). The in-chat auto-path is recorded as the remaining
  `[ ]` bullet.
- **Clear only on success** — a declined confirm or a non-actuator tool
  leaves the entry pending (the user can retry / inspect); only a
  genuine send clears it, so the worklist reflects reality and a second
  approve can't double-fire.
- **Reuse `buildActuatorTools`, no new execution path** — the re-run is
  exactly the same orchestration `muse ask --actuators` uses, so the
  fail-closed gate + provider wiring are inherited, not re-implemented.
