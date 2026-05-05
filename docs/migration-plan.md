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
| Functionally exercised migration areas | 29 | Core behavior exists and is covered by package/API tests |
| Deep-hardening areas still open | 5 | Behavior exists, but production depth is not complete |
| Remaining unmapped modules | 0 | No source module is without a target |

## Completed Migration Areas

| Reactor module | Muse target | Current status |
| --- | --- | --- |
| `agent` | `packages/agent-core` | ReAct loop, tool execution, streaming, guards, hooks, cache, RAG, history |
| `api` | `apps/api` | Chat, SSE chat, auth, settings, agent specs, history, MCP, scheduler, quality routes |
| `approval` | `packages/policy`, `packages/runtime-state` | Approval policies and pending approval stores exist |
| `auth` | `packages/auth`, `apps/api` | JWT auth, password hashing, user store, revocation, guard, rate limiting |
| `autoconfigure` | `packages/autoconfigure` | Environment-driven runtime assembly for API defaults exists |
| `cache` | `packages/cache` | Response cache, scope fingerprint, TTL invalidation, prompt-cache metadata, stats |
| `common` | `packages/shared` | Shared IDs, JSON, and common value types exist |
| `context` | `packages/memory` | Context trimming and message-pair handling exist |
| `eval` | `packages/eval`, `apps/api` | Eval case model, judges, runner, summaries, and admin API exist |
| `guard` | `packages/policy`, `packages/agent-core` | Input/output guards and fail-close runtime integration exist |
| `hook` | `packages/agent-core`, `packages/runtime-state` | Registry callbacks and hook trace stores exist |
| `hook-integrations` | `packages/integrations` | Lifecycle webhook dispatch and HMAC signing primitives exist |
| `intent` | `packages/agent-specs` | Agent specs, resolver, registry, and Kysely mapping exist |
| `memory` | `packages/memory`, `packages/runtime-state` | Context, checkpoints, run history, and stores exist |
| `model-routing` | `packages/model` | Provider registry, prefix routing, and OpenAI-compatible provider exist |
| `multi-agent` | `packages/multi-agent` | Supervisor, worker selection, fallback, and handoff trace primitives exist |
| `observability` | `packages/observability`, `packages/runtime-state` | Tracing, metrics, and history stores exist |
| `persistence-schema` | `packages/db` | Kysely schema and migrations exist |
| `promptlab` | `packages/promptlab`, `apps/api` | Prompt variants, experiments, runner, ranking, and admin API exist |
| `prompts` | `packages/prompts` | Prompt assembly, response format instructions, and cache boundary helpers exist |
| `rag` | `packages/rag` | Chunking, BM25/RRF retrieval, reranking, context building, and in-memory corpus exist |
| `resilience` | `packages/resilience` | Circuit breaker registry, retry, timeout, and model fallback primitives exist |
| `response` | `packages/policy`, `packages/agent-core` | Output guards and source filtering exist |
| `runtime-settings` | `packages/runtime-settings`, `apps/api` | Runtime settings service/store and API surface exist |
| `scheduler` | `packages/scheduler`, `apps/api` | CRUD API, trigger/dry-run, execution records, and Node cron exist |
| `slack` | `packages/integrations`, `apps/api` | Signed Events API, slash command, and response_url integration exist |
| `tool` | `packages/tools` | Tool registry, executor, sanitizer, and approval path exist |
| `web` | `apps/api` | HTTP/SSE run endpoints and typed error surfaces exist |

## Remaining Deep-Hardening Areas

| Area | Current gap | Target |
| --- | --- | --- |
| `admin` | Tenant, alert, cost, and SLO operations are shallow | Add operational stores and routes |
| `core` | Boundary stability needs continued review | Keep shared contracts minimal and versionable |
| `mcp` | Reconnect and health policy are shallow | Add health checks, backoff, and reconnect state |
| `scheduler` | No distributed lock for multi-instance deployment | Add lock abstraction before horizontal scale |
| `response` | Structured output normalization is still basic | Add JSON/YAML validation pipeline |

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

## Execution Plan

1. Add MCP reconnect and health policy with backoff state.
2. Add structured output normalization for JSON/YAML responses.
3. Expand admin into tenant, alert, cost, and SLO operations.
4. Add scheduler distributed lock abstraction before multi-instance deployment.
5. Replace in-memory default stores with production persistence wiring where needed.

## Migration Rules

- Keep private names, organizations, real traces, credentials, and absolute source paths out of Muse.
- Prefer generic examples such as `user-1`, `workspace-1`, `read_file`, and `provider/model`.
- Each migration unit gets its own conventional commit.
- Run narrow package tests first, then `pnpm check` before committing.
