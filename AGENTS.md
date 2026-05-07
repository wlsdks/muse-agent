# Muse

A provider-neutral, JARVIS-style AI conductor. One coherent reasoning
loop, any LLM, any tool, any MCP server.

## Mission

Muse is the migration target for the Reactor project. Reactor's
Kotlin/Spring Boot module structure is historical implementation
detail. The durable asset is Reactor's runtime discipline:

- Guard is fail-close. Hook is fail-open.
- Tool output is untrusted.
- Tool loops have explicit limits and timeouts.
- Message-pair integrity is preserved.
- Trace every meaningful step.
- Model adapters may differ; `agent-core` stays provider-neutral.

## Stack

| Area | Choice |
| --- | --- |
| Language | TypeScript |
| Runtime | Node.js 24 LTS |
| Package manager | pnpm workspace |
| Server | Fastify |
| Database | PostgreSQL via Kysely |
| Web UI | React + Vite + TanStack Query |
| CLI | commander + Ink TUI |
| Local runner | Rust separate process (`crates/runner`) |
| Model layer | `packages/model` ModelProvider adapters |
| Provider adapters | OpenAI, Anthropic, Gemini, OpenRouter, Ollama, OpenAI-compatible |
| Observability | OpenTelemetry + pino + persisted trace events |
| Tests | Vitest + Playwright + Testcontainers |

## Repository layout

```
apps/
  api/        Fastify API server
  web/        React UI
  cli/        terminal agent (auth, config, TUI)

packages/
  agent-core/         Guard, Hook, ReAct loop, message integrity
  model/              ModelProvider interface + adapters
  tools/              tool registry, MCP adapter, built-in tools
  policy/             approval, permissions, guardrails
  memory/             conversation state, context trimming, checkpoints
  multi-agent/        SupervisorAgent, MultiAgentOrchestrator, message bus
  mcp/                MCP transport + loopback servers
  observability/      spans, metrics, run events
  runtime-state/      run history, hook traces, approval store
  db/                 Kysely queries + SQL migrations
  ...

crates/
  runner/             Rust sandbox: shell/process/file execution

docs/
  migration-plan.md   running notes on Reactor → Muse parity
  audits/             periodic deep-dive parity audits

.claude/
  rules/              domain-specific rules auto-loaded with CLAUDE.md
  commands/           reusable slash commands
  agents/             subagent definitions
```

## Where to look next

- [`CLAUDE.md`](CLAUDE.md) — the contract every Claude Code agent reads first.
- [`.claude/rules/`](.claude/rules/) — domain-specific rules.
- [`docs/migration-plan.md`](docs/migration-plan.md) — running migration notes.
- [`docs/audits/`](docs/audits/) — periodic parity audits.

This file is the cross-agent product brief. It should not duplicate
the rules in `CLAUDE.md` or `.claude/rules/`.
