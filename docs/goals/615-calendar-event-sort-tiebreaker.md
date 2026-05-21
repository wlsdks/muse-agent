# 615 — `CalendarProviderRegistry.listEventsWithDiagnostics` applies a deterministic (`providerId`, `id`) tiebreaker after `startsAt` so simultaneous events don't shuffle across runs

## Why

`packages/calendar/src/registry.ts:listEventsWithDiagnostics`
fans out `listEvents` across every registered provider in
parallel via `Promise.all`, concatenates the buckets, then
sorted by `startsAt`:

```ts
const events = buckets.flat().sort((left, right) => left.startsAt.getTime() - right.startsAt.getTime());
```

Two events at the exact same minute — a back-to-back recurring
meeting, the same calendar slot returned by two providers
(local mirror + Google), a slot that appears under multiple
calendars — produce equal sort keys. The sort algorithm is
stable per the JavaScript spec, but **only with respect to the
input order** — and the input order is the
`Promise.all`-completion order of the per-provider buckets,
which is non-deterministic (depends on network latency, event
loop scheduling, provider-implementation specifics).

User-visible symptom: `muse calendar today` shows the same
events shuffled differently across runs. A snapshot test or
dashboard screenshot that pins ordering is flaky. A
deduplicator downstream that expects "earlier providers
appear first when timestamps tie" gets a non-deterministic
upstream.

The same defect family the loop's already addressed for the
in-memory debug-replay store (goal 593) and the Kysely
scheduled-jobs list (goal 594) — adding tiebreakers `id ASC`
after the primary sort key. 594 was 22 commits back; outside
the last-10 window so Step-8 doesn't push away.

## Slice

- `packages/calendar/src/registry.ts`:
  - New module-private helper `compareCalendarEvents` that
    returns `startsAt.getTime() diff || providerId.localeCompare
    || id.localeCompare`. Exported so an external consumer that
    also wants the same ordering (a future dashboard sort, a
    test fixture stabiliser) can reuse the canonical compare.
  - `listEventsWithDiagnostics` now sorts with
    `compareCalendarEvents` instead of the inline `startsAt`
    diff.
- `packages/calendar/test/calendar.test.ts`:
  - One new test in the existing `CalendarProviderRegistry`
    describe. Two providers registered in *non*-alphabetical
    order (`zeta` before `alpha`), each returning events with
    the same `startsAt`. Asserts the sorted output is
    `[alpha/a1, zeta/z1, zeta/z2]` — pinned regardless of
    registration order or the Promise.all completion order
    that the inline `startsAt`-only sort previously surfaced.
  - The test imports `CalendarEvent` and `CalendarProvider`
    types from the package barrel to construct lightweight
    fake providers (no fixture file, no LocalCalendarProvider
    dependency — keeps the test focused on the registry's sort
    behavior).

## Verify

- `@muse/calendar` suite green (46 passed, +1 vs baseline 45,
  0 failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting
  `sort(compareCalendarEvents)` back to the inline
  `startsAt.getTime()` diff makes the new test fail with the
  diff `[zeta/z2, zeta/z1, alpha/a1]` — the actual
  Promise.all completion order the inline sort preserved
  (zeta provider registered first, so its events come back
  first; within zeta, the input array order
  `[z2, z1]` is preserved by the stable equal-key sort).
- `pnpm check` EXIT=0 (apps/api 258 passed, apps/cli 1046
  passed, every workspace green); `pnpm lint` 0/0; `pnpm
  guard:core` clean; byte-scan clean on both touched files;
  `git status` shows only the two intended files plus this
  goal doc.
- No LLM request-response wire path touched; `smoke:live` does
  not apply. Registry fan-out is in-process aggregation, not
  HTTP surface.

## Status

Done. `listEventsWithDiagnostics` now returns events in a
stable, deterministic order regardless of provider registration
order or Promise.all completion timing:

| Sort key                   | Before              | After                       |
| -------------------------- | ------------------- | --------------------------- |
| Primary: `startsAt`        | applied             | unchanged                   |
| Tiebreaker: `providerId`   | **none — fan-out order** | `localeCompare` (**fixed**) |
| Tiebreaker: `event.id`     | **none**                 | `localeCompare` (**fixed**) |

No CAPABILITIES line / no OUTWARD-TARGETS flip: a robustness /
list-ordering parity `fix:` on the calendar registry aggregator,
recorded honestly with this backlog row — not a false metric.

## Decisions

- **Tiebreaker priority: `providerId` then `id`.** Within a
  single provider's listing, the same event id never repeats
  (provider invariant), so `id` is a strict tiebreaker.
  Between providers, `providerId` puts events from the same
  source together — useful for dashboard grouping. `id` as
  the inner tiebreaker handles the cross-provider tie that
  remains.
- **`localeCompare`, not `<`/`>`.** Both `providerId` and
  event `id` are user-defined strings (Google `eventId`,
  CalDAV `UID`, our local random ids). `localeCompare` handles
  Unicode IDs correctly and matches the convention the rest of
  the codebase uses for human-facing string sort.
- **Exported `compareCalendarEvents` helper.** Single source
  of truth for "the calendar sort order." A future consumer
  (web dashboard sorter, snapshot test) can reuse it instead
  of re-implementing. Keeps the contract in one place.
- **Don't change `listEvents` directly.** It delegates to
  `listEventsWithDiagnostics` (line 95: `return (await
  this.listEventsWithDiagnostics(range)).events;`), so the
  fix flows through automatically.
- **Mutation choice.** Reverted exactly the
  `sort(compareCalendarEvents)` → `sort(inline)` line. The
  mutation reproduces the pre-fix shape — the realistic
  regression a maintainer might write while "inlining the
  comparator for clarity." The mutation test catches that
  with the exact Promise.all-order symptom.
- **Test uses non-alphabetical registration order**
  (`zeta` before `alpha`) so the alphabetical-by-tiebreaker
  result is observably distinct from the registration-order
  result. Asserting the same alphabetical output that *would*
  have happened by coincidence under `[alpha, zeta]`
  registration order wouldn't pin the tiebreaker.

## Remaining risks

- **`KyselyCalendarProvider`** (if one exists) wasn't
  audited — its DB query may already apply ORDER BY at the
  SQL layer. Spot-check in a follow-up iter.
- **Multi-event single-provider sort** is not pinned in this
  test. Each provider's `listEvents` is expected to return
  events in some defined order; if a provider's
  implementation has a non-deterministic intra-call order,
  the fan-out tiebreaker only stabilises the cross-provider
  case. Out of scope here — that's the provider's contract.
- **`compareCalendarEvents` is `O(log n)` per pair-compare**;
  for a calendar with 10k events the sort cost is fine. No
  performance concern.
- **Different definitions of "simultaneous"** — millisecond
  precision is the floor (the JS `Date` resolution). Two
  events one millisecond apart still sort by startsAt first.
  The tiebreaker only fires on exact equality.
