# Muse Migration Plan

Source baseline: Reactor has 31 modules under `/modules`.

Current Muse baseline:
- Packages: 16
- Apps: 2
- Verified gate: `pnpm check`
- Local branch state at plan creation: `main` ahead of `origin/main` by 5 commits

## Current Count

| Bucket | Count | Meaning |
| --- | ---: | --- |
| Migrated foundation modules | 14 | Core concepts exist in Muse and are tested |
| Partially migrated modules | 8 | Surface exists but behavior is not complete |
| Remaining unmigrated modules | 9 | No dedicated Muse equivalent yet |
| Remaining work items | 17 | Partial completions + unmigrated modules |

## Migrated Foundation Modules

| Reactor module | Muse target | Current status |
| --- | --- | --- |
| `approval` | `packages/policy`, `packages/runtime-state` | Approval policy and pending approval stores exist |
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
| `resilience` | `packages/resilience` | Circuit breaker registry, retry, timeout, and model fallback primitives exist |
| `runtime-settings` | `packages/runtime-settings`, `apps/api` | Runtime settings service/store and API surface exist |
| `tool` | `packages/tools` | Tool registry/executor/sanitizer/approval path exists |

## Partially Migrated Modules

| Reactor module | Muse target | Remaining work |
| --- | --- | --- |
| `agent` | `packages/agent-core` | ReAct loop, tool-call execution, streaming, cancellation/timeout boundaries |
| `api` | `apps/api` | Full run lifecycle routes, persisted history routes, request validation |
| `core` | `packages/shared`, `packages/agent-core` | Stable public contracts and package boundaries |
| `hook` | `packages/agent-core` | Hook registry, typed lifecycle payloads, persisted hook traces |
| `mcp` | `packages/mcp`, `apps/api` | API routes, real transport SDK integration, reconnect/health policy |
| `response` | `packages/policy`, `packages/agent-core` | Response filters, structured output normalization, source/safety post-processing |
| `scheduler` | `packages/scheduler`, `apps/api` | API routes and production cron scheduler wiring |
| `web` | `apps/api` | HTTP/SSE run endpoints and OpenAPI-ready route structure |

## Remaining Unmigrated Modules

| Priority | Reactor module | Muse target | Migration scope |
| ---: | --- | --- | --- |
| 1 | `rag` | `packages/rag` | Document chunks, retriever interface, context injection |
| 2 | `auth` | `packages/auth`, `apps/api` | API auth boundary, user/workspace identity extraction |
| 3 | `admin` | `apps/api` | Admin routes for metrics, settings, specs, run history |
| 4 | `slack` | `packages/integrations` | External adapter pattern and Slack-compatible command envelope |
| 5 | `hook-integrations` | `packages/integrations` | Webhook/event adapters for lifecycle hooks |
| 6 | `eval` | `packages/eval` | Evaluation case model, runner, judge abstraction |
| 7 | `promptlab` | `packages/promptlab` | Prompt experiment models and lightweight runner |
| 8 | `multi-agent` | `packages/multi-agent` | Supervisor/handoff contracts over existing agent runtime |
| 9 | `autoconfigure` | `apps/api`, root config | Environment-driven assembly for production defaults |

## Execution Plan

1. Add `rag` context injection before model calls.
2. Add `auth` and expand `admin`/history APIs.
3. Complete `mcp` and `scheduler` API routes, then wire production cron and real MCP transports.
4. Complete `agent` ReAct/tool-call execution using the MCP/tool runtime.
5. Add external integrations (`slack`, `hook-integrations`) behind generic adapters.
6. Add `eval`, `promptlab`, and `multi-agent` once execution/runtime surfaces are stable.
7. Finish `autoconfigure` after production assembly choices are clear.

## Migration Rules

- Keep private names, organizations, real traces, credentials, and absolute source paths out of Muse.
- Prefer generic examples such as `user-1`, `workspace-1`, `read_file`, and `provider/model`.
- Each migration unit gets its own conventional commit.
- Run the narrow package tests first, then `pnpm check` before committing.
