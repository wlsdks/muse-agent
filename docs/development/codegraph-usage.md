# CodeGraph usage contract

Muse supports CodeGraph as an optional local code-intelligence accelerator. It
is not a repository prerequisite and does not affect the product runtime. An
agent or contributor without CodeGraph must ignore CodeGraph-specific rules and
continue with the normal filesystem, compiler, and test tools.

This contract was checked against `colbymchenry/codegraph` v1.5.0. Do not mix it
with similarly named graph/RAG projects.

## v1.5 retrieval contract

Version 1.5 makes `codegraph_explore` the only default MCP tool. It accepts
natural-language questions as well as precise symbol/file names and returns
source, relationships, flow paths, and a blast-radius summary together. Narrow
tools still exist but are hidden unless explicitly enabled.

Therefore Muse does not require agents to call `context`, `trace`, `search`, or
`node` first. For an indexed structural question, start with one
`codegraph_explore` call. When exact symbols or endpoints are already known,
pass a short bag containing only those exact symbols, qualified names, or file
paths. Omit generic filler that can broaden retrieval. Natural language remains
the right input when the names are not yet known.

## Decision table

| Need | Preferred path |
| --- | --- |
| Understand indexed code, a flow, or a change radius | One `codegraph_explore` call with relevant names/question |
| Read/edit a known indexed symbol or source file | Name it in `codegraph_explore`; use returned line-numbered source |
| Find a literal string, comment, JSON key, docs, or config | Native `rg`/Read |
| Inspect exact deeper impact after Explore | Optional `codegraph impact <symbol>` CLI |
| Suggest tests for changed source files | Optional `codegraph affected ...`; then apply Muse's test contract |
| CodeGraph not installed or freshness cannot be restored | Ignore CodeGraph rules and use native tools |
| Installed CodeGraph but this Muse checkout is unindexed or borrowing another worktree | Run authorized `codegraph init`, then use it after status is healthy |

`codegraph affected` follows import dependencies transitively. It is a focused
test-selection hint, not a proof of behavioral coverage and not a replacement
for `pnpm test:changed` or a scope-required gate.

## Result-admission protocol

CodeGraph is most valuable for positive navigation: it gets an agent to the
right symbols, paths, and surrounding relationships in one call. Admit a result
for use only after the returned heading, source declaration/signature,
qualified symbol, and file path match the query. If an overloaded or fuzzy name
resolves ambiguously, retry with both the exact symbol and file path. Fall back
to a targeted native read/search when the identity still does not match.

Do not turn a negative CodeGraph result into an exhaustive claim. At v1.5.0,
reports in the official issue tracker show fuzzy substitution for a missing
symbol, stale line-range attribution, incomplete traversal through a TypeScript
alias, and direct-only covering-test detection. Fixes for stale line ranges and
direct-only test detection were merged after v1.5.0 and therefore remain absent
from that installed release. Consequently,
`not found`, `no callers`, `no affected tests`, and an empty blast radius cannot
alone justify deletion, rename safety, public-contract safety, or skipping a
test gate. Confirm the specific negative claim with compiler/language tooling,
required tests, or a narrow native search.

This is intentionally narrower than re-running grep after every successful
Explore call. Fresh, identity-matched positive results should not be
re-derived; only consequential absence/completeness claims require an
independent correctness surface.

## Freshness protocol

CodeGraph watches source changes and auto-syncs by default. Connect-time
reconciliation also picks up changes made while the MCP server was absent.
Routine manual sync after every edit, pull, merge, or branch switch is therefore
unnecessary.

- No banner: use identity-matched positive results directly.
- Pending-file banner: read only the listed files for current content.
- Auto-sync-disabled or borrowed-worktree banner: stop trusting affected
  content, run `codegraph status`, and use native reads until repaired.
- Persistently pending or script-driven index: run `codegraph sync`.
- Older extraction-version stamp reported by status/upgrade, partial/truncated
  graph, or verified inconsistent graph: run a full `codegraph index` rebuild.
  Do not add `--force` for an ordinary rebuild; that flag overrides only the
  root/home-directory safety check.

Each Git worktree needs an index associated with that checkout. The owner has
granted standing permission to initialize, sync, and rebuild in-scope Muse
indexes, so Muse agents need not pause for a second indexing approval. This does
not require contributors who have not installed CodeGraph to install or use it.

## Boundaries

- Trust fresh CodeGraph structural results instead of re-deriving them with a
  grep/read loop.
- Do not delegate a simple structural lookup to a file-reading sub-agent.
- Do not use CodeGraph for literal-text search or files it does not index.
- Do not treat CodeGraph as a correctness oracle. Typecheck, lint, and tests
  remain authoritative.
- Do not make `codegraph affected` the sole test selector.

## Official sources

- [v1.5 server instructions](https://github.com/colbymchenry/codegraph/blob/v1.5.0/src/mcp/server-instructions.ts)
- [v1.5 README and CLI reference](https://github.com/colbymchenry/codegraph/blob/v1.5.0/README.md)
- [v1.5.0 release notes](https://github.com/colbymchenry/codegraph/releases/tag/v1.5.0)
- [Open issue: fuzzy symbol substitution](https://github.com/colbymchenry/codegraph/issues/1473)
- [Fixed after v1.5.0: stale line-range attribution](https://github.com/colbymchenry/codegraph/issues/1474)
- [Fixed after v1.5.0: direct-only covering-test detection](https://github.com/colbymchenry/codegraph/issues/1475)
- [Open issue: TypeScript alias impact gap](https://github.com/colbymchenry/codegraph/issues/1482)
