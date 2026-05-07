# Muse

Muse is a provider-neutral, JARVIS-style AI conductor. The runtime
orchestrates any LLM, any tool, any MCP server — without hard-wiring
a vendor SDK into core code.

This file is the **contract** every Claude Code agent reads first.
Keep it under 100 lines. Anything longer goes in `.claude/rules/*.md`
(loaded alongside this file).

## Quick commands

```bash
pnpm check                                      # lint + typecheck + tests for every workspace
pnpm smoke:broad                                # 49 HTTP endpoints against the diagnostic provider
pnpm smoke:live                                 # 6 HTTP endpoints against a real LLM (auto-skips without *_API_KEY)
REACTOR_SOURCE_DIR=<reactor-path> pnpm verify:reactor-routes
REACTOR_SOURCE_DIR=<reactor-path> pnpm verify:reactor-db
```

These commands are the ground truth. If any fails, stop and triage.

## Non-negotiables

- `agent-core` is model-agnostic. Provider SDKs live behind `packages/model` adapters only.
- Guards are fail-close. Hooks are fail-open. Security is deterministic code, never prompt instruction.
- Tool output is untrusted. Tool loops have explicit limits and timeouts.
- Risky local execution flows through `crates/runner`.
- Server, CLI, and any future surface share the same `agent-core` runtime.
- Tests are the only form of verification. Every claim must be testable.

## Don't

- Don't make OpenAI / Anthropic / Vercel-AI-SDK / LangGraph the runtime owner.
- Don't push, force-push, or `--no-verify` without explicit user approval.
- Don't commit live Jira / Confluence / Bitbucket / Slack-workspace credentials.
- Don't bloat this file past 100 lines — add to `.claude/rules/<topic>.md` instead.
- Don't migrate Reactor's Spring module boundaries — only its runtime discipline.

## Domain rules

For depth, read the matching file under `.claude/rules/`:

- [`architecture.md`](.claude/rules/architecture.md) — package layout, ModelProvider contract, fallback policy
- [`cli-product.md`](.claude/rules/cli-product.md) — CLI surface (commander, Ink, config paths)
- [`testing.md`](.claude/rules/testing.md) — verification gates and the narrowest-useful-test rule
- [`commits.md`](.claude/rules/commits.md) — Conventional Commits + push policy
- [`redaction.md`](.claude/rules/redaction.md) — synthetic identifiers when migrating Reactor content
- [`migration-loop.md`](.claude/rules/migration-loop.md) — per-iteration discipline for the recurring migration loop

## Working agreement

When the user corrects Claude on a recurring mistake, end the
iteration by adding the rule to the matching `.claude/rules/*.md`
(or open a new one). This file should shrink, not grow.

For broader product context, see [`AGENTS.md`](AGENTS.md) and
[`docs/migration-plan.md`](docs/migration-plan.md).
