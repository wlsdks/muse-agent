# 316 — local calendar silently NaN-filtered events with an unparseable persisted date

## Why

`LocalCalendarProvider` is the **default, zero-cost** calendar
(file-backed `~/.muse/calendar.json`). `createEvent` validates
dates via `validateEventInput` (rejects an invalid Date with a
clear error), but the *load* path's `isPersistedEvent` only
checked `typeof startsAt === "string"` / `typeof endsAt ===
"string"`. So a persisted event with `"startsAt": "tomorrow"` /
a typo'd date / `""` (a hand-edited or imported `calendar.json`,
a corrupted partial write) **passed the type guard**, became
`new Date("tomorrow")` → an Invalid Date, and was then **silently
filtered out of every `listEvents` view** — `event.startsAt.getTime()
<= range.to.getTime()` is `NaN <= x` → `false`. The user's event
**vanishes from "what's on my calendar" with no error or
warning** — a trust-eroding silent data loss, and inconsistent
with the CalDAV provider, whose `parseVEvent` already drops
events with an unparseable time (goal 282).

## Scope

`packages/calendar/src/local-provider.ts` —
`isPersistedEvent`:

- Replace the `typeof … === "string"` checks for
  `startsAt`/`endsAt` with `isParsableDateString` (string **and**
  `!Number.isNaN(new Date(v).getTime())`). An unparseable-date
  event is now dropped **at load**, deterministically and
  consistently with CalDAV, instead of accidentally surviving
  the type guard and being NaN-filtered later. One short WHY
  comment records the silent-vanish rationale.

Behaviour-preserving for every well-formed `calendar.json`
(parseable ISO dates pass exactly as before); only a
malformed-date entry — previously an Invalid Date polluting the
listEvents filter — is now excluded at the type-guard boundary.
No Invalid Date object can reach the range filter / sort.

## Verify

- `pnpm --filter @muse/calendar test` — 20 pass (was 19; +1).
  New regression: a `calendar.json` with one valid event and one
  whose `startsAt`/`endsAt` are `"tomorrow"`/`"later"` →
  `listEvents` returns **only** the valid event
  (`["ok-1"]`) and does not throw (pre-fix: the corrupt event
  also passed `isPersistedEvent`, became Invalid Date, then
  silently disappeared via the NaN range filter). The existing
  empty-file / create-and-list / update / CalDAV / macOS tests
  stay green.
- `pnpm check` — every workspace green (calendar 20, apps/cli
  563, apps/api 161, all packages). `pnpm lint` — exit 0.
- No real-LLM request/response path touched (deterministic
  persisted-event validation). A live Qwen run cannot reproduce
  a corrupt calendar.json on demand, so the deterministic
  regression is the rigorous verification — same stance as the
  CalDAV parsing goal 282.

## Status

done — the local calendar now rejects an event with an
unparseable persisted date at the load type-guard, consistently
with CalDAV, so a corrupt/hand-edited `calendar.json` entry is
deterministically excluded rather than passing the guard and
silently vanishing from every view. Well-formed events are
unchanged.
