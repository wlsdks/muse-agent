# 670 — `formatCalendarEvents` renders event times in the host's LOCAL timezone (and groups by local day) instead of slicing the raw UTC ISO string, so `muse calendar` / the calendar section of `muse brief` no longer shows wrong times — and mis-groups midnight-adjacent events — for any non-UTC user

## Why

`apps/cli/src/human-formatters.ts:formatCalendarEvents`
displayed event times by literally slicing the ISO string:

```ts
const day = event.startsAtIso.slice(0, 10);     // UTC date
const time = event.startsAtIso.slice(11, 16);   // UTC HH:MM
const end = event.endsAtIso ? `–${event.endsAtIso.slice(11, 16)}` : "";
```

When the calendar provider returns an absolute UTC instant
(`2026-05-20T02:00:00Z` — Google's RFC3339 with `Z`, or the
local-file provider's `.toISOString()`), this prints the
**UTC** wall-clock and groups under the **UTC** calendar
date. For any user not in UTC (i.e., almost everyone):

- A meeting at `02:00Z` shows as "02:00" under "2026-05-20"
  — but in PDT (UTC-7) it's actually **19:00 the previous
  day**. The user sees the wrong time AND the wrong day.
- Events near midnight land in the wrong day-bucket,
  scrambling the "what's on today / tomorrow" grouping that
  the briefing relies on.

The file already had tested `formatLocalDate(iso, tz?)` and
`formatLocalTime(iso, tz?)` helpers (Intl.DateTimeFormat,
host-timezone by default) used by `muse brief`'s task /
reminder lines — `formatCalendarEvents` just wasn't using
them. It also had **zero direct tests**.

The fix routes the day-grouping through `formatLocalDate`
and the start/end clock through a new `localClockOrEmpty`
helper (local `HH:MM`, or empty for an all-day / date-only
event — preserving the prior empty-time behaviour for
those). An optional `timeZone` param threads through so the
tests can pin a zone deterministically; callers default to
the host zone (what a CLI user wants).

### Defect class

**Display-in-UTC where local-time conversion is required**
(a render-correctness / timezone bug). Fresh — distinct
from the recent run of HTTP-timeout / temp-dir / route-to-
helper iters. Deliberately a *different area* (CLI calendar
formatting) than goals 668-669 (messaging timeouts) to
satisfy the stagnation guard's "don't churn one area" rule
— three messaging-timeout iters in a row would have tripped
it, so this iter redirects.

Recent 10-iter window:

- 669: Discord/Slack fetch timeout
- 668: Telegram fetch timeout
- 667/666: route to synthesizeAndPlay
- 665: execution-layer clamp
- 664: config upper bound
- 663: route to shared embed
- 662: mkdtempSync cleanup
- 661: concurrent RMW race
- 660: Promise.race timer leak

## Slice

- `apps/cli/src/human-formatters.ts`:
  - `formatCalendarEvents(payload, timeZone?)` — new optional
    `timeZone` param.
  - Day grouping now uses `formatLocalDate(event.startsAtIso,
    timeZone)` (was `.slice(0, 10)`).
  - Start / end times use a new `localClockOrEmpty(iso,
    timeZone?)` helper: returns local `HH:MM` for a timed
    instant, empty string for a date-only / all-day event
    (no `T..:` component) — matching the prior
    empty-on-date-only `.slice(11,16)` behaviour.
- `apps/cli/src/human-formatters.test.ts`:
  - Imported `formatCalendarEvents` (was untested).
  - **Four new tests** (all with a pinned `timeZone` for
    determinism across CI hosts):
    1. **Local day + local times** — a `02:00Z` event in
       `America/Los_Angeles` renders under `2026-05-19` at
       `19:00–20:00`, NOT under its UTC date `2026-05-20` at
       `02:00`.
    2. **No-end case** — a `16:30Z` event in `Asia/Seoul`
       renders under `2026-05-21` at `01:30` (next local
       day), no `–` end.
    3. **All-day / date-only** — `"2026-05-20"` renders its
       date with NO `HH:MM` clock (no UTC-time leakage).
    4. **Empty window** — the no-events message.

## Verify

- `pnpm --filter @muse/cli test`: 1135 passed (1131 prior +
  4 new). Full `pnpm check`: apps/cli 1139/1139, every
  workspace green; tsc strict EXIT=0 (the test fixtures
  needed the `HumanCalendarEvent.id` field — vitest doesn't
  typecheck but the `tsc` build in `pnpm check` does; added
  `id` to each).
- **Clean-mutation-proven**: reverting the grouping +
  time back to the `.slice(0,10)` / `.slice(11,16)` UTC
  form makes EXACTLY the two local-conversion tests fail
  with the exact symptom — the `02:00Z` event shows under
  `2026-05-20` at `02:00` (UTC) instead of `2026-05-19` at
  `19:00` (PDT); the `16:30Z` event shows `2026-05-20` /
  `16:30` instead of `2026-05-21` / `01:30` (KST). The
  all-day and empty-window tests pass either way (they
  don't depend on the timezone conversion). Restored; all
  green.
- `pnpm lint`: 0 errors / 0 warnings.
- `pnpm guard:core`: clean.
- Byte-hygiene scan on the two touched files: clean.
- No LLM request/response wire path touched — this is a
  pure CLI display formatter. `smoke:live` doesn't apply.

## Status

Done. Calendar events now render in the user's local zone:

| Event (UTC instant)             | Host zone           | Pre-fix display              | Post-fix display            |
| ------------------------------- | ------------------- | ---------------------------- | --------------------------- |
| `2026-05-20T02:00:00Z`          | America/Los_Angeles | `2026-05-20` / `02:00`       | `2026-05-19` / `19:00`      |
| `2026-05-20T16:30:00Z`          | Asia/Seoul          | `2026-05-20` / `16:30`       | `2026-05-21` / `01:30`      |
| `2026-05-20` (all-day)          | any                 | `2026-05-20` / (no time)     | `2026-05-20` / (no time)    |
| timed event, host=UTC           | UTC                 | unchanged                    | unchanged                   |

## Decisions

- **Used the existing `formatLocalDate` / `formatLocalTime`
  helpers**, not a new Intl call. They're already tested
  (timezone, midnight rollover, hour-24→00 normalisation,
  unparseable-passthrough) and used by the rest of the
  brief output — reusing them keeps the calendar lines
  consistent with the task / reminder lines.
- **`timeZone?` optional, defaults to host zone.** A CLI
  user wants their machine's local time, which is what
  `Intl.DateTimeFormat` with no `timeZone` gives. The
  param exists so tests can pin a zone deterministically
  (otherwise the test would depend on the CI host's TZ).
  Callers (`commands-calendar.ts`) pass nothing → host zone.
- **`localClockOrEmpty` preserves the all-day behaviour.**
  The prior `.slice(11,16)` returned `""` for a date-only
  ISO (positions 11-16 of a 10-char string). `formatLocalTime`
  on a date-only ISO would return the date itself (its
  CANONICAL guard fails), so a naive swap would print the
  date in the time slot. The helper guards on the presence
  of a `T..:` time component and only emits a clock for
  timed events.
- **Did NOT thread a tz from the calendar provider.** The
  ISO instants are absolute (Z or offset); rendering them
  in the *viewer's* local zone is the right UX. If a future
  iter wants per-event source-timezone display, that's a
  separate concern.
- **Mutation choice.** Reverted the grouping + time slices
  to UTC. The two local-conversion tests fail with the
  exact UTC-vs-local symptom; the all-day + empty tests
  pass regardless. Surgical proof.

## Remaining risks

- **`muse brief`'s own calendar lines** are built by
  `formatCalendarEvents` (via `commands-calendar.ts`), so
  they inherit the fix. Other surfaces that format events
  independently (the web panel, the `/api/today` JSON)
  return raw ISO and let the client localise — correct;
  the JSON contract is unchanged.
- **DST transition edge** — `formatLocalTime` /
  `formatLocalDate` delegate to `Intl.DateTimeFormat`,
  which handles DST correctly; the test uses PDT (a DST
  zone) and KST (no DST) to cover both.
- **The `timeZone` param is not yet plumbed from a user
  preference** (e.g., a `MUSE_TIMEZONE` config). Host zone
  is the sensible default; a future iter could let a user
  override it for a remote-server deployment where the
  host zone ≠ the user's zone.
- **All-day events still show the date-only ISO's literal
  date** (not localised) — correct, since an all-day event
  has no instant to convert; its date is timezone-independent
  by definition.
