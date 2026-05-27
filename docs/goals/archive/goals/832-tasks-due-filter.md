## 832 — feat: "what's due today / this week?" — tasks list dueWithinDays

## Why

"What's due today?" / "anything due this week?" is the core todo-list
question. The `muse.tasks` `list` tool filtered only by `status` and
sorted due-soonest-first, so the local model had to pull every open
task and reason about each `dueAt` — the multi-step reasoning a small
model does unreliably (the same gap 827 calendar-availability and 831
home-state filters closed). The due-window logic already existed inside
`resolveTasksDueLine` (the morning brief) but wasn't reachable on
demand.

## Slice — share the selector, deepen the tool

- `@muse/mcp` personal-tasks-store.ts — extracted the canonical
  calendar-day due-window logic into a pure `selectTasksDueWithin(tasks,
  {now, withinDays})` returning `{task, dayDiff}[]` (open + dated, due
  date within N days INCLUDING overdue, soonest/most-overdue first).
  `resolveTasksDueLine` now delegates to it, so the morning brief and
  the on-demand list use the SAME window (can't drift).
- `@muse/mcp` loopback-tasks.ts — `list` gained an optional
  `dueWithinDays`: with it, the tool returns the due-within selection
  (overdue included, soonest first); 0 = today + overdue, 7 = this
  week. Omitting it is the prior status-based listing. One tool + an
  arg (no new catalog entry) per tool-calling.md rule 5.

## Verify

`@muse/mcp` tasks-due-filter.test.ts (7):
- `selectTasksDueWithin`: withinDays 0 → overdue+today; 7 → overdue/
  today/in3 (excludes in10, undated, done, invalid dueAt); carries the
  signed dayDiff; defaults to 1.
- the `list` tool over a REAL temp-file store: `dueWithinDays:7` → the
  three due tasks overdue-first; `:0` → overdue+today; WITHOUT it →
  status listing (all tasks, unchanged).
- **Mutation-proven**: dropping the open/dated guard, and dropping the
  `dayDiff > withinDays` cutoff, each break the selector + tool tests.
  The existing `resolveTasksDueLine` briefing tests (4) still pass
  (refactor is behaviour-preserving). Full `pnpm check` EXIT 0, `pnpm
  lint` 0/0. `list`'s name/keywords unchanged → selection unaffected,
  only arg-filling is new → no smoke:live (and Ollama down).

## Decisions

- **Extract + share, don't duplicate** — the brief and the on-demand
  list answering "what's due" differently would be a subtle bug;
  `selectTasksDueWithin` is the single source of the window so they
  agree by construction.
- **Overdue counts as due** — "what's due today" must surface an
  overdue task (a negative dayDiff is ≤ withinDays), or the most
  important items silently vanish. CAPABILITIES line under P20 / tasks
  daily-driver (no bullet flip — deepens the existing list tool).
