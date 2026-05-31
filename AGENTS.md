# Muse

A provider-neutral, JARVIS-style personal AI conductor. One coherent
reasoning loop, any LLM, any tool, any MCP server.

## Mission

Muse is a personal-use agent: one user, one local environment, no
shared workspace. The runtime discipline is what stays durable —
provider-specific code is kept at the edges.

- Guard is fail-close. Hook is fail-open.
- Tool output is untrusted.
- Tool loops have explicit limits and timeouts.
- Message-pair integrity is preserved.
- Trace every meaningful step.
- Model adapters may differ; `agent-core` stays provider-neutral.

## Agent operating harness (read before multi-step work)

This repo ships a portable, vendor-neutral agent harness in
[`harness/`](harness/). For any non-trivial, multi-step task, operate
under it: read [`harness/AGENTS.md`](harness/AGENTS.md) first and follow
its roles (planner / worker / evaluator — maker ≠ judge), the handoff
template, the fail-closed gates (plan / completion / permission), and the
verification discipline (golden-set + pass^k). The `harness/` folder is
self-contained — copy it into any project and point that project's
`AGENTS.md`/`CLAUDE.md` at `harness/AGENTS.md` to reuse it
([`harness/INSTALL.md`](harness/INSTALL.md)). Muse-runtime mapping:
[`harness/muse-mapping.md`](harness/muse-mapping.md).

## Stack

| Area | Choice |
| --- | --- |
| Language | TypeScript |
| Runtime | Node.js 24 LTS |
| Package manager | pnpm workspace |
| Server | Fastify |
| Database | PostgreSQL via Kysely (optional — runs in-memory by default) |
| Web UI | React + Vite + TanStack Query |
| CLI | commander + Ink TUI + clack-prompts wizards |
| Local runner | Rust separate process (`crates/runner`) |
| Model layer | `packages/model` ModelProvider adapters |
| Provider adapters | OpenAI (Responses API), Anthropic, Gemini, OpenRouter, Ollama + OpenAI-compat presets (Groq, DeepSeek, Together, Mistral, Moonshot, Cerebras). "LM Studio" = the OpenAI-compatible adapter pointed at a local `baseUrl` (no dedicated class/preset). |
| Calendar adapters | Local file, Google Calendar, CalDAV (iCloud / Fastmail / Proton), macOS Calendar.app |
| Observability | OpenTelemetry + pino + persisted trace events |
| Tests | Vitest + Playwright + Testcontainers |

## Repository layout

```
apps/
  api/        Fastify API server (chat, agent specs, multi-agent,
              MCP, scheduler, calendar, tasks)
  web/        React UI (chat, tasks, calendar, settings)
  cli/        terminal agent (auth, config, TUI, setup wizards)

packages/
  agent-core/         Guard, Hook, ReAct + Plan-Execute loops,
                      message integrity, context transforms
  model/              ModelProvider interface + provider wire adapters
  tools/              tool registry, MCP adapter, built-in tools
  policy/             approval, permissions, guardrails
  memory/             conversation state, context trimming,
                      checkpoints, user-memory auto-extraction hook
  multi-agent/        SupervisorAgent, MultiAgentOrchestrator,
                      message bus
  mcp/                MCP transport + loopback servers
                      (notes / tasks / calendar) + NotesProvider abstraction
  calendar/           CalendarProvider abstraction +
                      Local / Google / CalDAV / macOS adapters +
                      chmod-600 credential store
  observability/      spans, metrics, run events
  runtime-state/      run history, hook traces, approval store
  db/                 Kysely queries + SQL migrations
  scheduler/          cron jobs + distributed locks
  ...

crates/
  runner/             Rust sandbox: shell/process/file execution

docs/
  design/             design docs (e.g. voice-mode.md)

.claude/
  rules/              domain-specific rules auto-loaded with CLAUDE.md
  commands/           reusable slash commands
  agents/             subagent definitions
```

## Personal-domain primitives

The agent ships three personal loopback MCP servers, all
file-backed by default:

- `muse.notes.*` → `~/.muse/notes/` markdown directory
  (drop-in compatible with an Obsidian vault).
- `muse.tasks.*` → `~/.muse/tasks.json` todo list.
- `muse.calendar.*` → provider-neutral, four backends behind one
  registry. `muse setup calendar` walks the user through OAuth /
  app-password setup interactively.

User-memory auto-extraction (`MUSE_USER_MEMORY_AUTO_EXTRACT=true`,
default `true`) runs an extra structured-output LLM call after each
turn to persist newly stated facts / preferences into the
`UserMemoryStore`. JARVIS-class memory is core to the product
identity, so the per-turn cost is on by default. Set to `false`
when an offline run / cheap-model budget / disabled-memory test
rig wants to skip the extra call.

## Where to look next

- [`CLAUDE.md`](CLAUDE.md) — the contract every Claude Code agent reads first.
- [`.claude/rules/`](.claude/rules/) — domain-specific rules.
- [`CHANGELOG.md`](CHANGELOG.md) — running development log (Keep a Changelog format).
- [`docs/design/`](docs/design/) — multi-iter design docs (e.g. voice-mode.md).

This file is the cross-agent product brief. It should not duplicate
the rules in `CLAUDE.md` or `.claude/rules/`.
