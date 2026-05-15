# 129 — `muse routine` pluralises `day` correctly

## Why

Goal 123 fixed `humanizeRelativeMs` to read `"in 1 day" /
"in 3 days"` instead of the placeholder `"in 1 day(s)"`. The
`muse routine` CLI rendering had the same shortcut (`"across N
day(s)"`) and was overlooked in that sweep — every routine
summary on the dashboard now reads naturally too.

## Scope

- `apps/cli/src/commands-routine.ts`:
  - Branch on `summary.daysObserved === 1` so the unit is
    `day` (singular) or `days` (plural).
  - Trailing `"(avg X/day)"` (per-day rate) keeps its `day`
    singular — semantically "per one day", not a count.
- `packages/agent-core/src/time-helpers.ts` goal-123 comment
  tidied (the old wording still referenced the deprecated
  placeholder text).

## Verify

- New `apps/cli/test/program.test.ts` case pins both branches:
  - Seed `activity.jsonl` with one session → `"across 1 day "`.
  - Re-seed with three distinct days → `"across 3 days "`.
  - Either way, the literal `"day(s)"` placeholder must NOT
    appear in the output.
- `pnpm --filter @muse/cli test` — 351 tests pass.
- `pnpm check` exit 0; `pnpm lint` exit 0.
- No real-LLM path touched.

## Status

done — the routine dashboard joins goal 123's clean
pluralisation line.
