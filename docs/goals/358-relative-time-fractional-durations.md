# 358 — "in half an hour" and the precise fractional/compound durations failed

## Why

This iteration empirically probed the remaining deterministic
agent tools (`json_query`, `csv_parse`, `time_relative`, …) and
**verified-and-rejected** every candidate: they are correct as
documented (earlier "bugs" were malformed probes using wrong
param names — `json_query` works with `document`/dotted array
indices, `csv_parse` is comma-only by design and already tested
at tools.test.ts:492). The codebase is mature there.

The one genuine, concrete, high-frequency gap remains on the
highest-traffic JARVIS input — the relative-time grammar. The
goal-345 probe showed `in half an hour`, `in a quarter of an
hour`, `in an hour and a half`, `in 2 hours and a half`, `in
half a day` all returned `undefined`. "Remind me in half an
hour" is one of the most common short-delay phrasings a person
uses; the `in N <unit>` family (329 bare-hour … 356 month-date)
couldn't express any precise fraction.

## Scope

`packages/mcp/src/loopback-relative-time.ts`:

- `FLAT_UNIT_MS` map (second…week) + two anchored regexes:
  `FRACTION_OF_UNIT` (`in (a/an)? (half|quarter|three
  quarters) (of)? (a/an)? <unit>s?`) and `UNIT_AND_A_HALF`
  (`in (N|a/an) <unit>s? and a half`), and
  `resolveFractionalDurationMs(phrase)` returning the exact ms
  offset (`half`→×0.5, `quarter`→×0.25, `three quarters`→×0.75,
  compound→×(qty+0.5)).
- A pre-check after the `inMatch` block, before the
  standalone-day-part check. `finiteDate`-wrapped like every
  resolver.

Disjoint by construction: `inMatch` is anchored `…$`, so
`in 3 hours` (ends at the unit) is fully consumed there and
never reaches this; `in 2 hours and a half` (text after the
unit) fails `inMatch`'s `$` and falls here. `month` is
deliberately excluded (a fractional calendar month is
ill-defined). Vague quantities ("a few", "a couple") remain
`undefined` — explicitly not added, consistent with goal 330's
documented stance. Every fraction × `FLAT_UNIT_MS` is an exact
integer ms, so no rounding.

## Verify

- Empirically dog-fooded on the rebuilt dist before the test:
  `in half an hour`→30m, `in half a minute`→30s, `in half a
  day`→12h, `in half a week`→3.5d, `in a/`(no-a) `quarter of
  an hour`→15m, `in three quarters of an hour`→45m, `in an
  hour and a half`→90m, `in a day and a half`→36h, `in 2 hours
  and a half`→2.5h; `in 3 hours`→3h and `in an hour`→1h
  byte-unchanged; `in a few minutes`/`in a couple of hours`
  still `undefined`.
- `pnpm --filter @muse/mcp test` — 362 pass (was 361; +1). New
  test pins all of the above incl. the no-regression and
  vague-stays-undefined cases.
- `pnpm check` — every workspace green (mcp 362, apps/cli 611,
  apps/api 161, all packages). `pnpm lint` — exit 0. The
  goal-227 enforcement test (328) stays green.
- No real-LLM request/response path touched — deterministic
  input-phrase parsing; the resolved `Date` feeds the
  reminder/task stores. The deterministic regression (plus the
  pre-write dist dog-food) is the rigorous verification.

## Status

done — the relative-time grammar now resolves precise
fractional and compound durations ("in half an hour" → +30m,
"in an hour and a half" → +90m), closing the dominant remaining
short-delay phrasing gap; plain/article forms are unchanged and
vague quantifiers still correctly fail to `undefined`.
