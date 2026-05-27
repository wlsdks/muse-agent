# 445 — Reminders/tasks accept decimal-notation relative durations ("in 1.5 hours")

## Why

`resolveRelativeTimePhrase` (`@muse/mcp` `loopback-relative-time.ts`)
is the natural-language due-time parser behind every `muse remind`
/ task `dueAt`. A probe in goal 440 surfaced — and the README
Rejected ledger explicitly deferred — a real user-facing gap:

```
"in half an hour"  → 12:30   (word-fraction resolver handles it)
"in 1.5 hours"     → ERROR   (the in-N-unit regex is integer-only: \d+)
"in 2.5 days"      → ERROR
```

"remind me in 1.5 hours" / "in 0.5 hours" / "in 2.5 days" is among
the most natural JARVIS phrasings, and the grammar already
half-supports the concept (`resolveFractionalDurationMs` handles
"half"/"quarter"/"three quarters"/"N and a half"). The only thing
missing was decimal *notation*. This is a (b)-refinement of an
existing feature (not new surface), on the core proactive path,
explicitly deferred to a "free non-time iteration" in the Rejected
ledger (iter 441) and now delivered — diversifying away from the
recent NaN-guard-sibling streak (438/440/441/443/444) into a
genuine UX win, on `loopback-relative-time.ts` (distinct from the
`personal-tasks-store.ts` file goal 440 touched; mcp's only recent
touch was 5 iterations ago — no same-area churn).

## Slice

- `packages/mcp/src/loopback-relative-time.ts` — a `DECIMAL_OF_UNIT`
  regex (`/^in\s+(\d+\.\d+)\s+(second|minute|hour|day|week)s?$/u`)
  and a branch in `resolveFractionalDurationMs` (its documented
  home: "precise fractional durations the plain in-N-unit pattern
  can't express"): `Math.round(Number(amount) * FLAT_UNIT_MS[unit])`.
  - Disjoint from the existing patterns: requires `\d+\.\d+`, so
    integers stay on the upstream integer path and word-fractions
    on theirs; `resolveFractionalDurationMs` runs only after the
    integer matcher, so no precedence change.
  - `month` is intentionally excluded (same as the existing
    word-fraction resolvers) — a fractional *calendar* month is
    ill-defined; integer `in N months` keeps its `addCalendarMonths`
    path. `Math.round` keeps sub-second forms exact
    ("in 0.5 seconds" → +500 ms). Out-of-range huge decimals fall
    through the caller's existing `finiteDate` guard, same as huge
    integer offsets.
- `packages/mcp/test/mcp.test.ts` — a new `it` beside the
  fractional/compound test: decimal hours/minutes/days/weeks +
  singular-unit + sub-second exactness; no-regression on
  integer/word-fraction/compact; and the principled rejections
  ("in 1.5 months", "in .5 hours", "in 1. hours",
  "in 1.5 fortnights") stay `undefined`.

## Verify

- New `it` green; full `@muse/mcp` suite 492 passed (32 files,
  +1); tsc strict (mcp) EXIT=0.
- End-to-end probe through the user surface `parseReminderDueAt`
  (fixed `now`): "in 1.5 hours" → +90 m, "in 2.5 days" → +60 h,
  "in 0.5 seconds" → +500 ms; "in half an hour"/"in 2 hours"/
  "in 90 mins"/"in 2 days and a half" unchanged.
- **Mutation-proven teeth**: removing the decimal branch makes the
  new test fail with exactly `AssertionError: expected undefined
  to be 90` (`"in 1.5 hours"`) — which is also the precise
  pre-fix behaviour; `DECIMAL_OF_UNIT` occurrence count went
  2→1 then restored to 2, suite back to 492 green.
- `pnpm check` EXIT=0, every workspace green (mcp 492, cli 737,
  api …) — no regression; `pnpm lint` 0/0; `pnpm guard:core`
  clean; byte-scan clean; `git status` shows only the two
  intended files.
- Pure deterministic NL date parsing — no LLM / model
  request-response wire path; `smoke:live` does not apply (per
  `testing.md` / iteration-loop Step 9).

## Status

Done. A user (or the LLM via the `muse.reminders` / `muse.tasks`
tools) can now say "remind me in 1.5 hours" / "in 2.5 days" /
"in 0.25 hours" and have it resolve, instead of hitting the
"unsupported relative phrase" error. The decimal half of the
deferred "compound/decimal durations" discovery is delivered;
compound (`in 2 hours 30 minutes`) remains a separate, narrower
deferred slice (a two-pair grammar, not this one-pair extension)
— the Rejected-ledger line is updated accordingly, not left as a
false promise.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]` and audited; this deepens an already-delivered
proactive-reminders capability, recorded honestly as a
`feat(mcp):` change with this backlog row — not a false metric.

## Decisions

- Put the branch in `resolveFractionalDurationMs`, not a new
  top-level matcher: its docstring already scopes it to "precise
  fractional durations the plain pattern can't express" and it
  shares `FLAT_UNIT_MS`; a parallel top-level regex would be the
  drift the codebase's single-source fixes (413/415) fight.
- Required a leading digit (`\d+\.\d+`, so ".5 hours" is
  rejected): the supported form for that is "half an hour"; a
  bare ".5" is more likely a typo than intent, and strictness
  here matches the 414/444 "ambiguous input → the clear path,
  not a silent guess" posture.
- Delivered decimal only, not also compound ("in 2 hours 30
  minutes"): that is a distinct two-unit grammar; shipping the
  one-unit decimal slice completely and verified beats
  half-doing both (right-sized per the iteration contract). The
  ledger line is narrowed, not cleared.
