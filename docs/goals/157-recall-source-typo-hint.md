# 157 — `muse recall --source` rejects + fuzzy-suggests typos

## Why

`muse recall --source <id>` accepts `notes | episodes | all`.
Pre-iter the validator was `if (trimmed === "notes" || trimmed
=== "episodes") return trimmed; return "all";` — an unknown
value silently widened to "all". A user typing `--source note`
(singular) thought they'd filtered to the notes index but
actually ran the full cross-store recall, which can produce
very different ranking. No feedback, no clue.

Same shape as goal 151 (`muse job list --status`), goal 100
(`muse persona use <id>`), goal 131 (`muse mcp use <preset>`),
etc.

## Scope

- `apps/cli/src/commands-recall.ts`:
  - New `RECALL_SOURCE_VALUES = ["all", "notes", "episodes"]`
    tuple — single source of truth for both the validator and
    the typo hint.
  - `resolveSource` now returns a discriminated union
    `{ kind: "ok"; source } | { kind: "invalid"; input }` so the
    caller can branch on bad input without changing the success
    path's return type.
  - Action calls `closestCommandName(input, RECALL_SOURCE_VALUES)`
    on invalid input + emits the standard
    `did you mean '<closest>'?` + valid-set + exit 1.
- `apps/cli/src/commands-recall.test.ts` (new):
  - 5 cases — undefined, empty/whitespace, each known value
    case-insensitive, three unknown shapes, raw-input preservation
    for the hint renderer.

## Verify

- `pnpm --filter @muse/cli test` — 409 tests pass.
- `pnpm check` exit 0.
- `pnpm lint` exit 0.
- No real-LLM path touched (`smoke:live` unchanged).

## Status

done — silent fallback eliminated; the user types `--source
note` and gets `did you mean 'notes'?` instead of a confusing
cross-store rank list.
