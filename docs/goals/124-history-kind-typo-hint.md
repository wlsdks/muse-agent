# 124 — `muse history --kind <typo>` suggests the closest valid kind

## Why

`muse history --kind followups` (plural slip) threw a flat
`--kind must be one of: reminder, proactive, followup, pattern,
episode (got 'followups')`. Same shape as the bugs goals 099 /
100 / 118 / 119 closed — the typo-suggestion line should extend
into the history surface for consistency.

## Scope

- `apps/cli/src/commands-history.ts`:
  - `--kind` validation now runs the offending input through
    `closestCommandName` against `ACTIVITY_KINDS` and appends
    `— did you mean '<kind>'?` when a match falls inside the
    length-aware Levenshtein cap.
  - Unrelated input still throws the original "must be one of …"
    error without a false-positive suggestion.

## Verify

- New assertions in the existing `muse history --kind` test:
  - `--kind followups` → error contains
    `did you mean 'followup'?`.
  - `--kind zzz` → error fires but no `did you mean` line.
- `pnpm --filter @muse/cli test` — 349 tests pass.
- `pnpm check` exit 0; `pnpm lint` exit 0.
- No real-LLM path touched.

## Status

done — `muse history` joins the goal 099/100/118/119/120/121/122/123
ergonomic line.
