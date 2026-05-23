## 867 — feat: `muse calendar delete` — cancel a local calendar event

## Why

847 added `muse calendar add`, and `CalendarProvider.deleteEvent(id)`
exists + `LocalCalendarProvider` implements it — but no CLI surface
invoked it. So you could CREATE a calendar event from the terminal but
never CANCEL/remove one ("cancel my 3pm"): create-but-can't-remove, the
same gap class as 862 (notes delete). Worse, `muse calendar events`
didn't show event ids, so even with a delete there'd be no way to
identify which event to remove.

## Slice

`apps/cli`:
- `muse calendar delete <id>` — resolves the id against the local
  calendar (exact, else unique short-id prefix) over a ±10y window,
  then `deleteEvent`. Reports "Cancelled: <title>"; an unknown id exits
  1, an ambiguous prefix asks for a longer id — nothing deleted in
  either case.
- `formatCalendarEvents` now prefixes each event line with a short
  `[id]` so the id to pass to `delete` is visible in
  `muse calendar events` / `tomorrow` / `this-week` (the listing tests
  assert substrings, so the time/title rendering is unchanged).

## Verify

`apps/cli` commands-calendar.test.ts (+2): create an event via the real
`LocalCalendarProvider`, `delete` it by its 8-char prefix → "Cancelled:
Dentist" and the store is empty; an unknown id exits 1 and leaves the
event. human-formatters.test.ts stays green (substring assertions).
- **Mutation-proven**: making the resolver exact-only (drop the
  unique-prefix fallback) fails the prefix-delete test.
- `pnpm check` EXIT 0 (the `[id]` prefix broke no `today`/`events`
  consumer), `pnpm lint` 0/0. Local provider only — no LLM path.

## Decisions

- **Short-id prefix resolution**, same ergonomics as `muse inbox <id>`
  (854): the listing shows an 8-char id; delete resolves exact-or-unique-
  prefix. Exact wins; ambiguous prefix is reported, never a guess.
- **Local provider only** — `add` is local-only too; cancelling a
  Google/CalDAV event is a separate (credentialed) slice. The local
  path is fully exercised end-to-end here.
- `deleteEvent` already throws `EVENT_NOT_FOUND`, but resolving against
  `listEvents` first lets the CLI give a precise not-found / ambiguous
  message and echo the cancelled event's title.
- No new dependency.
