# 782 — feat: web-watch numeric below/above threshold (price-drop alert)

## Why

781 gave web-watch `extract` to isolate a value, but the rule could
still only do substring `appears`/`disappears` — so the single most
common watch ("ping me when the price drops below $40") was
impossible: `appears: "$39"` requires guessing the exact target value
and misses $38/$37/… A numeric threshold comparator on the extracted
value is the natural, high-value completion.

## Slice

`@muse/mcp` web-watch.ts:
- `WatchRule.below?: number` / `above?: number` — fire when the number
  parsed from the (extracted) region NEWLY crosses the threshold.
  Edge-triggered: fires once on the crossing, never re-fires while it
  stays past it; first observation already-past fires (the user learns
  it's there). `parseWatchNumber` reads the first numeric run, strips
  thousands separators, ignores noise; non-finite/none → `undefined`
  → no fire (degrade, never throw).
- `webWatchesFromConfig` parses `below`/`above` as finite numbers and
  treats them as firing conditions (a `below`-only rule is valid, no
  longer dropped); a non-finite `below` is ignored.

## Verify

- `@muse/mcp` web-watch-threshold.test.ts (new, 7): `below` fires on
  the downward crossing, not every poll while under, not on the way
  back up; `above` mirrors it; thousands-separator parse; no parseable
  number → no fire; first-observation-already-below fires;
  **end-to-end** — a `below: 40` + `extract: Price: \$(\d+)` config
  watch over an HTTP page `$45 → $44 → $38` through
  `createWebWatchRunner` + a real `ProactiveNoticeSink` fires EXACTLY
  ONCE when it drops under 40; a non-finite `below` leaves an
  otherwise-conditionless rule dropped.
- **Mutation-proven**: dropping the `!belowBefore` rising-edge guard
  (fire on `belowNow` alone) → the "no re-fire while under" test
  fails; restore → 7/7. Full web-watch suite 24/24, `pnpm check` EXIT
  0, `pnpm lint` 0/0. Config-path only, no model path → no
  `smoke:live`.

## Decisions

- **No bullet flip** — P21 is `[x]` + audited; this completes the
  daily-driver hardening line (CAPABILITIES under P21). `below`/`above`
  ARE firing conditions (unlike `extract`, a modifier), so they join
  the no-condition drop guard.
- **Edge on the crossing, not the level** — a level-triggered "is
  below" would re-ping every poll; the rising edge of the predicate
  (`!past → past`) pings once, matching `appears`/`disappears`.
- **`parseWatchNumber` reads the first numeric run** — combined with
  `extract` the region is already narrowed (`Price: \$(\d+)` → "39"),
  so a bare-page parse only matters when no `extract` is set; it
  strips commas so `$1,299.00` parses as 1299.
