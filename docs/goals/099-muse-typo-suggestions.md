# 099 — Typo suggestions for unknown `muse` subcommands

## Why

Running `muse statu` printed `error: too many arguments. Expected
0 arguments but got 1.` — a confusing artifact of the goal-060
"no-arg → help" workaround (`program.action(() => outputHelp)`).
Commander captured the typo as a positional arg to a 0-arg root
action and bailed before it could check whether the user meant a
real subcommand.

JARVIS-class CLIs answer "Did you mean …?". `git`, `kubectl`,
`brew` all do it. This iteration brings Muse to parity.

## Scope

- New pure helper `apps/cli/src/closest-command.ts`:
  - `levenshteinDistance(a, b)` — O(n·m) two-row DP.
  - `closestCommandName(input, candidates, maxDistance?)` — picks
    the closest candidate within a length-aware edit cap (1 edit
    for 1–3 chars, 2 for 4–7, 3 for 8+). Lowercase-insensitive,
    stable tie-break by candidate order.
- `apps/cli/src/program.ts` fallback action rewritten:
  - Accepts one optional positional via `argument("[unknown_subcommand]")`
    + `allowExcessArguments(true)`. `usage("[options] [command]")`
    hides the catchall from the help banner.
  - No arg → `outputHelp()` (goal-060 contract preserved).
  - Unknown arg → `error: unknown command 'X'` to `io.stderr`,
    optionally followed by `Did you mean 'muse Y'?` (only when
    `closestCommandName` returns a real match — a false-positive
    suggestion is worse than none). `process.exitCode = 1`.

## Verify

- New `apps/cli/src/closest-command.test.ts` covers identical /
  insertion / deletion / substitution / empty edge cases, length-
  aware cap, case-insensitivity, and deterministic tie-break.
- New cases in `apps/cli/test/program.test.ts`:
  - `muse statu` → `Did you mean 'muse status'?`, exit code 1.
  - `muse totally-unrelated-input` → no false suggestion, exit 1.
  - `muse` (no arg) → help banner without the `[unknown_subcommand]`
    leak.
- `pnpm --filter @muse/cli test` — 296 tests pass.
- `pnpm check` exit 0; `pnpm lint` exit 0.
- Dogfood: `node apps/cli/dist/index.js histroy` prints
  `Did you mean 'muse history'?`.

## Status

done — typo → suggestion in one keystroke. No real-LLM path
touched, so `smoke:live` is skipped.
