# Muse Migration Plan

Source baseline: Reactor has 31 modules under `/modules`.

Current Muse baseline:
- Packages: 23
- Apps: 2
- Verified gate: `pnpm check`
- Branch state: verify with `git status -sb` before pushing or merging

## Current Count

| Bucket | Count | Meaning |
| --- | ---: | --- |
| Reactor modules with Muse landing zones | 31 | Every source module has a package or API target |
| Functionally exercised migration areas | 31 | Core behavior exists and is covered by package/API tests |
| Deep-hardening areas still open | 0 | No known source module remains without functional and tested coverage |
| Remaining unmapped modules | 0 | No source module is without a target |

## Completed Migration Areas

| Reactor module | Muse target | Current status |
| --- | --- | --- |
| `agent` | `packages/agent-core` | ReAct loop, tool execution, streaming, guards, hooks, cache, RAG, history |
| `api` | `apps/api` | Chat, SSE chat, auth, settings, agent specs, history, MCP, scheduler, quality routes |
| `admin` | `apps/api`, `packages/runtime-state`, `packages/db` | Metrics, cache, alert, cost, SLO, tenant ops |
| `approval` | `packages/policy`, `packages/runtime-state` | Approval policies and pending approval stores exist |
| `auth` | `packages/auth`, `apps/api` | JWT auth, password hashing, user store, revocation, guard, rate limiting |
| `autoconfigure` | `packages/autoconfigure` | Environment-driven runtime assembly and DB-backed store selection exist |
| `cache` | `packages/cache` | Response cache, scope fingerprint, TTL invalidation, prompt-cache metadata, stats |
| `common` | `packages/shared` | Shared IDs, JSON, and common value types exist |
| `context` | `packages/memory` | Context trimming and message-pair handling exist |
| `core` | `apps/api`, `packages/autoconfigure` | Fastify bootstrap and runtime assembly replace Spring Boot core |
| `eval` | `packages/eval`, `apps/api` | Eval case model, judges, runner, summaries, and admin API exist |
| `guard` | `packages/policy`, `packages/agent-core` | Input/output guards and fail-close runtime integration exist |
| `hook` | `packages/agent-core`, `packages/runtime-state` | Registry callbacks and hook trace stores exist |
| `hook-integrations` | `packages/integrations` | Lifecycle webhook dispatch and HMAC signing primitives exist |
| `intent` | `packages/agent-specs` | Agent specs, resolver, registry, and Kysely mapping exist |
| `memory` | `packages/memory`, `packages/runtime-state` | Context, checkpoints, run history, and stores exist |
| `mcp` | `packages/mcp`, `apps/api` | SDK transports, health checks, reconnect, and management APIs exist |
| `model-routing` | `packages/model` | Provider registry, prefix routing, and OpenAI-compatible provider exist |
| `multi-agent` | `packages/multi-agent` | Supervisor, worker selection, fallback, and handoff trace primitives exist |
| `observability` | `packages/observability`, `packages/runtime-state` | Tracing, metrics, and history stores exist |
| `persistence-schema` | `packages/db` | Kysely schema covers runtime, scheduler, MCP, and admin state |
| `promptlab` | `packages/promptlab`, `apps/api` | Prompt variants, experiments, runner, ranking, and admin API exist |
| `prompts` | `packages/prompts` | Prompt assembly, response format instructions, and cache boundary helpers exist |
| `rag` | `packages/rag` | Chunking, BM25/RRF retrieval, reranking, context building, and in-memory corpus exist |
| `resilience` | `packages/resilience` | Circuit breaker registry, retry, timeout, and model fallback primitives exist |
| `response` | `packages/policy`, `packages/agent-core` | Output guards, source filters, and structured filters exist |
| `runtime-settings` | `packages/runtime-settings`, `apps/api` | Runtime settings service/store and API surface exist |
| `scheduler` | `packages/scheduler`, `apps/api` | CRUD, execution records, cron, and scheduler locks exist |
| `slack` | `packages/integrations`, `apps/api` | Signed Events API, slash command, and response_url integration exist |
| `tool` | `packages/tools` | Tool registry, executor, sanitizer, and approval path exist |
| `web` | `apps/api` | HTTP/SSE run endpoints and typed error surfaces exist |

## Remaining Deep-Hardening Areas

No known source module remains unmapped.
Continued work should be treated as new hardening or product expansion, not migration catch-up.

## Recent Completion Notes

- MCP now uses real SDK transports for stdio, SSE, and streamable HTTP.
- Slack signed slash commands and URL verification are wired through API routes.
- Admin APIs cover metrics, cache invalidation, and circuit breaker reset operations.
- Scheduler has management routes plus a Node cron runtime.
- OpenAI-compatible streaming now preserves streamed tool-call deltas.
- `AgentRuntime.stream()` now executes streamed tool calls through the ReAct loop.
- API chat parsing now preserves assistant `toolCalls`, keeping message pairs intact.
- Response filtering strips copied trailing source blocks and buffers text when filters or output guards are active.
- Hook registry execution now records completed/failed hook traces in runtime state.
- Structured output filtering normalizes JSON/YAML responses when requested by run metadata.
- MCP health checks now mark unhealthy connections and reconnect due servers with backoff.
- Scheduler now has in-memory and Kysely-backed distributed lock implementations.
- Admin operations now include tenant, alert acknowledgement, cost summary, and SLO state APIs.
- Runtime assembly now switches to Kysely-backed stores when a database handle is provided.

## Execution Plan

1. Keep `pnpm check` green as the migration acceptance gate.
2. Add new work as product hardening tickets rather than migration backlog.

## Migration Rules

- Keep private names, organizations, real traces, credentials, and absolute source paths out of Muse.
- Prefer generic examples such as `user-1`, `workspace-1`, `read_file`, and `provider/model`.
- Each migration unit gets its own conventional commit.
- Run narrow package tests first, then `pnpm check` before committing.
