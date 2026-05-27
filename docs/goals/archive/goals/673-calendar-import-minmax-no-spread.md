# 673 — `muse calendar import` computes its dedup date-range with reduce-based `minOfNumbers` / `maxOfNumbers` instead of `Math.min(...arr)` / `Math.max(...arr)`, so a large `.ics` file can't crash the import with `RangeError: Maximum call stack size exceeded`

## Why

`apps/cli/src/commands-calendar.ts`'s `.ics` importer
computed the range to dedup against existing rows via:

```ts
const startsAtMs = parsed.map((e) => e.startsAt.getTime());
const rangeFrom = new Date(Math.min(...startsAtMs));
const rangeTo = new Date(Math.max(...parsed.map((e) => e.endsAt.getTime())) + 24 * 60 * 60 * 1000);
```

`Math.min(...arr)` / `Math.max(...arr)` **spread every array
element as a separate function argument**. JS engines cap the
argument count of a single call — V8's ceiling is roughly
65,536–125,000 depending on context. Past that, the spread
throws `RangeError: Maximum call stack size exceeded`.

`parsed` comes from a **user-supplied `.ics` file**
(`muse calendar import <file>`). A realistic calendar export
is big:

- A single year of a busy Google Calendar: ~1,000–5,000
  VEVENTs (fine).
- A decade export, a shared team calendar, or a merged
  multi-calendar `.ics`: tens of thousands.
- A pathological / malicious `.ics` with >125k VEVENTs:
  crashes the import on the `Math.min(...)` line — before a
  single event is created — with an opaque RangeError, not a
  clean "too many events" message.

The fix replaces the two spreads with reduce-style helpers
(`minOfNumbers` / `maxOfNumbers`) that iterate without
spreading, so the import scales to any array size the parser
produces.

### Defect class

**`Math.min/max(...largeArray)` spread → argument-count
RangeError** — first hit. Fresh area (CLI calendar import)
and fresh class, distinct from the recent run:

- 672: HTTP timeout (LINE) — messaging
- 671: asymmetric validation (web-search)
- 670: calendar local-timezone render
- 669/668: HTTP timeout (messaging)
- 667/666: route to synthesizeAndPlay
- 665/664: scheduler bounds
- 663: route to shared embed

Deliberately NOT another HTTP-timeout iter: that class is
now 3 of the last 10 (668, 669, 672), so the stagnation
guard requires a different area — this redirects to CLI
calendar-import robustness.

## Slice

- `apps/cli/src/commands-calendar.ts`:
  - **Two new exported helpers** `minOfNumbers(values)` /
    `maxOfNumbers(values)` — a `for…of` reduce seeded with
    `±Infinity` (the documented empty-input fallback;
    callers guard against empty via the early
    `parsed.length === 0` return). A WHY comment explains
    the spread-RangeError they avoid.
  - The importer's `rangeFrom` / `rangeTo` now use them
    (the `+ 24h` on `rangeTo` is preserved).
- `apps/cli/src/commands-calendar.test.ts` (new file):
  - **Four tests**: small-array min/max, single element,
    empty-array `±Infinity` fallback, and a **200,000-element
    array** asserting the correct min/max with no throw — the
    case that RangeErrors under the spread form.

## Verify

- `pnpm --filter @muse/cli test`: 1143 passed (1139 prior +
  4 new). Full `pnpm check`: apps/cli 1147/1147, every
  workspace green; tsc strict EXIT=0.
- **Clean-mutation-proven**: reverting the helpers to
  `values.length === 0 ? ±Infinity : Math.min(...values)`
  makes EXACTLY the 200k-array test fail with the exact
  symptom — `RangeError: Maximum call stack size exceeded`
  thrown by the spread. The small / single / empty tests
  pass either way (their arrays are under the spread
  ceiling). Restored; all green.
- `pnpm lint`: 0 errors / 0 warnings.
- `pnpm guard:core`: clean.
- Byte-hygiene scan on the two touched files: clean.
- No LLM request/response wire path touched — this is a
  pure numeric helper + a local-file import range
  computation. `smoke:live` doesn't apply.

## Status

Done. `muse calendar import` scales to any `.ics` size the
parser handles:

| `.ics` event count        | Pre-fix                              | Post-fix                  |
| ------------------------- | ------------------------------------ | ------------------------- |
| 100 events                | OK                                   | OK                        |
| 5,000 events (yearly)     | OK                                   | OK                        |
| 130,000 events            | **RangeError, import aborts**        | OK (range computed)       |
| 1,000,000 events          | **RangeError**                       | OK (bounded by parser)    |

## Decisions

- **Exported reduce helpers**, not inline `.reduce(...)`,
  so the spread-vs-no-spread behaviour is directly
  unit-testable (the 200k test is the proof). Two callers
  in this file use them; future callers in this file can
  too.
- **`for…of` loop, not `Array.prototype.reduce`** — both
  avoid the spread; the loop is marginally faster (no
  per-element closure call) for a hot path that may run
  over a 6-figure array. Minor, but the import is
  one-shot-bulk so clarity + speed both favour the loop.
- **`±Infinity` seeds for empty input** — matches
  `Math.min()` / `Math.max()` with no args (which return
  `+Infinity` / `-Infinity`). The importer guards against
  empty (`parsed.length === 0` returns early), so this is
  the documented fallback, not a reachable path.
- **Did NOT touch the observability percentile helpers**
  (`observability-latency.ts:242/245`,
  `observability-detectors.ts:458/461`) which also spread
  into `Math.min`/`Math.max`. Those branches only fire for
  `percentile <= 0` or `>= 1`, and every current caller
  passes p50/p95/p99 (strictly inside `(0,1)`) — so the
  spread is on a DEAD path there, not reachable with a
  large array. Fixing dead-path code would be inward churn
  (cosmetic guard without observed failure). The calendar
  import is the reachable site. Noted in remaining risks.
- **Mutation choice** — reverted to the spread form. The
  200k test throws RangeError; the small/single/empty tests
  pass. Surgical proof of the no-spread fix.

## Remaining risks

- **Observability percentile spread (dead path)** — the
  `Math.min(...values)` / `Math.max(...values)` in
  `percentileMs` (latency + detectors) is only reached for
  `percentile <= 0` / `>= 1`, which no current caller
  passes. If a future caller requests the 0th / 100th
  percentile over a large window, it would RangeError.
  Sibling-fixable by routing through `minOfNumbers` /
  `maxOfNumbers` (or a shared `@muse/shared` util) if that
  call shape ever appears. Currently unreachable, so out of
  scope for this iter per the inward-churn rule.
- **The parser itself** (`parseIcsEvents`) is the real
  upper bound on event count now — it reads the whole file
  into memory. A multi-GB `.ics` would OOM at parse time,
  before the range computation. A streaming parser or a
  file-size cap would be a separate iter (sibling to the
  feed-body cap, goal 649).
- **`minOfNumbers` / `maxOfNumbers` on an array containing
  `NaN`** return `Infinity` / `-Infinity` respectively
  (every `NaN < min` / `NaN > max` comparison is false, so
  the seed survives). The importer's values come from
  `Date.getTime()` on parsed events; the parser already
  drops unparseable dates, so a `NaN` shouldn't reach here.
  If it did, the range would be degenerate but the import
  wouldn't crash.
