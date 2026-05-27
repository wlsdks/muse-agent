## 868 — feat: `muse calendar edit` — reschedule / rename a local event

## Why

867 gave the local calendar add + delete; the provider also has
`updateEvent`, but no CLI invoked it. So "reschedule my 3pm to 4pm" /
rename an event couldn't be done from the terminal — the last hole in
local calendar CRUD (create/read/delete present, no update).

## Slice

`apps/cli` commands-calendar.ts:
- `muse calendar edit <id> [--at <when>] [--for <min>] [--title …]
  [--location …]` — resolves the id (the shared resolver), then
  `updateEvent`. `--at` reschedules and **preserves the original
  duration** unless `--for` overrides it (the natural "move" semantic);
  `--title` / `--location` update those. At least one field is required.
- Extracted `resolveEventIdMatch(events, target)` — exact match wins,
  else a UNIQUE id-prefix, else `ambiguous` / `none` — and refactored
  867's `delete` to use it (one resolver, two commands, both never act
  on the wrong/ambiguous event). A `listLocalEventsWide` helper shares
  the ±10y resolution window.

## Verify

`apps/cli` commands-calendar.test.ts (+7, 25 total):
- `resolveEventIdMatch`: exact-wins (even when also a prefix), unique
  prefix, ambiguous (count), none.
- `edit --at` reschedules and preserves the 60-min duration; `--title`
  + `--for` rename and re-duration; no-fields errors "at least one of";
  unknown id exits 1 — driven through the real `LocalCalendarProvider`.
- delete tests stay green on the refactored resolver.
- **Mutation-proven**: making `--at` not preserve the duration (0
  instead of the original span) fails the reschedule test.
- `pnpm check` EXIT 0 (only the known voice flake), `pnpm lint` 0/0.
  Local provider — no LLM path.

## Decisions

- **`--at` preserves duration** — "move my 3pm to 4pm" keeps the
  meeting's length; `--for` is the explicit override. Matches how a
  person thinks about rescheduling.
- Shared `resolveEventIdMatch` keeps delete + edit consistent (exact /
  unique-prefix / ambiguous / none) and is unit-tested directly.
- Local provider only (like add/delete); a Google/CalDAV edit is a
  separate credentialed slice. No new dependency.
