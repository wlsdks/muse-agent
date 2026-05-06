# Reactor Module Parity Audit - 2026-05-06

This audit compares each Reactor source module under `/Users/stark/ai/reactor/modules`
against the current Muse implementation. Route parity and DB table-name parity are green,
but those checks do not prove behavior parity. This document tracks feature-level parity.

## Verification Snapshot

- `REACTOR_SOURCE_DIR=/Users/stark/ai/reactor pnpm verify:reactor-routes`: pass
  - Reactor routes: 255
  - Muse routes: 369
  - Missing Reactor routes: 0
- `REACTOR_SOURCE_DIR=/Users/stark/ai/reactor pnpm verify:reactor-db`: pass
  - Reactor tables: 52
  - Muse tables: 64
  - Missing Reactor tables: 0
- `pnpm check`: pass
- Local caveat: current shell uses Node v22.18.0 while Muse requires Node >=24.
- Rust caveat: `cargo test` could not run because Cargo is not installed in this shell.
- Browser caveat: Playwright web smoke test files are not present yet.

## Summary

| Status | Count | Modules |
| --- | ---: | --- |
| Complete | 2 | `runtime-settings`, `resilience` |
| Partial | 23 | `admin`, `agent`, `api`, `approval`, `auth`, `cache`, `common`, `eval`, `guard`, `hook`, `hook-integrations`, `intent`, `mcp`, `memory`, `model-routing`, `observability`, `promptlab`, `prompts`, `rag`, `scheduler`, `slack`, `tool`, `web` |
| Needs runtime verification | 3 | `autoconfigure`, `core`, `persistence-schema` |
| Missing | 0 | None at module landing-zone level |

## Module-by-Module Findings

| Reactor module | Muse target | Status | What is present | Remaining gap |
| --- | --- | --- | --- | --- |
| `admin` | `apps/api`, `packages/runtime-state`, `packages/db` | Partial | Admin routes, tenant/alert/SLO/cost/pricing/audit stores, metric ingestion, analytics/export compatibility endpoints. | Rich Reactor query services are shallower: dashboard analytics, doctor detail, quota enforcement hooks, alert evaluation scheduler, Timescale/OTLP tracing behavior need deeper parity tests or implementation. |
| `agent` | `packages/agent-core`, `packages/tools`, `packages/memory`, `packages/rag` | Partial | Provider-neutral run/stream loop, tool execution, fail-close guards, fail-open hooks, output filters, cache/RAG/history/resilience wiring, message-pair integrity tests. | Cost/SLO/drift schedulers, rich workspace planning/tool routing, checkpoint recorder/codec depth, forced tool routing validation, and multi-agent/workspace planner parity are not fully equivalent. |
| `api` | `apps/api`, shared package contracts | Partial | Fastify chat/SSE/auth/settings/spec/history/MCP/scheduler/compat routes; route parity is 0 missing. | Reactor's large shared SPI/DTO surface is distributed across packages and route compatibility code, not fully behavior-equivalent as first-class contracts. |
| `approval` | `packages/policy`, `packages/runtime-state`, `packages/tools` | Partial | Approval policy, pending approval stores, approve/reject routes, execution gate before risky tools. | Rich approval context resolvers and formatting are missing or shallow, including Atlassian context, redacted context, reversibility/scope inference, and detailed request rendering. |
| `auth` | `packages/auth`, `apps/api`, `packages/db` | Partial | Password auth, JWT, revocation, admin roles, rate limiting, DB/in-memory user stores, Reactor auth aliases. | Real IAM exchange is disabled, no clear admin initializer equivalent, Fastify auth hook replaces but does not exactly mirror WebFilter semantics, identity resolver coverage is narrower. |
| `autoconfigure` | `packages/autoconfigure` | Needs runtime verification | Environment-driven assembly switches many stores to Kysely when a DB handle exists; provider selection and runtime wiring exist. | Needs full Node 24 API/DB smoke to prove production assembly, migrations, auth, scheduler, MCP, tracing, and agent runtime all start together. |
| `cache` | `packages/cache` | Partial | In-memory/no-op response cache, deterministic key builder, stats, invalidation, prompt-cache metadata helpers. | No Redis/semantic cache equivalent and no semantic retrieval implementation despite semantic metrics vocabulary. |
| `common` | `packages/shared`, `packages/policy`, `packages/memory`, `packages/observability`, `packages/tools` | Partial | Shared IDs/JSON types, redaction/sanitizer patterns, token estimation and tracing primitives are spread across Muse packages. Workspace mutation intent detection now uses Reactor's workspace+mutation+target rule with read-only/formatting exceptions. Tool output truncation now preserves JSON escape boundaries. | Remaining Reactor utilities such as boundary violation formatting, cancellation helpers, exact shared hash/HMAC helpers, and persona prompt extension semantics are not all first-class equivalents. |
| `core` | `apps/api`, `packages/autoconfigure` | Needs runtime verification | Fastify bootstrap and server injection tests replace Spring Boot application context. | Spring config is intentionally not copied; full server/API/DB smoke under Node 24 is still required. |
| `eval` | `packages/eval`, `apps/api`, `packages/runtime-state` | Partial | Eval cases, run logs, results, debug replay capture, deterministic/LLM judge paths behind `ModelProvider`, DB-backed store. | Reactor's full regression evaluator semantics, run-log builder enrichment, retention purge, replay lifecycle, and suite-level behavior assertions need deeper parity tests. |
| `guard` | `packages/policy`, `packages/agent-core` | Partial | Input/output guard rules, tool output sanitizer, PII/injection/prompt-leakage patterns, fail-close integration, audit persistence. | LLM classification stage, simulator breadth, topic drift, canary prompt postprocessor, block-rate monitor/hook, and full dynamic output guard evaluator pipeline are missing or shallow. |
| `hook` | `packages/agent-core`, `packages/runtime-state` | Partial | Runtime lifecycle hooks, fail-open behavior, hook trace persistence. | No standalone HookExecutor/SafeRun API equivalent and fewer concrete lifecycle extension classes than Reactor. |
| `hook-integrations` | `packages/integrations`, `packages/rag`, `packages/runtime-state` | Partial | Webhook/Slack primitives, RAG stores, hook trace store, generic hook mechanism. Concrete webhook notification, tool response summary, RAG ingestion capture, feedback metadata capture, and user memory injection hooks are now migrated. | Write-tool blocking remains intentionally outside fail-open hooks and should be implemented through guards/policy. |
| `intent` | `packages/agent-specs`, `packages/promptlab`, `apps/api` | Partial | Agent spec registry, Kysely agent spec store, promptlab catalog-backed intent definitions and management routes. | Reactor `IntentResolver` style semantic classification, profile merge/apply behavior, and classifier context are not equivalent. |
| `mcp` | `packages/mcp`, `apps/api` | Partial | MCP server store, SDK stdio/SSE/streamable/http transports, security policy, health, reconnect, admin APIs, tool bridge. | Needs live server smoke; Reactor diagnostic live health/preflight depth and edge-case transport behavior are not fully proven. |
| `memory` | `packages/memory`, `packages/runtime-state` | Partial | Deterministic trimming, assistant/tool pair integrity, task memory, user memory, conversation summaries, Kysely stores. | LLM summary service, task memory quality gate, session embedding behavior, exact JDBC/JOOQ parity, and broader runtime memory smoke are still gaps. |
| `model-routing` | `packages/model`, `packages/autoconfigure`, `packages/resilience` | Partial | Muse-owned provider abstraction, registry, prefix routing, OpenAI-compatible/OpenAI/OpenRouter/Ollama/Anthropic/Gemini adapters, fallback policy primitives. | Reactor cost-aware model routing and Spring AI chat-client provider behavior are not fully equivalent. Provider contract tests are narrow and need live/contract adapter coverage. |
| `observability` | `packages/observability`, `packages/runtime-state`, `packages/db`, `apps/api` | Partial | In-memory and persisted tracer, `trace_events` sink, metrics, follow-up stats, debug replay stored via eval path, startup doctor checks, and pino-compatible trace event logging. | Native OpenTelemetry SDK export, MCP live health probe, cache doctor, Timescale exporter, tenant span processor, and richer diagnostics need implementation or parity tests. |
| `persistence-schema` | `packages/db` | Needs runtime verification | Kysely schema and consolidated SQL migration include all Reactor table names; parity script passes. | Muse uses one consolidated migration. There is no PostgreSQL/Testcontainers upgrade-path verification equivalent to Flyway history. |
| `promptlab` | `packages/promptlab`, `apps/api` | Partial | Feedback, prompt lab experiments/trials/reports, personas/templates/intents, auto-optimize and report persistence. | Live experiment scheduler/store behavior, metrics winner/confidence semantics, and deeper experiment orchestration parity are not fully proven. |
| `prompts` | `packages/prompts`, `packages/promptlab`, `packages/agent-core` | Partial | System prompt builder, response format instructions, context/tool result blocks, cache boundary helpers. | Persona/template prompt layering, exemplar ingestion/retrieval, provider-specific prompt contributions, and prompt layer registry are incomplete. |
| `rag` | `packages/rag`, `apps/api` | Partial | Chunking, BM25, RRF, simple retrieval pipeline, ingestion policy/candidate stores, document compatibility routes. | Vector store, hybrid retrieval, adaptive router, HyDE/decomposition/conversation-aware transforms, contextual compression, parent document retriever, and retrieval eval suite are missing. |
| `resilience` | `packages/resilience`, `packages/agent-core` | Complete | Circuit breaker, registry, retry, timeout, no-op/model fallback, tests, agent-core wiring. | No major gap found for the Reactor module's core scope. |
| `runtime-settings` | `packages/runtime-settings`, `apps/api` | Complete | Typed settings, cache refresh/invalidation, in-memory/Kysely stores, admin compatibility routes and tests. | No major gap found for core scope. |
| `scheduler` | `packages/scheduler`, `apps/api` | Partial | Job/execution stores, cron runtime, trigger/dry-run, agent/MCP jobs, retry/timeout, distributed lock, management routes. | Reactor scheduler tools as first-class tools, richer notification/Teams formatting, dry-run details, and policy-pipeline breadth are partial. |
| `slack` | `packages/integrations`, `apps/api` | Partial | Signed HTTP Events API, slash commands, interactions, response URL fallback, thread replies, feedback buttons, Slack admin stores. | Socket Mode gateway is not migrated; thread tracker behavior and live Slack runtime need verification; some Slack-specific session/FAQ/proactive channel behavior remains compatibility-shaped. |
| `tool` | `packages/tools`, `packages/mcp`, `crates/runner` | Partial | Tool registry, executor, approval before execution, output sanitizer, MCP tool adapter, Rust runner bridge. Workspace mutation intent detection now matches Reactor's conservative detector. A concrete tool response summary hook now captures bounded summaries and JSON item counts for completed tool calls. | Context-aware/local filtering, tool description enrichment/quality gate, loop/relevance governance, idempotency guards, dependency graph, and dynamic policy engine parity are missing or shallow. |
| `web` | `apps/api`, `apps/web` | Partial | Fastify API/web surface and initial Vite/React/TanStack Query operator UI. Reactor-compatible security headers, request correlation, sensitive-route cache control, API version contract, configurable CORS headers/preflight handling, and generated OpenAPI JSON are now implemented on the API server. | Playwright smoke tests are still missing. |

## Highest-Priority Gaps

1. Add Playwright smoke tests for `apps/web` and API-backed chat/approvals/recent runs.
2. Expand the initial Ink TUI beyond status/config display into interactive chat/auth workflows; config show/set and config-backed chat defaults now exist.
3. Install/enable Cargo in the verification environment and run `cargo test`.
4. Add Node 24 LTS full smoke: API start, DB migration, chat, SSE, CLI local/remote, web.
5. Audit `reactor-compat-routes.ts` fallback `Map` state route family by route family and eliminate remaining DB-backed gaps.
6. Implement native OpenTelemetry SDK export, MCP live health probe, cache doctor, Timescale exporter, tenant span processor, and richer diagnostics.
7. Keep write-tool blocking in guards/policy rather than fail-open hooks.
8. Close large behavior gaps in `rag`, `tool`, `guard`, `agent`, and `slack` Socket Mode.
