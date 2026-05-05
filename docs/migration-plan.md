# Muse Migration Plan

Source baseline: Reactor has 31 modules under `/modules`.

Current Muse baseline:
- Packages: 23
- Apps: 2
- Verified gate: `pnpm check`
- Local branch state at latest update: `main` ahead of `origin/main` by 8 commits

## Current Count

| Bucket | Count | Meaning |
| --- | ---: | --- |
| Migrated foundation modules | 22 | Dedicated Muse package/API foundation exists and is tested |
| Partially migrated modules | 9 | Surface exists but behavior is not complete |
| Remaining unmigrated modules | 0 | Every Reactor module now has a Muse landing zone |
| Remaining work items | 9 | Partial completions only |

## Migrated Foundation Modules

| Reactor module | Muse target | Current status |
| --- | --- | --- |
| `approval` | `packages/policy`, `packages/runtime-state` | Approval policy and pending approval stores exist |
| `auth` | `packages/auth`, `apps/api` | JWT auth, password hashing, user store, token revocation, auth guard, and rate limiting exist |
| `common` | `packages/shared` | Shared IDs, JSON, and common value types exist |
| `context` | `packages/memory` | Context trimming and message-pair handling exist |
| `guard` | `packages/policy`, `packages/agent-core` | Input/output guards and fail-close runtime integration exist |
| `intent` | `packages/agent-specs` | Agent specs, rule resolver, registry, Kysely mapping exist |
| `cache` | `packages/cache` | Response cache, scope fingerprint, TTL invalidation, prompt-cache metadata, stats exist |
| `memory` | `packages/memory`, `packages/runtime-state` | Context primitives and checkpoint stores exist |
| `model-routing` | `packages/model` | Model provider registry and provider prefix routing exist |
| `observability` | `packages/observability`, `packages/runtime-state` | In-memory tracing/metrics and run history stores exist |
| `persistence-schema` | `packages/db` | Kysely schema and migrations exist |
| `prompts` | `packages/prompts` | Prompt assembly primitives exist |
| `rag` | `packages/rag` | Chunking, BM25/RRF retrieval, reranking, context building, and in-memory corpus exist |
| `resilience` | `packages/resilience` | Circuit breaker registry, retry, timeout, and model fallback primitives exist |
| `runtime-settings` | `packages/runtime-settings`, `apps/api` | Runtime settings service/store and API surface exist |
| `slack` | `packages/integrations` | Slack-compatible slash command envelope and router exist |
| `tool` | `packages/tools` | Tool registry/executor/sanitizer/approval path exists |
| `hook-integrations` | `packages/integrations` | Lifecycle webhook dispatch and HMAC signing primitives exist |
| `eval` | `packages/eval` | Eval case model, judge abstractions, runner, and summaries exist |
| `promptlab` | `packages/promptlab` | Prompt variants, experiments, runner, and ranking exist |
| `multi-agent` | `packages/multi-agent` | Supervisor, worker selection, fallback, and handoff trace primitives exist |
| `autoconfigure` | `packages/autoconfigure` | Environment-driven runtime assembly for API defaults exists |

## Partially Migrated Modules

| Reactor module | Muse target | Remaining work |
| --- | --- | --- |
| `agent` | `packages/agent-core` | ReAct loop, tool-call execution, streaming, cancellation/timeout boundaries |
| `admin` | `apps/api` | Full dashboard, alerts, tenant, cost, and SLO control surfaces beyond summary/run/scheduler operations |
| `api` | `apps/api` | Full run lifecycle routes, persisted history routes, request validation |
| `core` | `packages/shared`, `packages/agent-core` | Stable public contracts and package boundaries |
| `hook` | `packages/agent-core` | Hook registry, typed lifecycle payloads, persisted hook traces |
| `mcp` | `packages/mcp`, `apps/api` | API routes, real transport SDK integration, reconnect/health policy |
| `response` | `packages/policy`, `packages/agent-core` | Response filters, structured output normalization, source/safety post-processing |
| `scheduler` | `packages/scheduler`, `apps/api` | API routes and production cron scheduler wiring |
| `web` | `apps/api` | HTTP/SSE run endpoints and OpenAPI-ready route structure |

## Remaining Unmigrated Modules

No dedicated module remains unmigrated. The remaining work is completion depth inside partially migrated modules.

## Execution Plan

1. Complete `agent` ReAct/tool-call execution, streaming, cancellation, and timeout boundaries.
2. Complete `api`/`web` run lifecycle routes, persisted history routes, SSE, validation, and OpenAPI-ready structure.
3. Complete `mcp` real SDK transports, reconnect/health policy, and management API routes.
4. Complete `scheduler` management API routes and production cron/distributed lock wiring.
5. Expand `admin` into tenant, alert, cost, SLO, metrics, settings, and run-history operations.
6. Harden `core`, `hook`, and `response` contracts, including typed hook traces and safety/source post-processing.
7. Replace in-memory default assembly where needed with production persistence wiring through `autoconfigure`.

## Migration Rules

- Keep private names, organizations, real traces, credentials, and absolute source paths out of Muse.
- Prefer generic examples such as `user-1`, `workspace-1`, `read_file`, and `provider/model`.
- Each migration unit gets its own conventional commit.
- Run the narrow package tests first, then `pnpm check` before committing.
