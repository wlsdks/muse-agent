## 876 — feat: `muse calendar show <id>` — read one event's full details

## Why

`muse calendar events` lists time/title/location but DROPS the event's
`notes` (and shows no full per-event view). An event imported (.ics) or
synced from a provider often carries notes — agenda, dial-in, prep —
that the user couldn't read from the CLI at all (only `--json` on the
list). The read counterpart to add/delete/edit; parallel to
`muse inbox <id>` (854).

## Slice

`apps/cli` commands-calendar.ts: `muse calendar show <id>` — resolves
the id (exact or unique short-prefix, via the shared `resolveEventIdMatch`
from 868) and prints title, start→end, location, tags, and the full
notes block. Unknown / ambiguous id → exit 1 (no guess). `--json` emits
the raw event.

## Verify

`apps/cli` commands-calendar.test.ts (+1): an event created (with notes
+ location) via the real `LocalCalendarProvider` is shown by its 8-char
prefix — output contains the title, `@ Room 4`, and the notes; an
unknown id exits 1.
- **Mutation-proven**: dropping the notes block from the renderer fails
  the details test.
- `pnpm check` EXIT 0 — apps/cli's only failures were the known
  voice-playback `/tmp` flake (a feeds-refresh network flake appeared
  once, passed 26/26 in isolation, did not recur); mcp 928, autoconfigure
  262, api 323 all green. `pnpm lint` 0/0. Local provider, no LLM path.

## Decisions

- Reuses `resolveEventIdMatch` (868), so show/delete/edit share one
  exact-or-unique-prefix resolver and identical not-found/ambiguous
  behaviour.
- The events LIST stays terse (no notes inline — that would clutter);
  `show` is where the full detail lives, mirroring inbox list vs
  `inbox <id>`.
- No new dependency.
