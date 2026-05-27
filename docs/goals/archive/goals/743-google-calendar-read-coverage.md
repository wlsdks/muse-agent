# 743 — test: first coverage for the Google Calendar READ/parse path (`toEvent`)

## Why

`GoogleCalendarProvider` had contract-faithful tests only for its
WRITE path (`calendar-write-contract.test.ts`: create/update/delete).
The READ path — `listEvents` → `toEvent` / `parseGoogleTime` — was
uncovered, despite parsing the Google Calendar v3 event shape where
the timed-vs-all-day distinction is exactly the kind of detail that
regresses silently:

- timed events carry `start.dateTime` (RFC3339 with offset);
- all-day events carry `start.date` (`YYYY-MM-DD`, no `dateTime`) and
  an EXCLUSIVE `end.date` (the day after);
- `allDay = Boolean(start.date) && !start.dateTime`;
- missing `summary` → `"(untitled)"`.

A bug hunt across the read path (and ~a dozen other fresh surfaces this
run) found the parsing correct, so this iteration locks the behavior
rather than fixing a defect.

## Slice

New `GoogleCalendarProvider READ` block in `calendar.test.ts` using the
same contract-faithful HTTP fake the write tests use (OAuth token
endpoint + events payload):

- a `-05:00`-offset timed event → `allDay:false`, `startsAt`/`endsAt`
  resolved to the correct UTC instants (offset-aware);
- an all-day event (`start.date`, no `dateTime`) → `allDay:true`,
  `startsAt` at date-midnight UTC, `endsAt` at the exclusive end date;
- a payload with no `summary` → title `"(untitled)"`.

## Verify

- `@muse/calendar` calendar.test.ts — all green (49). **Load-bearing**:
  mutating `toEvent`'s `allDay` computation to a constant `false` fails
  the all-day case.
- `pnpm check`: EXIT=0. `pnpm lint`: 0/0 (standalone). No source change
  (the provider HTTP path is faked) → no `smoke:live`, no CAPABILITIES
  line (test-only).

## Decisions

- **Coverage, not a forced fix** — the read path was correct under
  every probed shape (offset instants, exclusive all-day end, title
  fallback); manufacturing a "bug" would be dishonest churn. First
  coverage of an uncovered external-API parser is the real value.
- **Reused the project's contract-faithful HTTP-fake convention** — a
  fake `fetchImpl` that answers the OAuth + events endpoints, never a
  fake provider, so the test exercises the actual request/parse code.
