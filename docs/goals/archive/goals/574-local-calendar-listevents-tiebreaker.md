# 574 — `LocalCalendarProvider.listEvents` adds id-asc tiebreaker (cross-codebase comparator-determinism sweep finally reaches calendar)

## Why

The cross-codebase comparator-determinism convention
(asc primary + asc id tiebreaker) is established across:

- API server-side: `/api/today` reminders/followups/tasks (533)
- CLI local-mode renders: `muse followup list` / `muse today
  --local` (537), `muse remind list --local` (551)
- Other persistence/render paths: `vacuumEpisodes` (519),
  `queryActionLog` (530), `suggestPatternHints` (531),
  `compareFeedEntriesNewestFirst` (546)
- Messaging inbox surface: `filterFresh` (555)
- Observability token-cost: `topExpensive` (556)

Pre-fix `LocalCalendarProvider.listEvents` was the outlier:

```ts
return events
  .filter((event) => event.endsAt.getTime() >= range.from.getTime() && event.startsAt.getTime() <= range.to.getTime())
  .sort((left, right) => left.startsAt.getTime() - right.startsAt.getTime());
```

When two events share the same `startsAt` (a 9am all-hands and
a 9am 1:1, two routine triggers fired by the proactive daemon
at the top of the hour), the comparator returns 0 and
JavaScript's stable sort yields to file-array insertion
order. A subsequent rewrite of `.muse/calendar.json` —
`createEvent` always rebuilds the full array on append — can
reorder the persisted entries arbitrarily. `muse today` /
`muse calendar list` would then surface the same two events in
flipped order between consecutive invocations, breaking the
"identical persisted data → identical render" contract every
other sibling already maintains.

`CalendarEvent.id` is the natural stable id (already echoed
in every output object). Same convention as 533/537/546/551/
555/556.

## Slice

- `packages/calendar/src/local-provider.ts` — `listEvents`
  comparator now `left.startsAt.getTime() - right.startsAt.
  getTime() || left.id.localeCompare(right.id)`. Single-line
  change; no behavioural drift for events with distinct
  `startsAt`.
- `packages/calendar/test/calendar.test.ts` — added one
  focused `it(...)` between the "drops corrupt" and
  "creates and lists" tests: three events with identical
  `startsAt`/`endsAt`, persisted in insertion order
  `["cal_b", "cal_a", "cal_c"]`, must come back as
  `["cal_a", "cal_b", "cal_c"]` from `listEvents`.

## Verify

- New `it(...)` green; full `@muse/calendar` suite green
  (38 passed, +1 vs baseline 37, 0 failed); tsc strict
  EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the
  `|| left.id.localeCompare(right.id)` token to the bare
  startsAt comparator makes the new test fail with the
  precise pre-fix symptom — `expected [ 'cal_b', 'cal_a',
  'cal_c' ] to deeply equal [ 'cal_a', 'cal_b', 'cal_c' ]`.
  Fix restored, suite back to all green.
- `pnpm check` EXIT=0, every workspace green (apps/api 249
  passed, apps/cli 1027 passed, packages/calendar 38
  passed); `pnpm lint` 0/0; `pnpm guard:core` clean;
  byte-scan clean; `git status` shows only the three
  intended files.
- Pure comparator — no LLM request-response wire path;
  `smoke:live` does not apply (per `testing.md` /
  iteration-loop Step 9). The defended path is
  `LocalCalendarProvider.listEvents` callers (the agent
  calendar tool + the `/api/calendar/events` HTTP
  surface + `muse today --local`), not the model loop.

## Status

Done. The id-tiebreaker convention now reads identically
across every time-keyed sort I can find in the codebase:

- API: `/api/today` (533)
- CLI: `muse followup list`, `muse today --local`
  reminders + followups (537), `muse remind list --local`
  (551)
- Stores: `vacuumEpisodes` (519), `queryActionLog` (530),
  `suggestPatternHints` (531),
  `compareFeedEntriesNewestFirst` (546)
- Messaging: `filterFresh` (555)
- Observability: `topExpensive` (556)
- **Calendar: `listEvents` (this goal)**

A future grep for time-keyed `.sort(... .getTime() - ...
.getTime())` without a `|| ...id` tiebreaker should return
zero hits on the calendar / store / CLI / API render paths
in the codebase.

No CAPABILITIES line / no OUTWARD-TARGETS flip: a
sibling-asymmetry comparator-determinism `fix:` on the
calendar local provider, recorded honestly with this
backlog row — not a false metric.

## Decisions

- Direction matches the surrounding convention: asc primary
  (startsAt — chronological), asc id tiebreaker. Reader
  expectation across `muse today` and `muse calendar list`
  is "soonest first; alphabetical when stacked".
- `CalendarEvent.id` is the stable id. Unique within the
  store (LocalCalendarProvider uses an injected `idFactory`
  that emits `cal_1, cal_2, ...`). Considered `title` as
  alternative; rejected because titles can collide
  legitimately (`Daily Standup` repeated across days
  yields false-equal). Id is guaranteed unique.
- Did NOT touch `caldav-provider.ts` / `google-provider.ts`
  / `macos-provider.ts`. They return events from their
  respective remote APIs; sorting is the API's
  responsibility there, not Muse's. The local-provider
  is the only file-backed source needing deterministic
  client-side sort.
- Mutation reverts the precise delta (the
  `|| left.id.localeCompare(right.id)` token). Smallest
  semantic delta; surgical proof.
- The test asserts a 3-event fixture (not 2) so the
  tiebreaker effect is unmistakable — with 2 events,
  insertion-order leak could coincidentally match the
  asserted order. With 3 events the leak is loud (the
  pre-fix output `["cal_b", "cal_a", "cal_c"]` mirrors
  the fixture insertion order verbatim).
- Step-8 sub-defect-class check: comparator-determinism
  has been six iterations away (last was 556). Well past
  the ≥3-in-last-10 threshold; fresh defect-class slot.
