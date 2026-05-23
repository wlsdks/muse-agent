## 838 — feat: `muse today` shows each task's urgency

## Why

`muse today` — the on-demand "what's my day" command — listed up to 50
open tasks as bare titles with NO due indicator, so a deadline today
looked identical to a someday-idea. The proactive brief's due line
already flags "(overdue)/(today)" (832/834); the terminal command
should too. The due date was available on both the local
(`serializeTask`) and remote (`/api/today` row) paths but the CLI
dropped / never declared it.

## Slice — CLI-only, both modes (no server change)

`apps/cli` commands-today.ts:
- `TodayBriefing.tasks` gains an optional `dueAt` (the remote
  `/api/today` row already carries it at runtime; the local path now
  keeps it instead of mapping to bare `{id,title}`).
- pure `relativeDueTag(dueAtIso, now)` → " (overdue)" / " (today)" /
  " (tomorrow)" / " (in N days)", "" when undated / unparseable.
  Calendar-day diff (local midnights) so a dueAt later today still
  reads "(today)".
- `formatTasks(tasks, now)` appends the tag; `now` is the briefing's
  `generatedAt`. Works in BOTH local and remote modes (dueAt present in
  both).

## Verify

`apps/cli` commands-today.test.ts (+2 describes, 11 total):
- `relativeDueTag`: overdue / today / tomorrow / in-N-days; a dueAt
  later TODAY still reads "(today)"; undated + unparseable → "".
- `formatTasks`: renders "Pay rent (overdue)" and leaves an undated
  task a bare title (no spurious tag).
- **Mutation-proven**: breaking the `dayDiff < 0` overdue boundary
  fails the overdue tests; removing the `Number.isFinite(ms)` guard
  makes an unparseable dueAt render " (in NaN days)" and fails the
  unparseable test. `apps/cli` 131/131, `pnpm check` EXIT 0, `pnpm
  lint` 0/0. CLI display, no LLM request/response path → no smoke:live.

## Decisions

- **CLI-only** — both the local store (`serializeTask.dueAt`) and the
  remote `/api/today` row already carry the due date at runtime; only
  the CLI type+render dropped it, so no server change is needed and
  both modes light up at once (not half-built).
- **Tag every dated task, not just due-soon** — even "(in 12 days)" is
  useful urgency context in the daily view; only undated tasks stay
  bare. CAPABILITIES line under the CLI/Reach surface (no bullet flip —
  brings the brief's urgency signal to the terminal command).
