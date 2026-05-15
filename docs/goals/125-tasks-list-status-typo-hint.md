# 125 — `muse tasks list --status <typo>` rejects + suggests the right value

## Why

`readTaskStatusFilter(value)` in `@muse/mcp` deliberately falls
back to `"open"` for any unknown value — the MCP tool needs that
leniency because an LLM might omit / mistype the `status` field
and shouldn't crash the whole tool call. The CLI inherited that
same helper without guarding, so a user typing
`muse tasks list --status doe` silently got the `"open"` list
back instead of the `"done"` list they wanted. Silent typo
footgun, same shape goals 099 / 100 / 118 / 119 / 124 closed
across the rest of the CLI.

## Scope

- `apps/cli/src/commands-tasks.ts`:
  - New CLI-local helper `assertTaskStatusInput(raw)` that
    validates against the explicit set `{ open, done, all }` and
    throws with the goal-099 closest-match hint when the input
    falls outside it.
  - The `tasks list` action runs the helper before either the
    local or remote branch dispatches.
- Shared `readTaskStatusFilter` keeps its lenient MCP-friendly
  semantics — only the CLI surface tightens up.

## Verify

- New `apps/cli/test/program.test.ts` case pins:
  - `--status doe` → `did you mean 'done'?`.
  - `--status al` → `did you mean 'all'?`.
  - `--status totally-unrelated` → "must be one of: open, done,
    all" error without a false-positive suggestion.
  - Happy path (`--status open`) still reaches the fetch path.
- `pnpm --filter @muse/cli test` — 350 tests pass.
- `pnpm check` exit 0; `pnpm lint` exit 0.
- No real-LLM path touched.

## Status

done — typo-suggestion line now covers `muse tasks list --status`.
