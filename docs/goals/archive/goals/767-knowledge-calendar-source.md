# 767 — feat: knowledge_search spans the calendar (notes + tasks + calendar)

## Why

The knowledge corpus already spans notes (755) + tasks (766). The
user's CALENDAR holds the third pillar of "what's going on" — "Acme
strategy meeting Thursday", "dentist next week". A unified semantic
search across notes + tasks + calendar answers "what do I have with
Acme this week?" by pulling the note, the task, AND the meeting in one
shot.

## Slice

`@muse/autoconfigure` knowledge-corpus.ts:
- `CalendarEventSource` (structural — the `CalendarProviderRegistry`
  and any single provider satisfy `listEvents(range)`).
- `assembleKnowledgeCorpus` gains `calendarSource`: pulls events in a
  recent+upcoming WINDOW (default `[-7d, +30d]`, configurable; `now`
  injectable) as `event/<id>` chunks (title @ location on date +
  notes). Windowed so ancient / far-future events don't add noise.
  Fail-open if the source throws.
- `createNotesKnowledgeSearchTool` accepts `calendarSource`; the
  assembly passes `calendarRegistry` (its `CalendarEvent[]` satisfies
  `CalendarEventLike[]`) so the live tool searches notes + tasks +
  calendar.

## Verify

- `@muse/autoconfigure` knowledge-calendar-source.test.ts (new, 2)
  with a contract-faithful source that HONOURS the queried range:
  - a `+2d` event is included as `event/ev1`; a `-60d` and a `+60d`
    event are excluded (windowed out) — injectable `now` makes the
    window deterministic.
  - end-to-end `knowledge_search("what's the acme renewal meeting
    about?")` answers from the event and cites `event/evX`.
- Prior knowledge tests still green (notes-only / tasks paths, 8/8).
- **Mutation-proven**: widening the `calendarDaysAhead` default
  30 → 90 lets the `+60d` event leak into the corpus → the windowing
  test fails; restore → 2/2.
- Full `pnpm check` EXIT 0 (autoconfigure 183, every workspace green);
  `pnpm lint` 0/0. Contract-faithful source + deterministic fake embed
  — no model request/response path → no `smoke:live`.

## Decisions

- **Windowed (recent + upcoming), not all events** — a calendar query
  is about what's near; pulling the whole history would bury the
  relevant event and bloat per-query embedding. `[-7d, +30d]` default,
  configurable.
- **`event/<id>` source label** — a cited answer names the calendar as
  the origin, distinct from `notes/` / `task/`. No bullet flip — P20
  knowledge is already `[x]`; this completes the core personal corpus
  (notes + tasks + calendar). Contacts is a natural further source,
  follow-on.
