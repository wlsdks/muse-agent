## 833 — feat: `muse calendar free` — free/busy on the terminal

## Why

827 gave the AGENT a free/busy capability (`computeAvailability` +
`muse.calendar.availability`), but the CLI had no equivalent: `muse
calendar` could `events`/`tomorrow`/`this-week` but never answer "am I
free this afternoon?" / "find me a gap". Server, CLI and tool are
parallel surfaces over the same runtime — the terminal user deserves
free/busy too. This composes the already-tested availability engine
onto the CLI (a fresh surface this session).

## Slice

`apps/cli` commands-calendar.ts:
- `muse calendar free [--from <iso>] [--to <iso>] [--min-minutes <n>]
  [--provider <id>] [--local] [--json]` — fetches the window's events
  (local provider OR the API `/api/calendar/events`, same dual path as
  `events`), runs `computeAvailability`, and prints fully-free / the
  busy blocks / the free gaps. Defaults now → +8h.
- `eventsToAvailability(rows)` — maps an event payload row
  (`startsAtIso`/`endsAtIso`/`title`/`allDay`) to the engine's shape,
  skipping a row with an unparseable time.
- `formatAvailability(result, window)` — the human summary ("Free all
  of 09:00–17:00." / "Busy: 10:00–11:00 Standup\nFree: 09:00–10:00,
  11:00–17:00").

## Verify

`apps/cli` commands-calendar.test.ts (+6, 10 total):
- `eventsToAvailability` maps rows + skips an unparseable time.
- `formatAvailability` renders fully-free and busy/free.
- **Surface-level**: a `runCalendarFree` harness builds the REAL
  `commander` command and drives it through the API events seam
  (contract-faithful fake apiRequest returning events): `free --json`
  computes busy=1/free=2 from a fetched 10–11 meeting in a 9–17 window
  and hits `/api/calendar/events`; no events → "Free all of …";
  `--min-minutes lots` → the actionable error before computing.
- **Mutation-proven**: removing `formatAvailability`'s `fullyFree`
  branch fails the fully-free tests; removing
  `eventsToAvailability`'s unparseable-skip fails the mapping test.
  Full `pnpm check` EXIT 0, `pnpm lint` 0/0. CLI surface, no LLM
  request/response path → no smoke:live.

## Decisions

- **Reuse `computeAvailability`, format in the CLI** — the engine is
  already exhaustively tested (827); the CLI slice is the fetch + map +
  human formatting, each covered here. No logic duplication.
- **Dual local/API path** mirroring the existing `events` command so
  `free` behaves the same with or without a running server.
  CAPABILITIES line under the CLI/Reach surface (no bullet flip —
  brings the delivered availability capability to the terminal).
