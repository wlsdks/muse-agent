# 374 — `muse ask --notes-only`

Category: feature

(Carried forward from the pre-reset backlog as genuine, unbuilt
user-visible work — not a cosmetic edge-case.)

## Why

`muse ask --with-tools` enables web search. For a privacy /
local-only run the user wants RAG-grounded answers from notes
alone, no live network tools — but still the full agent runtime
and notes-RAG embedding path.

## Scope

- New `--notes-only` flag in `commands-ask.ts`.
- When set: disable `web_search` in the run metadata and filter
  the tool registry to notes + memory tools only.
- Mutually exclusive with (or implies) `--with-tools`.

## Verify

- `pnpm check` / `pnpm lint` (0/0) / `pnpm smoke:broad`.
- `pnpm smoke:live`: with `--notes-only`, assert the model never
  invokes `muse.search` (assert the negative directly — no
  fall-back assertion).
- +1 CLI parser test.

## Status

done — already implemented in `apps/cli/src/commands-ask.ts`
(carried-forward doc, the code predates the backlog reset). The
`--notes-only` flag is wired on both paths: it sets
`webSearchPolicy { enabled: false, maxUses: 0 }` (chat-only stream
metadata + agent-runtime metadata) so native web_search is
hard-disabled, and on the `--with-tools` path additionally passes
`metadata.allowedToolNames = NOTES_ONLY_TOOL_ALLOWLIST` (notes +
memory tools only). Verified by source read; no further code work
was warranted — re-pinning shipped logic with a test-only
iteration would be inward churn (banned). Closed as bookkeeping
during the goal-375-slice-1 iteration.
