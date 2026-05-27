## 847 — feat: `muse calendar add` — create an event from the terminal

## Why

`muse calendar` was a READ-only CLI surface (events / free / quick
ranges / import) — there was no way to CREATE an event from the
terminal. The AGENT can (the `muse.calendar.add` tool), but a terminal
user couldn't jot "Dentist tomorrow 3pm" without the API/agent. This
brings event creation to the CLI for the local calendar (the
zero-config default).

## Slice — new write subcommand (local calendar)

`apps/cli` commands-calendar.ts:
- `parseEventStart(raw, now?)` — `--at` accepts an ISO-8601 timestamp OR
  a relative phrase ("tomorrow 3pm", "내일 오후 3시", "in 2 hours") via the
  existing `resolveRelativeTimePhrase`; undefined when neither.
- `muse calendar add <title…> --at <when> [--for <minutes>] [--location]
  [--json]` — creates the event in the LOCAL calendar
  (`LocalCalendarProvider.createEvent`); `endsAt` = start + `--for`
  (default 60 min). An unparseable `--at` / non-positive `--for` is
  rejected with an actionable error before any write.

## Verify

`apps/cli` commands-calendar.test.ts (+6, 16 total):
- `parseEventStart`: ISO timestamp; a relative phrase → a future
  instant; unparseable → undefined.
- `muse calendar add` over a REAL temp local-calendar file
  (`MUSE_CALENDAR_FILE`): writes "Dentist appointment" readable back via
  `LocalCalendarProvider.listEvents` (default 60-min duration); `--for
  15` sets a 15-min duration; an unparseable `--at` errors with no event
  written.
- **Mutation-proven**: removing the ISO-prefix branch in
  `parseEventStart` breaks the ISO-parse + write tests; changing the
  default duration from 60 breaks the default-duration assertion.
  `apps/cli` 133/133, `pnpm check` EXIT 0 (0 non-voice failures), `pnpm
  lint` 0/0. CLI local-file write, no LLM request/response path → no
  smoke:live.

## Decisions

- **Local calendar only** — the OAuth (Google) / CalDAV providers need
  credential bootstrapping that's API-owned (the same boundary the read
  commands document); creating in the local calendar is the complete,
  zero-config capability. Remote-provider create is a separate future
  slice, not a half of this one.
- **Reuse `resolveRelativeTimePhrase`** so `--at` speaks the same
  natural-time grammar as the agent's `muse.calendar.add` tool and `muse
  tasks --due` / `muse remind`. CAPABILITIES line under the CLI calendar
  surface (no bullet flip — brings the agent's event-create to the
  terminal).
