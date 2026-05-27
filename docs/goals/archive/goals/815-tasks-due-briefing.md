# 815 — feat: tasks due today/overdue in the morning brief

## Why

The brief surfaced weather / inbox / home / birthdays / calendar but
NOT "what do I need to DO today" — the most central daily-driver
question. The loopback-tasks store persists `dueAt` (PersistedTask), so
the data exists; this surfaces open tasks due-soon (and overdue) in the
brief, mirroring the birthday (802) / home-alert (791) pattern.

## Slice

- `@muse/mcp` personal-tasks-store.ts — `resolveTasksDueLine(tasks, {
  now, withinDays=1 })` → "Pay rent (overdue); Buy milk (today); Call
  mom (tomorrow)" for OPEN tasks with a parseable `dueAt` within the
  window (overdue included + listed first); `undefined` when none.
- situational-briefing.ts — optional `tasksDue` line ("Due: …"),
  supplementary posture.
- situational-briefing-loop.ts — `tasksDueLine?` resolver (sensed when
  the brief has content; fail-soft).
- `apps/api` — tick pass-through + daemon binds it from the tasks file
  (`MUSE_BRIEFING_TASK_DUE_DAYS`, default 1) via `readTasks`.

## Verify

- `@muse/mcp` tasks-due-briefing.test.ts (new, 4): `resolveTasksDueLine`
  lists overdue→today→tomorrow within the window (skips done / no-dueAt
  / beyond-window), `undefined` when none, wider window pulls farther
  tasks; **end-to-end** — `runDueSituationalBriefing` with the resolver
  delivers a brief whose `Due: Pay rent (overdue)` line rides alongside
  the imminent Standup, via a real `MessagingProviderRegistry`.
- **Mutation-proven**: removing the `dayDiff > withinDays` window
  filter → far tasks leak / the none-case returns a line → 2 tests
  fail; restore → 4/4. Existing briefing tests 15/15. Full `pnpm check`
  EXIT 0 (a pre-existing voice-playback TTS-cleanup timeout flaked once
  under load, passed on retry — unrelated), `pnpm lint` 0/0. No model
  path → no `smoke:live`.

## Decisions

- **Overdue included, listed first** — a morning brief that hides
  overdue tasks is worse than useless; `dayDiff < 0` renders "overdue"
  and sorts to the top.
- Reads the loopback-tasks store directly (the cross-provider `Task`
  interface has no `dueAt`; the local store's `PersistedTask` does).
  No bullet flip — P20/P8 proactive-brief EXPAND. CAPABILITIES under P20.
