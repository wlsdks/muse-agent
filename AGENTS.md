# Muse - Agent Instructions

Muse is an inspirational AI agent that helps users generate ideas, compare options, and make decisions.
This repository is the migration target for the Reactor project. Migrate Reactor's operating discipline,
not its Spring Boot structure.

## Product Direction

Muse should become a model-agnostic agent platform with both server and CLI surfaces.

- The agent must help users explore ideas, clarify tradeoffs, and choose a path.
- The runtime must not depend on a single model vendor.
- The CLI and server must share the same agent core.
- Safety, approval, tracing, and context management are product requirements, not optional polish.

## Final Stack

| Area | Choice |
| --- | --- |
| Language | TypeScript |
| Runtime | Node.js 24 LTS |
| Package manager | pnpm workspace |
| Server | Fastify |
| Database | PostgreSQL |
| DB access | Kysely |
| Web UI | React + Vite + TanStack Query |
| CLI | TypeScript CLI + Ink TUI |
| Local runner | Rust separate process |
| Model layer | Muse-owned `ModelProvider` interface |
| Provider adapters | OpenAI, Anthropic, Gemini, OpenRouter, Ollama, OpenAI-compatible |
| Workflow framework | Do not adopt LangGraph.js as the default core |
| Observability | OpenTelemetry + pino + persisted trace events |
| Tests | Vitest + Playwright + Testcontainers |

## Target Repository Layout

```text
apps/
  api/        Fastify API server
  web/        React UI
  cli/        terminal agent, auth, config, TUI

packages/
  agent-core/ Guard, Hook, loop, message integrity
  model/      provider-neutral model interface and adapters
  tools/      tool registry, MCP adapter, built-in tools
  policy/     approval, permissions, guardrails
  memory/     conversation state, context trimming, checkpoints
  db/         Kysely queries and SQL migrations
  tracing/    spans, metrics, run events
  shared/     shared schemas and types

crates/
  runner/     Rust sandbox, shell/process/file execution
```

## Reactor Migration Rules

Carry these Reactor concepts forward:

- Guard is fail-close.
- Hook is fail-open.
- Security logic belongs in guards, not prompts.
- Tool approval policy gates risky execution before it happens.
- Tool output is untrusted and must be sanitized.
- ReAct/tool loops must have explicit limits and timeouts.
- Assistant messages and tool responses must preserve pair integrity.
- Context trimming must be deterministic and test-covered.
- Trace every meaningful step through metrics and run events.
- Model adapters may differ, but `agent-core` must stay provider-neutral.

Do not migrate Reactor by copying Spring module boundaries. The Spring Boot modules are historical
implementation detail. The durable asset is the runtime discipline above.

## Migration Redaction Rules

When moving code, docs, prompts, fixtures, reports, or examples from Reactor into Muse, remove private
or identifying material before committing it.

Redact or generalize:

- Personal names, usernames, emails, phone numbers, addresses, and account identifiers.
- Company, customer, vendor, team, workspace, tenant, Slack, Jira, GitHub, or domain names from migrated
  private content.
- API keys, tokens, secrets, hostnames, connection strings, internal URLs, and private repository paths.
- Business-specific prompt examples, reports, traces, or fixtures that reveal real organizations or people.

Use neutral replacements such as `example-user`, `example-tenant`, `sample-workspace`, and
`example.com`. Provider names such as OpenAI, Anthropic, Gemini, OpenRouter, and Ollama are allowed when
they describe public adapter support.

If redaction would make a behavior test meaningless, keep the behavior and rewrite the fixture with
synthetic data. If a value might identify a person or organization, do not migrate it as-is.

## Model-Agnostic Runtime

The core runtime must call a Muse-owned abstraction, not OpenAI, Anthropic, Vercel AI SDK, or LangGraph
directly.

```ts
interface ModelProvider {
  id: string;
  listModels(): Promise<ModelInfo[]>;
  generate(request: ModelRequest): Promise<ModelResponse>;
  stream(request: ModelRequest): AsyncIterable<ModelEvent>;
}
```

Each model must be described by capabilities:

- `streaming`
- `toolCalling`
- `structuredOutput`
- `vision`
- `reasoning`
- `promptCaching`
- `maxInputTokens`
- `maxOutputTokens`
- `local`
- `cost`
- `latencyProfile`

Fallback rules:

- If native tool calling is unavailable, use a text tool protocol with strict parsing.
- If structured output is unavailable, use parser fallback with validation.
- If the context window is small, apply stronger trimming before model invocation.
- If a provider fails, route through an explicit fallback policy, not hidden retry magic.

Vercel AI SDK provider packages may be used inside adapters. They must not become the core runtime API.
OpenAI Agents SDK may be studied, but must not own Muse's core agent contracts.

## CLI Requirements

The CLI is a first-class product surface.

- Command parser: `commander`
- Interactive prompts: `@clack/prompts`
- Full terminal UI: Ink
- Config path: `~/.config/muse/config.json`
- Workspace state: `.muse/runs/*.jsonl`
- Credentials: OS keychain or encrypted auth store
- Remote mode: connect to the API server over SSE or WebSocket
- Local mode: execute `packages/agent-core` in the CLI process
- Risky execution: call the Rust runner as a child process

The CLI must not fork agent behavior. Server and CLI should share the same runtime packages.

## Database Rules

- PostgreSQL is the source of truth for server state.
- Kysely is used for typed SQL access.
- Prefer explicit SQL migrations over ORM-managed schema mutation.
- Keep run, message, tool call, approval, checkpoint, and trace tables queryable for debugging.
- Do not hide critical agent state in opaque blobs unless the blob is an append-only event payload.

## Coding Rules

- Keep core packages framework-independent.
- Use TypeScript strict mode.
- Use Zod or a comparable schema layer for external input and config validation.
- Prefer small interfaces and explicit adapters over global service locators.
- Do not add framework abstractions until a real module boundary needs them.
- Keep prompt text and tool protocols snapshot-tested when behavior matters.
- Avoid provider-specific assumptions in `agent-core`.
- Use deterministic code for policy, permissions, budgets, and stop conditions.

## Test Rules

New behavior should include the narrowest useful test first.

- Unit tests for policy, trimming, message pairing, and provider capability logic.
- Contract tests for each model provider adapter.
- Integration tests for API run lifecycle and approval flows.
- CLI smoke tests for config, auth, local run, and remote run.
- Playwright tests for UI flows once `apps/web` exists.
- Testcontainers-backed tests for PostgreSQL query behavior where SQL matters.

## Commit Rules

Use Conventional Commits.
Write commit subjects and commit descriptions in English.

- `feat:` user-visible feature or new project capability
- `fix:` bug fix
- `refactor:` behavior-preserving code restructuring
- `test:` test-only change
- `docs:` documentation-only change
- `chore:` tooling, config, dependency, repository maintenance

Make small commits after coherent milestones. Do not mix unrelated migration work into one commit.

## Verification Rules

Before committing, run the narrowest relevant verification available.

- Documentation/config-only change: `git diff --check`
- TypeScript package change: package tests plus `pnpm lint` or `pnpm test` once available
- Rust runner change: `cargo test` for the relevant crate
- Full migration milestone: lint, test, build, CLI smoke, and API smoke

If a verification command cannot run because the scaffold does not exist yet, state that clearly in the
commit or final summary.
