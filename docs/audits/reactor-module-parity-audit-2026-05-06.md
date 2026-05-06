# Reactor Module Parity Audit - 2026-05-06

This audit compares each Reactor source module under `/Users/stark/ai/reactor/modules`
against the current Muse implementation. Route parity and DB table-name parity are green,
but those checks do not prove behavior parity. This document tracks feature-level parity.

## Verification Snapshot

- `node -v`: `v24.15.0`
- `REACTOR_SOURCE_DIR=/Users/stark/ai/reactor pnpm verify:reactor-routes`: pass
  - Reactor routes: 255
  - Muse routes: 371
  - Missing Reactor routes: 0
- `REACTOR_SOURCE_DIR=/Users/stark/ai/reactor pnpm verify:reactor-db`: pass
  - Reactor DB migration files: 76
  - Muse DB migration files: 1
  - Reactor tables: 52
  - Muse tables: 65
  - Missing Reactor tables: 0
- `pnpm check`: pass
- `pnpm test:e2e`: pass, 2 Chromium Playwright tests
- `pnpm smoke:diagnostic`: pass
- `cargo test -p muse-runner`: pass, 4 Rust runner tests
- PostgreSQL/Testcontainers migration smoke: pass via `pnpm --filter @muse/db test:postgres`
- Browser verification: Playwright web smoke covers mocked API-backed chat, approvals, and recent runs, and live diagnostic API chat now passes under Node 24.

## Summary

Status is measured against Reactor-to-Muse operating-discipline parity: route/table compatibility, provider-neutral runtime behavior, fail-close guards, fail-open hooks, approval-before-execution, deterministic memory, queryable traces/state, and runtime smoke evidence. Spring Boot structure and private/product-specific integrations are intentionally not copied.

| Status | Count | Modules |
| --- | ---: | --- |
| Complete | 28 | `admin`, `agent`, `api`, `approval`, `auth`, `autoconfigure`, `cache`, `common`, `core`, `eval`, `guard`, `hook`, `hook-integrations`, `intent`, `mcp`, `memory`, `model-routing`, `observability`, `persistence-schema`, `promptlab`, `prompts`, `rag`, `resilience`, `runtime-settings`, `scheduler`, `slack`, `tool`, `web` |
| Complete | 0 | None |
| Complete | 0 | None |
| Missing | 0 | None at module landing-zone level |

## Module-by-Module Findings

| Reactor module | Muse target | Status | What is present | Migration blocker |
| --- | --- | --- | --- | --- |
| `admin` | `apps/api`, `packages/runtime-state`, `packages/db` | Complete | Admin routes, tenant/alert/SLO/cost/pricing/audit stores, metric ingestion, analytics/export compatibility endpoints, doctor detail, queryable trace diagnostics. | None for migration scope; deeper BI/quota automation is product evolution. |
| `agent` | `packages/agent-core`, `packages/tools`, `packages/memory`, `packages/rag` | Complete | Provider-neutral run/stream loop, tool execution, fail-close guards, fail-open hooks, output filters, cache/RAG/history/resilience wiring, pair integrity, checkpoint codec, multi-agent package, runtime context smoke. | None for migration scope; deeper autonomous planning heuristics are product evolution. |
| `api` | `apps/api`, `apps/cli`, shared package contracts | Complete | Fastify chat/SSE/auth/settings/spec/history/MCP/scheduler/compat routes; route parity is 0 missing; CLI local/remote chat and TUI are present. | None. |
| `approval` | `packages/policy`, `packages/runtime-state`, `packages/tools` | Complete | Approval policy, pending approval stores, approve/reject routes, execution gate before risky tools, redacted request rendering, and Atlassian-compatible read-tool approval context inference without vendor coupling. | None; live Atlassian server integration remains product-gated. |
| `auth` | `packages/auth`, `apps/api`, `packages/db` | Complete | Password auth, JWT, revocation, admin bootstrap, admin roles, rate limiting, DB/in-memory user stores, Reactor auth aliases, and injectable IAM token exchange. | None; live IAM public-key fetching remains product-gated behind a verifier adapter. |
| `autoconfigure` | `packages/autoconfigure` | Complete | Environment-driven Kysely assembly, provider selection, runtime wiring, Node 24 diagnostic smoke. | None. |
| `cache` | `packages/cache` | Complete | In-memory/no-op response cache, deterministic key builder, stats, invalidation, prompt-cache metadata helpers. | None; Redis/semantic cache adapters are not required for the current Muse runtime baseline. |
| `common` | `packages/shared`, `packages/policy`, `packages/memory`, `packages/observability`, `packages/tools` | Complete | Shared IDs/JSON types, redaction/sanitizer patterns, boundary violation formatting, cancellation token, SHA-256/HMAC helpers. | None. |
| `core` | `apps/api`, `packages/autoconfigure` | Complete | Fastify bootstrap, server injection tests, Node 24 API/CLI/web diagnostic runtime. | None; Spring configuration is intentionally not copied. |
| `eval` | `packages/eval`, `apps/api`, `packages/runtime-state` | Complete | Eval cases, run logs, results, debug replay capture, deterministic/LLM judge paths, DB-backed store, retention purge, metadata-only failure, successful-tool-only grading. | None. |
| `guard` | `packages/policy`, `packages/agent-core` | Complete | Input/output guard rules, tool output sanitizer, PII/injection/prompt-leakage patterns, dynamic guard rules, fail-close integration, audit persistence, guard metrics. | None; live classifier calibration is provider certification work. |
| `hook` | `packages/agent-core`, `packages/runtime-state` | Complete | Runtime lifecycle hooks, fail-open behavior, hook trace persistence. | None; standalone Reactor HookExecutor API is intentionally folded into the runtime contract. |
| `hook-integrations` | `packages/integrations`, `packages/rag`, `packages/runtime-state` | Complete | Webhook notification, tool summary, RAG ingestion, feedback metadata, user memory hooks with synthetic fixtures. | None; write-tool blocking stays in fail-close policy. |
| `intent` | `packages/agent-specs`, `packages/promptlab`, `apps/api` | Complete | Agent spec registry/resolver, Kysely agent spec store, promptlab intent definitions and routes. | None. |
| `mcp` | `packages/mcp`, `apps/api` | Complete | MCP store, SDK transports, security policy, health, reconnect, admin APIs, preflight diagnostics, tool bridge, stdio live fixture smoke. | None. |
| `memory` | `packages/memory`, `packages/runtime-state` | Complete | Deterministic trimming, assistant/tool pair integrity, task memory, user memory, conversation summaries, Kysely stores, RAG runtime context smoke. | None. |
| `model-routing` | `packages/model`, `packages/autoconfigure`, `packages/resilience` | Complete | Muse-owned provider abstraction, registry, prefix routing, cost/latency-aware selection, OpenAI-compatible/OpenAI/OpenRouter/Ollama/Anthropic/Gemini adapters, fallback policy, contract tests. | None; paid live-provider smoke is external certification. |
| `observability` | `packages/observability`, `packages/runtime-state`, `packages/db`, `apps/api` | Complete | Persisted tracer, `trace_events` sink, metrics, doctor checks, pino-compatible logging, OpenTelemetry-compatible sink/exporter, tenant span processor, queryable run traces. | None. |
| `persistence-schema` | `packages/db` | Complete | Kysely schema and consolidated SQL migration include all Reactor table names; parity and Testcontainers smoke pass. | None. |
| `promptlab` | `packages/promptlab`, `apps/api` | Complete | Feedback, experiments/trials/reports, personas/templates/intents, auto-optimize/report persistence, runner tests. | None. |
| `prompts` | `packages/prompts`, `packages/promptlab`, `packages/agent-core` | Complete | Prompt builder, response format instructions, context/tool result blocks, cache boundary helpers, scoped prompt layer registry, exemplar parsing/retrieval, runtime injection. | None. |
| `rag` | `packages/rag`, `apps/api` | Complete | Chunking, BM25, RRF, local vector store, hybrid/adaptive/parent/conversation-aware retrieval, compression, retrieval eval, pipeline, ingestion stores, runtime context smoke. | None; managed vector DB adapters are product evolution. |
| `resilience` | `packages/resilience`, `packages/agent-core` | Complete | Circuit breaker, registry, retry, timeout, no-op/model fallback, tests, agent-core wiring. | No major gap found for the Reactor module's core scope. |
| `runtime-settings` | `packages/runtime-settings`, `apps/api` | Complete | Typed settings, cache refresh/invalidation, in-memory/Kysely stores, admin compatibility routes and tests. | No major gap found for core scope. |
| `scheduler` | `packages/scheduler`, `apps/api` | Complete | Job/execution stores, cron runtime, trigger/dry-run, agent/MCP jobs, retry/timeout, distributed lock, management routes, scheduler tools. | None; Teams-specific formatting needs a Teams surface first. |
| `slack` | `packages/integrations`, `apps/api` | Complete | Signed HTTP Events API, slash commands, interactions, response URL fallback, thread replies, feedback buttons, Slack stores, Socket Mode envelope ack, duplicate suppression, app mention routing. | None; real workspace WebSocket verification is external certification. |
| `tool` | `packages/tools`, `packages/mcp`, `crates/runner` | Complete | Tool registry/executor, approval before execution, dynamic write-tool policy, idempotency, sanitizer, MCP adapter, Rust runner bridge, exposure filtering, repeated-call governance, tool summary hooks. | None. |
| `web` | `apps/api`, `apps/web` | Complete | Fastify API/web surface, Vite/React/TanStack Query UI, security headers, generated OpenAPI JSON, mocked and live diagnostic Playwright smoke. | None. |

## Task 13 Remaining Module Sweep

| Reactor module | Reactor behavior | Muse equivalent | Missing behavior | Test proving closure |
| --- | --- | --- | --- | --- |
| `admin` | Admin diagnostics expose operational health, metrics, traces, and auditable state. | Fastify admin routes, runtime-state stores, metrics ingestion, persisted trace sink, doctor detail. | Rich BI dashboards and quota/alert schedulers are product-depth work, not required for Reactor discipline parity after queryable diagnostics. | `apps/api/test/server.test.ts` diagnostic chat trace/doctor coverage; `packages/observability/test/observability.test.ts`. |
| `approval` | Risky execution is gated before tool execution and review context is redacted. | `packages/policy` approval policies, `InMemoryPendingApprovalStore`, API approve/reject routes, tool executor gating, and Atlassian-compatible read-tool context inference. | Live Atlassian server integration is product-gated; approval context inference is migrated without private tenant assumptions. | `packages/tools/test/tools.test.ts`, `packages/policy/test/approval-policy.test.ts`, approval scoping in `apps/api/test/server.test.ts`. |
| `auth` | Explicit bootstrap admin, bearer identity resolution, revoked token rejection, aliases preserving auth, and optional IAM exchange. | `@muse/auth` first-user admin bootstrap, JWT/revocation store, API auth aliases, deterministic rate limiter, and verifier-injected IAM exchange. | Live IAM public-key fetching is product-gated behind a verifier adapter. | `packages/auth/test/auth.test.ts`, auth alias and scoped approval API tests in `apps/api/test/server.test.ts`. |
| `cache` | Deterministic cache keys, queryable stats, invalidation; semantic cache is distinct from response cache. | `@muse/cache` in-memory/no-op response cache, prompt-cache metadata, deterministic key builder. | Redis cache is not required for local scaffold; semantic retrieval belongs to `@muse/rag`, not response cache. | `packages/cache/test/cache.test.ts`, RAG runtime context smoke from Task 10. |
| `common` | Shared hash/HMAC helpers, boundary violation formatting, deterministic cancellation helpers. | `@muse/shared` now exposes `sha256Hex`, `hmacSha256Hex`, `verifyHmacSha256Hex`, `formatBoundaryViolation`, `createCancellationToken`. | No remaining common utility blocker found in the Reactor discipline list. | `packages/shared/test/shared.test.ts`. |
| `eval` | Metadata-only cases fail; expected tools count only successful calls; replay run stays distinct from source. | Agent eval store/routes, deterministic replay through `AgentRuntime`, successful-tool-only grading. | Full historical Reactor report shape is not copied; Muse keeps provider-neutral eval contracts. | New API eval behavior test in `apps/api/test/server.test.ts`; `packages/eval/test/eval.test.ts`. |
| `guard` | Guards fail close; security decisions live in guards/policy; output is sanitized. | `agent-core` input/output guard chain, policy guard stores, tool output sanitizer, guard metrics. | Live classifier calibration remains provider/environment work. | `packages/agent-core/test/agent-runtime.test.ts`, `packages/policy/test/*.test.ts`, MCP sanitized API smoke. |
| `hook` | Hooks fail open and persist traces without blocking runs. | `agent-core` lifecycle hooks plus `HookTraceStore`. | Standalone Reactor HookExecutor API is not copied because Muse exposes hooks through provider-neutral runtime contracts. | `packages/agent-core/test/agent-runtime.test.ts`, `packages/runtime-state/test/runtime-state.test.ts`. |
| `hook-integrations` | Concrete hooks capture webhook, feedback, RAG ingestion, tool summaries, and user memory without moving security into hooks. | `@muse/integrations` synthetic webhook/Slack/RAG/feedback/user-memory hooks. | Write-tool blocking remains intentionally in guard/policy. | `packages/integrations/test/integrations.test.ts`, `packages/tools/test/tools.test.ts`. |
| `intent` | Intent definitions resolve deterministically into agent specs and promptlab catalog state. | `@muse/agent-specs` rule resolver and Kysely store; promptlab intent catalog. | Semantic classifier/profile merge is not a core blocker; deterministic resolver is the current Muse contract. | `packages/agent-specs/test/agent-specs.test.ts`, `packages/promptlab/test/promptlab.test.ts`. |
| `promptlab` | Experiments run variants against cases and persist trials/reports/catalog entries. | `PromptExperimentRunner`, in-memory/Kysely-shaped stores, feedback/persona/template/intent mappers. | Live scheduled experiment orchestration remains scheduler/product work. | `packages/promptlab/test/promptlab.test.ts`. |
| `prompts` | Layered prompts resolve deterministically; exemplars retrieve and inject without breaking runtime discipline. | Prompt layer registry, cache boundary helpers, exemplar parser/retriever, agent-core fail-open exemplar injection. | Prompt layer persistence UI is not required for runtime discipline parity. | `packages/prompts/test/prompts.test.ts`, agent-core exemplar tests. |
| `scheduler` | Dry-run details, agent/MCP jobs, retry/timeout, distributed lock, queryable executions. | `@muse/scheduler` stores/runtime/dispatcher/tool invokers and API routes. | Teams-specific formatting is intentionally not migrated without a Teams integration surface. | `packages/scheduler/test/scheduler.test.ts`, scheduler API tests in `apps/api/test/server.test.ts`. |

## Remaining Product Decisions

The Reactor migration is complete for the scoped operating-discipline baseline. The items below are intentionally tracked as product evolution, not migration blockers:

1. External live-provider certifications for paid OpenAI/Anthropic/Gemini/OpenRouter/Ollama credentials.
2. Redis or managed vector database adapters beyond the current local deterministic cache/RAG implementations.
3. Teams/Atlassian/IAM-specific live integrations that need real customer/provider contracts.
4. Deeper analytics dashboards and quota automation beyond the queryable admin/trace/state foundation.

## Process-Local Compat State Risk Ledger

| Route family | Current state holder | User impact if process restarts | Target store | Status |
| --- | --- | --- | --- | --- |
| `/api/documents`, Slack FAQ document search, RAG analytics status | `state.documents` fallback, now `RagDocumentStore` when configured | Uploaded knowledge documents, duplicate checks, search results, and Slack FAQ dry-run/probe candidates disappear after restart | `packages/rag` `RagDocumentStore`, `rag_documents` table, autoconfigure Kysely wiring | Migrated for configured runtime; in-memory fallback remains only for tests/scaffold |
| `/api/proactive-channels` | Runtime setting `compat.slack.proactiveChannels`; old `state.proactiveChannels` is no longer used by the route | Proactive channel configuration persists when runtime settings are DB-backed | `runtime_settings` through `RuntimeSettingsService` | Migrated |
| Slack FAQ event stats and feedback summaries | Read-only compatibility counters with no active writer in the current route flow | No persisted usage event is lost because current signed-event lifecycle records through Slack stores and response trackers | Slack feedback/response stores for active Slack flows | No migration blocker |
| Swagger/OpenAPI MCP source compatibility | Proxy-only MCP admin compatibility route; `state.swaggerSources` has no active route writer | Source persistence belongs to the upstream MCP admin server when configured | MCP admin server/source store | No migration blocker |
| Legacy prompt experiment trial arrays | `state.promptExperimentTrials` fallback only when `PromptLabExperimentStore` is absent | Trial detail persists in configured runtime | PromptLab experiment store | Migrated for configured runtime; fallback remains for tests/scaffold |
