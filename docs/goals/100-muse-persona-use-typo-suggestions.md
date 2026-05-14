# 100 — `muse persona use <typo-id>` suggests the closest valid id

## Why

Goal 099 added Levenshtein-based "Did you mean …?" suggestions for
unknown top-level subcommands. The persona switch is the most
ergonomic-sensitive next surface: built-in ids (`jarvis`, `casual`,
`professional`, `default`) plus user-defined customs read from
`~/.muse/persona.json`. Typing `muse persona use jarvss` previously
printed only the bare "no persona with id 'jarvss'" line — the user
either remembered the right spelling or ran `muse persona list`.
For a one-character typo this is uncharitable.

## Scope

- `apps/cli/src/commands-persona.ts` `persona use` action:
  - On a no-match, build the candidate list from
    `BUILTIN_PERSONAS.map((p) => p.id)` plus
    `Object.keys(store.custom)`.
  - Feed it through `closestCommandName` (goal 099). When a match
    is in range, append `— did you mean '<id>'?` to the error.
  - When nothing's close enough, keep the line clean — a false-
    positive suggestion is worse than none.
- No schema change, no behaviour change for the happy path.

## Verify

- New test in `apps/cli/test/program.test.ts`:
  - `muse persona use jarvss` → suggests `jarvis`, exit 1.
  - `muse persona use tonu` (custom id `tony` in the seeded
    store) → suggests `tony`, exit 1.
  - `muse persona use xyz-totally-elsewhere` → no false suggestion,
    exit 1.
- `pnpm --filter @muse/cli test` — 297 tests pass.
- `pnpm check` exit 0; `pnpm lint` exit 0.
- Dogfood: `MUSE_PERSONA_FILE=… node apps/cli/dist/index.js persona use jarvss`
  prints `did you mean 'jarvis'?`.

## Status

done — typo on persona id now gets the same JARVIS-class
suggestion the top-level subcommand parser gives. No real-LLM
path touched.
