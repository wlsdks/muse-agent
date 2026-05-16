# 254 — anticipatory hints used a non-circular median of clock hours

## Why

`suggestPatternHints` powers `muse status --suggestions` (goal
095) — the flagship "you usually do X around now" JARVIS
affordance. For each pattern it computes the typical firing hour
and surfaces the hint when the current hour is within ±1 of it.

The window check is correctly **circular**:

```ts
const delta = Math.min(
  Math.abs(nowHour - medianHourUtc),
  24 - Math.abs(nowHour - medianHourUtc)
);
```

…but the centre it compared against was a **plain numeric
median** of the hour list:

```ts
const sorted = [...hours].sort((a, b) => a - b);
const medianHourUtc = sorted[Math.floor(sorted.length / 2)]!;
```

Hour-of-day lives on a 24-hour circle. For a habit clustered
around midnight — late-night journaling, a sleep routine, an
early standup — the firings look like `[23, 0, 1, 23, 0, 1]`.
Sorted that is `[0, 0, 1, 1, 23, 23]`, so the numeric median is
`1`. The true centre is `00:00`. When the user is in their actual
window at `23:50`, `delta = min(|23-1|, 24-|23-1|) = min(22, 2) =
2 > 1`, so the hint is **silently never shown** — precisely for
the recurring routines the feature exists to anticipate. A
mirror-image false-positive at the wrong hour is equally
possible.

## Scope

`apps/cli/src/commands-status.ts`:

- New module-private `circularMedianHour(hours)` — the hour in
  `0..23` minimising total circular distance to all firings
  (ties → earliest hour, for determinism). For a non-wrapping
  cluster this equals the ordinary medoid, so existing behaviour
  is preserved; for a midnight-straddling cluster it returns the
  true centre (`[23,0,1,23,0,1]` → `00`).
- `suggestPatternHints` now calls it instead of the plain
  sort-and-pick-middle. One statistic swapped; the ±1 circular
  window, min-firings gate, max-hints cap, and malformed-entry
  skipping are unchanged.

## Verify

- `pnpm --filter @muse/cli test` — 556 pass (was 555; +1). New
  test: six firings at hours 23 / 00 / 01 — asserts the hint
  surfaces at `23:50` (it did not before) with a centre in
  `{23,0,1}`, and is correctly absent at `15:00`. The existing
  goal-095 test (single-hour clusters at 09 / 22) still passes —
  the circular medoid equals the ordinary median for non-wrapping
  data, so no regression.
- `pnpm check` — every workspace green (apps/cli 556, apps/api
  155, all packages). `pnpm lint` — exit 0.
- No real-LLM request/response path touched (pure deterministic
  statistic over the `patterns-fired` store; no model call), so
  the constructed-input unit test is the rigorous verification —
  the same stance used for the other deterministic-logic fixes.

## Status

done — the anticipatory-hint centre is now computed on the 24-hour
circle, so a habit that straddles midnight is correctly
recognised and "you usually do X around now" fires inside the
real window instead of being silently suppressed.
