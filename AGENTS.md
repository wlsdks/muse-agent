# Muse

A provider-neutral personal AI conductor being built around Attunement: learning
how one user lives and works, then getting better at when and how to help. One coherent
reasoning loop, any LLM, any tool, any MCP server.

## Mission

Muse is a personal-use agent: one user, one local environment, no
shared workspace. The runtime discipline is what stays durable —
provider-specific code is kept at the edges.

`Attunement` is the product north star: personal thread → Continuity Pack →
outcome → adaptation. Optional Observe can later improve timing through rhythm
and friction evidence. The full loop is a roadmap, not a shipped claim; current
memory, pattern, proactivity, browser, trace, and checkpoint systems are its
substrates. Product contract:
[`docs/strategy/attunement.md`](docs/strategy/attunement.md). Implementation:
[`docs/goals/attunement-implementation-plan.md`](docs/goals/attunement-implementation-plan.md).

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
[`harness/host/muse-mapping.md`](harness/host/muse-mapping.md).

## Stack

| Area | Choice |
| --- | --- |
| Language | TypeScript 7 native compiler; TypeScript 6 API compatibility alias for tooling |
| Runtime | Node.js >= 22.12 (24 LTS recommended) |
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
| Tests | Vitest 4.1 + Browser Mode/Playwright + opt-in fast-check + Testcontainers |

## Testing contract

Muse chooses a test technique by the failure it must detect, not by a target
test count: deterministic example tests for exact contracts, property tests for
high-risk invariants, real Chromium for React interaction, Testcontainers for
PostgreSQL, and Playwright for critical end-to-end journeys. Keep the edit loop
narrow with `pnpm test:changed`; run the full cross-platform gate before merge.
The operational rules are in [`.claude/rules/testing.md`](.claude/rules/testing.md)
and the TS7-era stack decision and rationale are in
[`docs/development/testing-strategy.md`](docs/development/testing-strategy.md).

## TypeScript 7 toolchain

Muse compiles its project graph with the TypeScript 7 native compiler. The
`typescript` package name remains an alias to Microsoft's `@typescript/typescript6`
compatibility package for tooling that consumes the TypeScript compiler API (notably
typescript-eslint) until that tooling supports the stable TS7 API. Do not replace that
alias with TS7 or use `tsc6` for normal builds without an explicit compatibility review.

Use `pnpm typecheck:fast` for the normal TS7 graph check and
`pnpm typecheck:ts7-fast` only when measuring parallel TS7 checkers/builders. Keep
project references aligned with workspace runtime dependencies, preserve real type
predicates at `unknown`/JSON boundaries, and do not suppress diagnostics through
`ignoreDeprecations`. Details and the official-source migration procedure are in
[`docs/development/typescript-7.md`](docs/development/typescript-7.md).

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
  attunement/         Personal Continuity threads, exact source links,
                      delivery/outcome receipts, display-policy reducer
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
                      Local / Local-ICS / Google / CalDAV / macOS adapters +
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

The agent ships a set of file-backed personal loopback MCP servers
(notes, tasks, calendar, reminders, episode, followup, status,
history, …), all local by default. Contacts are a first-class personal
store + CLI (`muse contacts`) but are surfaced via a tool, not a
`muse.contacts` server namespace.

- `muse.notes.*` → `~/.muse/notes/` markdown directory
  (drop-in compatible with an Obsidian vault).
- `muse.tasks.*` → `~/.muse/tasks.json` todo list.
- `muse.reminders.*` → `~/.muse/reminders.json` store.
- `muse.calendar.*` → provider-neutral, **five backends** (Local,
  Local-ICS, Google, CalDAV, macOS) behind one registry.
  `muse setup calendar` walks the user through OAuth / app-password
  setup interactively.

User-memory auto-extraction (`MUSE_USER_MEMORY_AUTO_EXTRACT=true`,
default `true`) runs an extra structured-output LLM call after each
turn to persist newly stated facts / preferences into the
`UserMemoryStore`. Personal memory is a required Attunement substrate,
so the per-turn cost is on by default. Set to `false`
when an offline run / cheap-model budget / disabled-memory test
rig wants to skip the extra call.

## Where to look next

- [`CLAUDE.md`](CLAUDE.md) — the contract every Claude Code agent reads first.
- [`.claude/rules/`](.claude/rules/) — domain-specific rules.
- [`CHANGELOG.md`](CHANGELOG.md) — running development log (Keep a Changelog format).
- [`docs/design/`](docs/design/) — multi-iter design docs (e.g. voice-mode.md).

This file is the cross-agent product brief. It should not duplicate
the rules in `CLAUDE.md` or `.claude/rules/`.
