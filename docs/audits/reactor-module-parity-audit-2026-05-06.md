# Reactor Module Parity Audit - 2026-05-06

This audit compares each Reactor source module under `/Users/stark/ai/reactor/modules`
against the current Muse implementation. Route parity and DB table-name parity are green,
but those checks do not prove behavior parity. This document tracks feature-level parity.

## Verification Snapshot

- `REACTOR_SOURCE_DIR=/Users/stark/ai/reactor pnpm verify:reactor-routes`: pass
  - Reactor routes: 255
  - Muse routes: 371
  - Missing Reactor routes: 0
- `REACTOR_SOURCE_DIR=/Users/stark/ai/reactor pnpm verify:reactor-db`: pass
  - Reactor DB migration files: 76
  - Muse DB migration files: 1
  - Reactor tables: 52
  - Muse tables: 64
  - Missing Reactor tables: 0
- `pnpm check`: pass
- Local caveat: current shell uses Node v22.18.0 while Muse requires Node >=24.
- Rust caveat: `cargo test` could not run because Cargo is not installed in this shell.
- Browser caveat: Playwright web smoke now covers the operator console against mocked API-backed chat, approvals, and recent runs; full live API/browser smoke still needs Node 24 environment coverage.

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
| `agent` | `packages/agent-core`, `packages/tools`, `packages/memory`, `packages/rag` | Partial | Provider-neutral run/stream loop, tool execution, fail-close guards, fail-open hooks, output filters, cache/RAG/history/resilience wiring, message-pair integrity tests, forced tool routing validation against the exposed tool set, workspace tool routing plans over exposure/dependency order, versioned/base64 checkpoint message codec, and fail-open start/complete/failure checkpoint recorder. | Cost/SLO/drift schedulers and deeper multi-agent/workspace planner parity are not fully equivalent. |
| `api` | `apps/api`, shared package contracts | Partial | Fastify chat/SSE/auth/settings/spec/history/MCP/scheduler/compat routes; route parity is 0 missing. | Reactor's large shared SPI/DTO surface is distributed across packages and route compatibility code, not fully behavior-equivalent as first-class contracts. |
| `approval` | `packages/policy`, `packages/runtime-state`, `packages/tools` | Partial | Approval policy, pending approval stores, approve/reject routes, execution gate before risky tools, rich approval context inference, reversibility/scope inference, and redacted request rendering. | Atlassian-specific context resolvers and deeper approval UX formatting remain partial. |
| `auth` | `packages/auth`, `apps/api`, `packages/db` | Partial | Password auth, JWT, revocation, admin roles, rate limiting, DB/in-memory user stores, Reactor auth aliases. | Real IAM exchange is disabled, no clear admin initializer equivalent, Fastify auth hook replaces but does not exactly mirror WebFilter semantics, identity resolver coverage is narrower. |
| `autoconfigure` | `packages/autoconfigure` | Needs runtime verification | Environment-driven assembly switches many stores to Kysely when a DB handle exists; provider selection and runtime wiring exist. | Needs full Node 24 API/DB smoke to prove production assembly, migrations, auth, scheduler, MCP, tracing, and agent runtime all start together. |
| `cache` | `packages/cache` | Partial | In-memory/no-op response cache, deterministic key builder, stats, invalidation, prompt-cache metadata helpers. | No Redis/semantic cache equivalent and no semantic retrieval implementation despite semantic metrics vocabulary. |
| `common` | `packages/shared`, `packages/policy`, `packages/memory`, `packages/observability`, `packages/tools` | Partial | Shared IDs/JSON types, redaction/sanitizer patterns, token estimation and tracing primitives are spread across Muse packages. Workspace mutation intent detection now uses Reactor's workspace+mutation+target rule with read-only/formatting exceptions. Tool output truncation now preserves JSON escape boundaries. | Remaining Reactor utilities such as boundary violation formatting, cancellation helpers, exact shared hash/HMAC helpers, and persona prompt extension semantics are not all first-class equivalents. |
| `core` | `apps/api`, `packages/autoconfigure` | Needs runtime verification | Fastify bootstrap and server injection tests replace Spring Boot application context. | Spring config is intentionally not copied; full server/API/DB smoke under Node 24 is still required. |
| `eval` | `packages/eval`, `apps/api`, `packages/runtime-state` | Partial | Eval cases, run logs, results, debug replay capture, deterministic/LLM judge paths behind `ModelProvider`, DB-backed store, retention purge, and suite-level behavior assertion coverage summary. | Reactor's full regression evaluator semantics, run-log builder enrichment, and replay lifecycle need deeper parity tests. |
| `guard` | `packages/policy`, `packages/agent-core` | Partial | Input/output guard rules, tool output sanitizer, PII/injection/prompt-leakage patterns, deterministic topic drift detection, staged input guard simulator, dynamic input and output guard rule evaluators, dynamic output rule runtime stage, provider-neutral LLM classification input guard, fail-close integration, audit persistence, canary prompt postprocessor, and guard block-rate monitor wiring in the runtime guard evaluation path. | Live classifier calibration and provider contract coverage remain partial. |
| `hook` | `packages/agent-core`, `packages/runtime-state` | Partial | Runtime lifecycle hooks, fail-open behavior, hook trace persistence. | No standalone HookExecutor/SafeRun API equivalent and fewer concrete lifecycle extension classes than Reactor. |
| `hook-integrations` | `packages/integrations`, `packages/rag`, `packages/runtime-state` | Partial | Webhook/Slack primitives, RAG stores, hook trace store, generic hook mechanism. Concrete webhook notification, tool response summary, RAG ingestion capture, feedback metadata capture, and user memory injection hooks are now migrated. | Write-tool blocking remains intentionally outside fail-open hooks and should be implemented through guards/policy. |
| `intent` | `packages/agent-specs`, `packages/promptlab`, `apps/api` | Partial | Agent spec registry, Kysely agent spec store, promptlab catalog-backed intent definitions and management routes. | Reactor `IntentResolver` style semantic classification, profile merge/apply behavior, and classifier context are not equivalent. |
| `mcp` | `packages/mcp`, `apps/api` | Partial | MCP server store, SDK stdio/SSE/streamable/http transports, security policy, health, reconnect, admin APIs, local preflight diagnostics, Reactor admin preflight fallback, and tool bridge. | Needs live server smoke; edge-case transport behavior is not fully proven. |
| `memory` | `packages/memory`, `packages/runtime-state` | Partial | Deterministic trimming, assistant/tool pair integrity, task memory with quality-gated writes, user memory, conversation summaries, Kysely stores. | LLM summary service, session embedding behavior, exact JDBC/JOOQ parity, and broader runtime memory smoke are still gaps. |
| `model-routing` | `packages/model`, `packages/autoconfigure`, `packages/resilience` | Partial | Muse-owned provider abstraction, registry, prefix routing, cost/latency-aware cross-provider selection, OpenAI-compatible/OpenAI/OpenRouter/Ollama/Anthropic/Gemini adapters, fallback policy primitives. | Spring AI chat-client provider behavior is intentionally not copied; provider contract tests are narrow and need live/contract adapter coverage. |
| `observability` | `packages/observability`, `packages/runtime-state`, `packages/db`, `apps/api` | Partial | In-memory and persisted tracer, `trace_events` sink, metrics, follow-up stats, debug replay stored via eval path, startup doctor checks, pino-compatible trace event logging, OpenTelemetry-compatible trace event sink, injected cache/MCP startup probes, Timescale-compatible trace event exporter, and tenant span processor. | Richer diagnostics and production exporter wiring need implementation or parity tests. |
| `persistence-schema` | `packages/db` | Needs runtime verification | Kysely schema and consolidated SQL migration include all Reactor table names; parity script passes. | Muse uses one consolidated migration. There is no PostgreSQL/Testcontainers upgrade-path verification equivalent to Flyway history. |
| `promptlab` | `packages/promptlab`, `apps/api` | Partial | Feedback, prompt lab experiments/trials/reports, personas/templates/intents, auto-optimize and report persistence. | Live experiment scheduler/store behavior, metrics winner/confidence semantics, and deeper experiment orchestration parity are not fully proven. |
| `prompts` | `packages/prompts`, `packages/promptlab`, `packages/agent-core` | Partial | System prompt builder, response format instructions, context/tool result blocks, cache boundary helpers, scoped prompt layer registry, persona/template/provider prompt layer resolution, and agent-core prompt layer runtime injection. | Exemplar ingestion/retrieval and broader prompt layer persistence/management remain incomplete. |
| `rag` | `packages/rag`, `apps/api` | Partial | Chunking, BM25, RRF, in-memory vector store, hybrid lexical/vector retrieval, adaptive lexical-vs-hybrid routing, parent document expansion, HyDE-style hypothetical document query transform, conversation-aware follow-up query transform, decomposition query transform, extractive context compression, retrieval eval runner for expected-document/source/token-budget assertions, simple retrieval pipeline, ingestion policy/candidate stores, document compatibility routes. | Live vector DB adapter and end-to-end RAG runtime smoke are still missing. |
| `resilience` | `packages/resilience`, `packages/agent-core` | Complete | Circuit breaker, registry, retry, timeout, no-op/model fallback, tests, agent-core wiring. | No major gap found for the Reactor module's core scope. |
| `runtime-settings` | `packages/runtime-settings`, `apps/api` | Complete | Typed settings, cache refresh/invalidation, in-memory/Kysely stores, admin compatibility routes and tests. | No major gap found for core scope. |
| `scheduler` | `packages/scheduler`, `apps/api` | Partial | Job/execution stores, cron runtime, trigger/dry-run, agent/MCP jobs, retry/timeout, distributed lock, management routes, and first-class Muse tools for scheduler list/create/trigger/dry-run actions wired into runtime assembly. | Richer notification/Teams formatting, dry-run details, and policy-pipeline breadth are partial. |
| `slack` | `packages/integrations`, `apps/api` | Partial | Signed HTTP Events API, slash commands, interactions, response URL fallback, thread replies, feedback buttons, Slack admin stores, Socket Mode envelope ack, duplicate envelope suppression, and app mention routing gateway. | Live Slack runtime/WebSocket connection needs verification; some Slack-specific session/FAQ/proactive channel behavior remains compatibility-shaped. |
| `tool` | `packages/tools`, `packages/mcp`, `crates/runner` | Partial | Tool registry, executor, approval before execution, dynamic write-tool policy enforcement before approval/execution, idempotency-key result reuse, output sanitizer, MCP tool adapter, Rust runner bridge, tool description quality gate, dependency order planner, context-aware tool exposure filtering, local execution gating, prompt relevance filtering, and repeated-call exposure governance. Workspace mutation intent detection now matches Reactor's conservative detector. A concrete tool response summary hook now captures bounded summaries and JSON item counts for completed tool calls. | Deeper live MCP/runner governance remains partial. |
| `web` | `apps/api`, `apps/web` | Partial | Fastify API/web surface and initial Vite/React/TanStack Query operator UI. Reactor-compatible security headers, request correlation, sensitive-route cache control, API version contract, configurable CORS headers/preflight handling, generated OpenAPI JSON, and Playwright operator-console smoke coverage for chat/approvals/recent runs are now implemented. | Full live API/browser smoke under Node 24 is still required. |

## Highest-Priority Gaps

1. Expand the initial Ink TUI beyond status/config display into interactive chat/auth workflows; config show/set and config-backed chat defaults now exist.
2. Install/enable Cargo in the verification environment and run `cargo test`.
3. Add Node 24 LTS full smoke: API start, DB migration, chat, SSE, CLI local/remote, web.
4. Audit `reactor-compat-routes.ts` fallback `Map` state route family by route family and eliminate remaining DB-backed gaps.
5. Implement richer diagnostics and production exporter wiring.
6. Keep write-tool blocking in guards/policy rather than fail-open hooks.
7. Continue closing large behavior gaps in `agent` and `slack` Socket Mode; RAG now has local vector/hybrid/adaptive/parent/conversation-aware retrieval plus retrieval eval assertions but still needs live vector DB verification, tool governance still needs deeper runner parity, and guard still needs live classifier calibration/provider contract coverage.
