# Goal 918 — `muse brief` active-window check honours midnight wraparound

## Outward change

The morning briefing's "are you inside your usual active window?"
greeting hint now measures the user's `routine_active_hours` band on a
24-hour circle. Before, it used a linear `Math.abs(hour - h) <= 2`, so
a routine that straddles midnight was misjudged: an early-bird whose
learned active hours are `1,2,3` checking in at 23:00 (two hours
before their 01:00 start) was told "up late?" — and a night-owl active
`21,22,23` at 00:00 (one hour past) likewise. Now both are correctly
recognised as INSIDE their window, so the brief greets them
appropriately instead of nightly mis-reading the clock.

## Why this, now

`muse brief` is the daily walk-into-the-lab ritual, and its whole
personalisation promise is "JARVIS reads the clock + the user." The
two routine shapes most likely to span midnight — night-owls and
early-birds — are exactly the ones the linear band got wrong, every
time they briefed near the seam. It's a real, repeating
personalisation miss on a core daily surface (a distinct instance in
`commands-brief`, found while surveying it — not the previously-fixed
singleton elsewhere).

## How

Extracted a pure `isOutsideActiveHours(activeHours, hour, tolerance=2)`
that computes the circular hour distance
(`min(|h-hour|, 24-|h-hour|) <= tolerance`) for each active hour, so a
band wraps correctly across 23↔0. Empty `activeHours` → never outside
(no routine learned yet). The inline `routineHours.some(abs … <= 2)`
in the brief action now delegates to it. The greeting-tone string the
LLM receives is unchanged; only the inside/outside decision is
corrected.

## Verification

`apps/cli` `commands-brief.test.ts` (`npx vitest run --root apps/cli
commands-brief.test.ts`, 11 passing): `isOutsideActiveHours` —
midnight-spanning inside cases (`[1,2,3]`@23, `[21,22,23]`@0 → inside),
same-day inside (`[9,10,11]`@12), genuine outside (`[9,10,11]`@15,
`[1,2,3]`@22), the ±2 circular boundary (`[23]`@1 inside, `[23]`@2
outside), and empty list → never outside. Mutation-proven: reverting
to the linear `abs(h - hour) <= tolerance` fails the two
midnight-wraparound tests; restored green. `pnpm lint` 0/0; apps/cli
alone fully green (151 files / 1671 tests; the 2 parallel-`pnpm check`
failures are the known mkdtemp `/tmp` flake); apps/api 323.
Deterministic band logic — the brief's LLM generation is untouched, so
no smoke:live (Ollama down regardless).

## Decisions

- Circular distance `min(d, 24-d)` rather than special-casing the
  wrap — one expression that's correct for every hour pair, no
  midnight branch to get wrong later.
- Extracted as a pure exported helper (the testability pattern) so the
  band logic is verifiable without spinning up the whole brief action
  (which needs a model + stores).
