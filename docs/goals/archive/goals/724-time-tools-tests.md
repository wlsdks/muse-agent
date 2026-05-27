# 724 — test: cover the LLM-facing time/scheduling tools (time_now / time_diff / time_add / time_relative / next_weekday / cron_for_datetime)

## Why

`packages/tools/src/muse-tools-time.ts` ships six tools the model calls
to reason about time and build schedules — wall-clock + IANA timezone
formatting, signed durations, date arithmetic, weekday resolution, and
ISO→cron conversion — and had **zero** test coverage. These feed
reminder/scheduler creation, so a silent regression (a wrong cron, an
off weekday, a mishandled timezone) would put the user's reminders at the
wrong time with no signal. `testing.md` mandates direct unit coverage for
every helper export; this closes that gap. Same play as 713 (data tools)
on a fresh surface (PROCEDURE Step 8 rotation: recent iterations touched
messaging/channel, model, calendar, notes-rag).

## Slice

- `packages/tools/src/muse-tools-time.test.ts` (new): behavioural tests
  with an injected clock —
  - **time_now**: ISO/epoch/timezone + weekday for `Asia/Seoul`; UTC
    default; unsupported zone → error.
  - **time_diff**: signed ms + humanized (`1h 30m` / `-1h 30m`); non-ISO
    → error.
  - **time_add**: summed signed offsets (`+1d2h`, `-90m`); bad base →
    error.
  - **time_relative**: future/past/now vs the injected clock and an
    explicit reference; bad reference → error.
  - **next_weekday**: strictly-next occurrence (full name + abbrev,
    case-insensitive), same-weekday-as-reference → +1 week; unknown →
    error.
  - **cron_for_datetime**: once/daily/weekly/monthly cron strings; the
    monthly day > 28 warning; bad mode / bad ISO → error.

## Verify

- `@muse/tools` muse-tools-time.test.ts passes (146 tools tests green).
- `pnpm check`: EXIT=0. `pnpm lint`: 0/0.
- No bug surfaced — the tools are correct (the monthly-day>28 warning and
  the strict-next-weekday logic are already handled); this is genuine
  coverage of a previously-untested, LLM-facing module, not a fix.
- No LLM request/response path touched (pure unit tests; no
  CAPABILITIES line — coverage, not a new capability).

## Decisions

- **Inject the clock, assert exact computed values** — `now: () => fixed
  Date` makes `time_now` / `time_relative` / `next_weekday` deterministic;
  assertions pin precise cron strings, ISO results, and humanized phrases
  rather than just "is a string", so a real regression fails.
- **Weekly cron asserts a shape, not a hardcoded weekday** — `^30 9 \* \*
  [0-6]$` avoids baking in a possibly-wrong day-of-week constant while
  still pinning the format.
