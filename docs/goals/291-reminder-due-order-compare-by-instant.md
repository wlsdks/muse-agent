# 291 — reminder list ordering used raw ISO string compare (goal 290 sibling)

## Why

`muse.reminders.list` and `muse.reminders.search` (the MCP
loopback `muse.reminders` server, also feeding `muse today`)
present reminders soonest-due-first. Both sorted with:

```ts
.sort((left, right) => left.dueAt.localeCompare(right.dueAt))
```

`PersistedReminder.dueAt` is a free-form `string`. The MCP `add`
path normalises via `parseReminderDueAt` → canonical `…Z`, but —
exactly as goal 290 found for tasks — not every write path does:
a hand-edited `~/.muse/reminders.json`, an import, the REST
surface, or `snooze` can hold any ISO form. Lexicographic ISO
order is wrong across **mixed precision** (`"…00.500Z"` sorts
before `"…00Z"`) and **timezone offsets** (`"…18:00+09:00"` =
`09:00Z` sorts after `"…10:00Z"`), so the list would surface the
**wrong reminder as most imminent** — the silent-wrong this loop
closed for the inbox cursor (281) and the task comparator (290).
Reminders are the untreated parallel of the task surface, and the
two should order identically (a JARVIS triages tasks and
reminders by the same rule).

## Scope

`packages/mcp/src/personal-reminders-store.ts`:

- Add an exported `compareRemindersByDueAt`, parallel to
  `compareTasksByDueDate`: compare `Date.parse` instants
  (soonest first); equal instants break to newest-created-first;
  unparseable values keep the prior `localeCompare` order. One
  short WHY comment records the free-form-string / mixed-format
  rationale. Re-exported from the `@muse/mcp` barrel.

`packages/mcp/src/loopback-reminders.ts`:

- `muse.reminders.list` and `muse.reminders.search` now
  `.sort(compareRemindersByDueAt)` instead of the inline
  `dueAt.localeCompare`.

Behaviour-preserving for canonical `…Z` reminders (instant order
== the prior lexicographic result). The only changes: mixed
precision / offset now order correctly, and equal-`dueAt`
reminders now break to newest-created-first (deterministic,
matching the task comparator) instead of arbitrary file-read
order — a consistency improvement, and no list-ordering test
asserted the old tie behaviour.

## Verify

- `pnpm --filter @muse/mcp test` — 346 pass (was 344; +2). New
  `compareRemindersByDueAt` tests: a `+09:00` earliest instant
  that string-sorts last and a `…00.500Z` entry are ordered by
  true instant; an equal-instant pair (`…09:00Z` vs
  `…18:00+09:00`) breaks to newest-created. Existing reminder
  add / snooze / summarise / list tests stay green (canonical
  inputs unchanged).
- `pnpm check` — every workspace green (mcp 346, apps/cli 561,
  apps/api 160, all packages). `pnpm lint` — exit 0.
- No real-LLM request/response path touched (pure deterministic
  comparator). A live Qwen run cannot reproduce a
  mixed-precision / offset `dueAt` ordering on demand, so the
  deterministic regression is the rigorous verification — same
  stance as siblings 281 / 290 and 261 / 274–289.

## Status

done — reminder triage (`muse.reminders.list` /
`muse.reminders.search` / `muse today`) now orders by the real
due *instant*, consistent with task ordering (goal 290), so a
mixed-precision or timezone-offset `dueAt` can no longer surface
the wrong reminder as most imminent. Canonical-ISO ordering is
unchanged.
