# 742 — fix: `muse scheduler next` orders the upcoming preview by instant, not lexicographic `when`

## Why

`muse scheduler next` merges scheduler jobs (`when = job.nextRunAt`)
and pending reminders (`when = rem.dueAt`) into one "soonest first"
preview, then `.slice(0, limit)`. It sorted lexicographically:

```ts
.sort((a, b) => (a.when ?? "").localeCompare(b.when ?? ""))
.slice(0, limit)
```

`rem.dueAt` is free-form (relative-phrase grammar, hand edits,
imports), so mixed precision / timezone offsets sort wrong — a
`…-05:00` dueAt whose real instant is LATER sorts before an earlier
`…Z` one. Two consequences: the preview is mis-ordered, and worse, the
`.slice(0, limit)` can DROP a genuinely-sooner item in favour of a
lexicographically-smaller-but-later one. Last remaining site of the
same bug class as 732 (`muse today`) / 733 (`/api/today`) / 734
(`muse remind/followup list`). The grep `localeCompare … dueAt|scheduledFor|when`
now shows only canonical-`createdAt` sorts and already-fixed
Date.parse-primary comparators (`personal-action-log-store`,
`inbox-surface`).

## Slice

New exported `comparePreviewEntriesByWhen` — compares parsed instants
(`Date.parse`), falls back to a deterministic string order for
unparseable values, ties break by label — and route the `.sort`
through it. Reminder dueAt and job nextRunAt now interleave in true
chronological order.

## Verify

- `@muse/cli` commands-scheduler-setup.test.ts (new): a `-05:00`-offset
  reminder dueAt orders after an earlier `Z` one; a job nextRunAt and a
  later reminder dueAt interleave soonest-first; equal instants break
  by label; unparseable values don't throw. **Mutation-proven** —
  swapping the comparator back to `localeCompare` fails the offset +
  mixed cases.
- `pnpm check`: EXIT=0. `pnpm lint`: 0/0 (standalone). Deterministic
  ordering — no model path, no `smoke:live`.

## Decisions

- **A local comparator, not the store's `compareRemindersByDueAt`** —
  the preview list mixes two entry shapes (`PreviewEntry`, not
  `PersistedReminder`), so the typed store comparator doesn't apply;
  the same Date.parse-primary + string-fallback shape is reused
  inline. This is the last free-form-field site in the class.
