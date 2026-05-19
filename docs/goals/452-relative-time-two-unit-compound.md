# 452 — Reminders/tasks accept two-unit compound durations ("in 2 hours 30 minutes")

## Why

`resolveRelativeTimePhrase` (`@muse/mcp` `loopback-relative-time.ts`)
is the natural-language due-time parser behind every `muse remind`
/ task `dueAt`. Goal 445 delivered the **decimal** half of the
deferred "compound/decimal durations" discovery (iter 440 probe);
the README Rejected ledger explicitly kept the **two-unit
compound** half open ("`in 2 hours 30 minutes` — a distinct
grammar, still deferred").

"remind me in 2 hours 30 minutes" / "in 1 hour 15 minutes" /
"in 1 day 6 hours" are among the most natural JARVIS phrasings and
currently **error** — the plain `in N <unit>` matcher is anchored
to a single unit, and none of the fractional/decimal patterns
express a two-pair sum. This is the documented remaining slice of
a deliberately-split discovery (Step-3 continuity), a (b)-refinement
of an existing feature (not new surface), on the core proactive
path. mcp's relative-time file was last touched in 445, 6
non-mcp iterations ago — finishing the split discovery now is
continuity, not same-area churn, and diversifies the recent
fix-streak with a user-facing `feat:`.

## Slice

- `packages/mcp/src/loopback-relative-time.ts` — a
  `TWO_UNIT_COMPOUND` regex
  (`/^in\s+(\d+)\s+UNITs?\s+(?:and\s+)?(\d+)\s+UNITs?$/`) and a
  branch in `resolveFractionalDurationMs` (its documented home,
  shares `FLAT_UNIT_MS`, exactly mirroring 445's decimal branch):
  `n1*ms1 + n2*ms2`, both integer-ms so exact.
  - Disjoint from every existing pattern: the plain integer
    matcher is `$`-anchored after one unit (so a two-pair phrase
    falls through to here); `UNIT_AND_A_HALF` requires the literal
    `and a half` suffix (runs first, still owns
    "in 2 days and a half"); decimal needs `\d+\.\d+`. The
    optional `and` lets "in 2 hours and 30 minutes" parse too.
  - `month` is excluded by the unit set (calendar months aren't a
    flat-ms multiply — consistent with every fractional sibling).
    Three-or-more pairs ("2h 30m 10s") are intentionally NOT
    matched: a distinct grammar, not this bounded two-unit slice
    (right-sized, same scoping discipline as 445's decimal-only).
    Out-of-range sums fall through the caller's existing
    `finiteDate` guard, like the other branches.
- `packages/mcp/test/mcp.test.ts` — a new `it` beside the 445
  decimal test: the compound forms (incl. optional `and`,
  day+hour, week+day, zero leading pair) resolve to the exact
  minute offsets; integer/decimal/word-fraction/compact/
  and-a-half all still resolve unchanged; month and three-pair
  correctly stay `undefined`.

## Verify

- New `it` green; full `@muse/mcp` suite 493 passed (32 files,
  +1); tsc strict (mcp) EXIT=0.
- End-to-end probe through the user surface `parseReminderDueAt`
  (fixed `now`): "in 2 hours 30 minutes" → +2h30m,
  "in 1 day 6 hours" → +30h, "in 1 week 2 days" → +9d;
  "in 1.5 hours" / "in 2 hours" / "in half an hour" /
  "in 2 days and a half" / "in 90 mins" unchanged.
- **Mutation-proven teeth**: removing the compound branch makes
  the new test fail with exactly `AssertionError: expected
  undefined to be 150` ("in 2 hours 30 minutes" — the precise
  pre-fix gap); `compoundPair` occurrence count went 6→0 then
  restored to 6, suite back to 493 green.
- `pnpm check` EXIT=0, every workspace green (mcp 493, cli 739,
  api …) — no regression; `pnpm lint` 0/0; `pnpm guard:core`
  clean; byte-scan clean; `git status` shows only the two
  intended files.
- Pure deterministic NL date parsing — no LLM / model
  request-response wire path; `smoke:live` does not apply (per
  `testing.md` / iteration-loop Step 9).

## Status

Done. "remind me in 2 hours 30 minutes" / "in 1 hour 15 minutes"
/ "in 1 day 6 hours" now resolve instead of erroring. With 445
(decimal) this **fully discharges** the deferred
"compound/decimal durations" discovery — the Rejected-ledger
line is closed accordingly, not left as a dangling half-promise.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]` and audited; this deepens an already-delivered
proactive-reminders capability, recorded honestly as a
`feat(mcp):` change with this backlog row — not a false metric.

## Decisions

- Bounded to exactly two unit pairs (not arbitrary N-pair
  chains): two-pair covers the overwhelming natural usage
  ("2h 30m", "1d 6h"); arbitrary chains are a different,
  open-ended grammar and shipping the bounded slice completely
  beats half-doing a general parser (the 445 right-sizing
  discipline).
- Reused `resolveFractionalDurationMs` + `FLAT_UNIT_MS` rather
  than a parallel matcher: single source of unit→ms, the 413/445
  anti-drift rationale.
