# 119 — `muse memory set <typo-kind>` suggests the right kind

## Why

`muse memory set preferene name Stark` threw a flat
`Error: kind must be 'fact' or 'preference'` — no clue which of
the four valid forms (`fact` / `facts` / `preference` /
`preferences`) the user was closest to. JARVIS-class CLIs answer
"sir, did you mean preference?" — matches the typo-suggestion line
already running for goals 099 (top-level subcommands), 100
(`muse persona use`), 114 (recall embed model), 118 (trust
revoke / unblock).

## Scope

- `apps/cli/src/commands-memory.ts`:
  - Export new constant `MEMORY_KIND_FORMS` = the four accepted
    spellings.
  - `parseKindSegment` (now exported) runs the typo through
    `closestCommandName` and appends a `— did you mean '<form>'?`
    hint to the existing error message when a match falls inside
    the length-aware Levenshtein cap.
  - Error message also names the offending input verbatim
    (`got '<value>'`) so a scripted caller can grep it.

## Verify

- New `apps/cli/test/program.test.ts` case pins:
  - Happy path: `fact` / `facts` / `preference` / `preferences`
    all parse; whitespace + case-insensitive.
  - One-edit typo (`facs`) → error contains `got 'facs'` AND
    `did you mean 'fact'?`.
  - Two-edit typo on longer form (`preferene`) → suggests
    `'preference'`.
  - Unrelated input (`foobarbaz-nope`) → still throws but no
    false-positive suggestion.
- `pnpm --filter @muse/cli test` — 349 tests pass.
- `pnpm check` exit 0; `pnpm lint` exit 0.
- No real-LLM path touched.

## Status

done — extends the typo-suggestion line into the memory subcommand
group.
