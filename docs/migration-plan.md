# Muse Migration Plan

Source baseline: Reactor has 31 Gradle modules under `/modules` plus the root `app` bootstrap project.

Current Muse baseline:
- Packages: 23
- Apps: 2
- Verified gate: `pnpm check`
- Branch state: verify with `git status -sb` before pushing or merging

## Current Count

| Bucket | Count | Meaning |
| --- | ---: | --- |
| Reactor source modules with Muse landing zones | 31 | Every `modules/*` source module has a package or API target |
| Reactor included projects with Muse landing zones | 32 | `app` plus all 31 source modules are mapped |
| Cross-cutting compatibility areas | 4 | Context, response filtering, hooks, and multi-agent behavior are tracked as capabilities, not Reactor source modules |
| HTTP route parity | 255 / 255 | Every Reactor controller route under `app` and `modules` is registered in Muse |
| Functionally exercised source modules | 31 | Core behavior exists and is covered by package/API tests |
| Deep-hardening areas still open | 3 | Remaining work is capability-level parity, not missing module landing zones |
| Remaining unmapped modules | 0 | No source module is without a target |

## Completed Migration Areas

| Reactor module | Muse target | Current status |
| --- | --- | --- |
| `app` | `apps/api` | Runtime bootstrap, environment assembly, Fastify server entrypoint |
| `agent` | `packages/agent-core` | ReAct loop, tool execution, streaming, guards, hooks, cache, RAG, history |
| `api` | `apps/api` | Chat, SSE chat, auth, settings, agent specs, history, MCP, scheduler, quality routes |
| `admin` | `apps/api`, `packages/runtime-state`, `packages/db` | Metrics, cache, alert, cost, SLO, tenant ops |
| `approval` | `packages/policy`, `packages/runtime-state` | Approval policies and pending approval stores exist |
| `auth` | `packages/auth`, `apps/api` | JWT auth, password hashing, user store, revocation, guard, rate limiting |
| `autoconfigure` | `packages/autoconfigure` | Environment-driven runtime assembly and DB-backed store selection exist |
| `cache` | `packages/cache` | Response cache, scope fingerprint, TTL invalidation, prompt-cache metadata, stats |
| `common` | `packages/shared` | Shared IDs, JSON, and common value types exist |
| `core` | `apps/api`, `packages/autoconfigure` | Fastify bootstrap and runtime assembly replace Spring Boot core |
| `eval` | `packages/eval`, `apps/api` | Eval case model, judges, runner, summaries, and admin API exist |
| `guard` | `packages/policy`, `packages/agent-core` | Input/output guards and fail-close runtime integration exist |
| `hook` | `packages/agent-core`, `packages/runtime-state` | Registry callbacks, tool lifecycle hooks, and hook trace stores exist |
| `hook-integrations` | `packages/integrations` | Lifecycle webhook dispatch and HMAC signing primitives exist |
| `intent` | `packages/agent-specs` | Agent specs, resolver, registry, and Kysely mapping exist |
| `memory` | `packages/memory`, `packages/runtime-state` | Context trimming, compaction summaries, checkpoints, run history, and stores exist |
| `mcp` | `packages/mcp`, `apps/api` | SDK transports, health checks, reconnect, and management APIs exist |
| `model-routing` | `packages/model` | Provider registry, prefix routing, and OpenAI-compatible provider exist |
| `observability` | `packages/observability`, `packages/runtime-state` | Tracing, metrics, and history stores exist |
| `persistence-schema` | `packages/db` | Kysely schema covers runtime, scheduler, MCP, and admin state |
| `promptlab` | `packages/promptlab`, `apps/api` | Prompt variants, experiments, runner, ranking, and admin API exist |
| `prompts` | `packages/prompts` | Prompt assembly, response format instructions, and cache boundary helpers exist |
| `rag` | `packages/rag` | Chunking, BM25/RRF retrieval, reranking, context building, and in-memory corpus exist |
| `resilience` | `packages/resilience` | Circuit breaker registry, retry, timeout, and model fallback primitives exist |
| `runtime-settings` | `packages/runtime-settings`, `apps/api` | Runtime settings service/store and API surface exist |
| `scheduler` | `packages/scheduler`, `apps/api` | CRUD, execution records, cron, and scheduler locks exist |
| `slack` | `packages/integrations`, `apps/api` | Signed Events API, slash command, response_url integration, and Slack mrkdwn response formatting exist |
| `tool` | `packages/tools` | Tool registry, executor, sanitizer, and approval path exist |
| `web` | `apps/api` | HTTP/SSE run endpoints and typed error surfaces exist |

## Cross-Cutting Compatibility Areas

These are not Reactor Gradle modules, but they are kept as explicit migration checks because they affect parity across
multiple source modules.

| Area | Muse target | Current status |
| --- | --- | --- |
| Context handling | `packages/memory`, `packages/agent-core` | Context trimming, pinned-entity compaction summaries, and assistant/tool message-pair handling exist |
| Response filtering | `packages/policy`, `packages/agent-core` | Output guards, verified-source rendering, source/structured filters, markdown/sanitized-text cleanup, greeting/lure stripping, fabrication refusal, policy-prior warning, max-length truncation, Slack ID masking, internal brand masking, tool-result quality audit, response-count injection/consistency, zero-result overclaim cleanup, and release-risk data-gap cleanup exist |
| Hook lifecycle | `packages/agent-core`, `packages/runtime-state`, `packages/integrations` | Agent/tool hook callbacks, trace persistence, and webhook signing exist |
| Multi-agent orchestration | `packages/multi-agent` | Supervisor, worker selection, fallback, and handoff trace primitives exist |

## Remaining Deep-Hardening Areas

No known source module remains unmapped.
The remaining checks are cross-module behavior parity checks that should be closed before calling the migration
fully done:

1. Response filters: compare Reactor's verified-source extractor edge cases against Muse extraction
   (nested URL fields, synthesized source directories, and source relevance filtering still need broader parity tests).
2. Slack behavior: verify Events API callbacks, slash-command fallback behavior, and response URL delivery together.
3. Hook/context behavior: verify message-pair integrity under broader runtime smoke tests.

Latest route parity check: `REACTOR_SOURCE_DIR=<local-reactor-path> pnpm verify:reactor-routes` reports 255 Reactor
routes, 365 Muse routes, and 0 missing Reactor routes.

## Recent Completion Notes

- MCP now uses real SDK transports for stdio, SSE, and streamable HTTP.
- Slack signed slash commands and URL verification are wired through API routes.
- Admin APIs cover metrics, cache invalidation, and circuit breaker reset operations.
- Scheduler has management routes plus a Node cron runtime.
- OpenAI-compatible streaming preserves streamed tool-call deltas, while `/api/chat/stream` emits Reactor-style
  `tool_start`, `tool_end`, and empty `done` SSE events.
- `AgentRuntime.stream()` now executes streamed tool calls through the ReAct loop.
- API chat parsing now preserves assistant `toolCalls`, keeping message pairs intact.
- Response filtering strips copied trailing source blocks and buffers text when filters or output guards are active.
- Hook registry execution now records completed/failed hook traces in runtime state.
- Structured output filtering normalizes JSON/YAML responses when requested by run metadata.
- MCP health checks now mark unhealthy connections and reconnect due servers with backoff.
- Scheduler now has in-memory and Kysely-backed distributed lock implementations.
- Admin operations now include tenant, alert acknowledgement, cost summary, and SLO state APIs.
- Runtime assembly now switches to Kysely-backed stores when a database handle is provided.
- Reactor API compatibility routes now cover legacy auth, sessions, approvals, guard/rule, RAG, prompt-lab,
  Slack admin, MCP policy/catalog, and admin operations aliases.
- HITL pending approvals are wired into API runtime assembly and tool execution can wait for human approval
  when an approval policy is configured.
- `/api/chat/multipart` accepts Reactor-compatible multipart uploads and forwards file metadata to AgentRuntime.
- Reactor-compatible password change, session deletion, admin session tags, trace/tool-call analytics,
  user/model usage, token-cost summaries, and metric ingestion now use Muse runtime state instead of stubs.
- Reactor-compatible agent eval promotion/replay/results, platform alert rules, model pricing,
  vector-store stats, and admin tool stats now use Muse runtime state.
- Reactor-compatible admin analytics/export/debug routes now cover eval dashboards, latency, RAG,
  Slack activity, tenant quality/tools/quota CSV exports, audit CSV export, and task-memory maintenance.
- Reactor-compatible policy RAG seed now ingests seed entries into the Muse document state with chunk counts.
- The broad `/api/admin/*` compatibility fallback was removed so unmapped admin routes fail with 404 instead of
  pretending to be migrated.
- Slack FAQ admin compatibility now matches Reactor response envelopes for registration lists, stats, events,
  feedback snapshots, and channel deletion.
- Input Guard audit compatibility now records settings/simulate operations and returns the Reactor `{ audits, total }`
  envelope instead of a static empty response.
- Input Guard stats compatibility now returns the Reactor `GuardStatsResponse` shape and aggregates recorded
  `guard_rejection` metrics when present.
- Agent eval LLM judge compatibility now calls the configured Muse model provider when `llmJudge=true` instead of
  always storing an unavailable judge result.
- Agent eval replay compatibility now invokes the configured Muse agent runtime for a fresh replay run instead of
  re-evaluating the promoted source run.
- Task Memory maintenance compatibility now uses a real Muse task memory store and Reactor-style unavailable errors
  instead of static zero-delete responses.
- Follow-up suggestion stats compatibility now aggregates impression/click/CTR data through a Muse observability
  store instead of returning a hard-coded zero snapshot.
- Slack webhook compatibility now keeps `/api/slack/events` and `/api/slack/commands` registered when Slack is not
  enabled, returning 503 for socket-mode-style disabled POSTs and 405 for probe GETs.
- Scheduler compatibility now matches Reactor's disabled-service stub: empty list/read-history responses stay 200,
  while write and execution operations return 503.
- MCP server and security policy responses now use Reactor-compatible enum casing, epoch-millis timestamps,
  tool-name lists, and `{ effective, stored, configDefault }` policy envelopes.
- Scheduler job and execution responses now use Reactor-compatible enum casing, epoch-millis timestamps,
  result previews/failure reasons, and `204 No Content` deletes.
- Prompt Lab experiment compatibility now returns Reactor-style `201` creates, uppercase statuses, epoch-millis
  timestamps, status envelopes, `202` run acknowledgements, and `204` deletes.
- Prompt Template compatibility now returns Reactor-style template/version DTOs, uppercase version statuses,
  epoch-millis timestamps, `201` version creates, active-version detail payloads, and `204` deletes.
- Persona and Intent compatibility now match Reactor management semantics for admin-gated lists/writes,
  epoch-millis DTOs, `activeOnly` filtering, duplicate-intent `409`, and idempotent `204` deletes.
- Input and Output Guard rule compatibility now matches Reactor list envelopes, action casing, timestamp formats,
  validation failures, output-rule audits/simulation payloads, and delete response semantics.
- Document compatibility now matches Reactor `DocumentResponse`, `BatchDocumentResponse`, `SearchResultResponse`,
  admin-gated search/list/write operations, and body-based `204` deletes.
- Feedback compatibility now matches Reactor `FeedbackResponse`, cursor-page list envelopes, review `If-Match`
  version checks, stats/export envelopes, bulk updates, and `204` deletes.
- Slack bot compatibility now matches Reactor admin-gated bot CRUD, duplicate-name `409`, masked token response
  fields, ISO timestamps, partial updates, and `204` deletes.
- Tool Policy compatibility now matches Reactor state envelopes with `effective`/`stored`, epoch-millis policy DTOs,
  channel-specific write allowlists, and delete-to-config-default `204` semantics.
- Session, Agent Spec, RBAC, Retention, Input Guard pipeline/settings, Runtime Settings, Admin Capabilities,
  Ops Dashboard, and RAG Ingestion Policy compatibility now match Reactor response DTOs and delete/reset semantics
  instead of Muse-specific convenience envelopes.
- MCP preflight and access-policy compatibility now requires registered MCP servers and proxies the Reactor-style
  admin API endpoints (`/admin/preflight`, `/admin/access-policy`) instead of returning static OK stubs.
- Ops Dashboard compatibility now enforces admin authorization and derives MCP, scheduler, response-trust, recent
  trust event, and employee-value summaries from Muse runtime state instead of fixed empty snapshots.
- Platform Alert compatibility now lists only active/open alerts, records Reactor-style admin audits, returns
  `status: "evaluation complete"` for evaluation, and resolves alerts idempotently with an empty `200` response.
- Prompt Lab experiment run compatibility now persists trial responses and reports, completes run state, and cascades
  trial/report cleanup on experiment delete instead of returning static empty trial/report data; recommended-version
  activation now applies the report recommendation to the linked prompt template version, and feedback analysis now
  derives totals, negative samples, and weakness categories from stored feedback. Auto-optimize now creates candidate
  prompt versions plus a completed auto-generated experiment when enough negative feedback exists.
- Admin capabilities compatibility now derives `/api/` paths from Fastify's registered runtime routes, preserving
  Spring-style `{param}` path templates and excluding non-API paths.
- A2A agent-card compatibility now returns Reactor's `AgentCard` contract with version, description, supported
  input/output formats, and list-based capabilities derived from enabled agent specs and their tools.
- `/api/auth/*` aliases now return Reactor-style `AuthResponse`/`UserResponse` payloads, preserve disabled IAM
  exchange semantics, and keep self-registration users at `USER` scope.
- `/api/sessions` compatibility now ignores spoofed `userId` query parameters and enforces Reactor-style
  authenticated-owner checks before deleting sessions.
- `/api/chat` and `/api/chat/multipart` now return Reactor `ChatResponse` contracts, while `/chat` keeps the
  extended Muse run metadata envelope.
- Reactor-compatible auth/admin/session/scheduler/feedback failures now use the standard `{ error, timestamp }`
  response shape instead of Muse-specific `{ code, message }` envelopes where Reactor uses `ErrorResponse`.
- `/api/sessions` now denies ownerless sessions by default, supports `format=md` exports, and emits Reactor-style
  unauthorized/session-forbidden messages.
- Response filter compatibility now includes Reactor-style max-length truncation, raw Slack user ID conversion to
  mention form, and internal implementation brand masking in the default runtime assembly.
- Response filter compatibility now also includes sanitized marker cleanup, markdown normalization, repeated greeting
  removal, explicit fabrication-request refusal, zero-result overclaim cleanup, and release-risk data-gap cleanup.
- Policy strong-prior warning compatibility now appends a Confluence verification warning when policy answers rely on
  generic legal/company-practice priors without a Confluence tool call.
- Casual lure stripping now removes generic follow-up/work-suggestion endings from short no-tool responses while
  preserving work-tool responses.
- Response filter context now carries verified sources and tool insights derived from tool results, enabling
  Reactor-style tool-result quality audit and response-count injection/consistency filters.
- Verified-source response rendering now appends source blocks from extracted tool-result URLs, builds fallback
  verified responses from tool insights, and suppresses source blocks for casual prompts.
- Slack response formatting now converts LLM Markdown to Slack mrkdwn for both immediate slash-command acknowledgements
  and delayed response_url payloads, including headings, bold, links, pipe tables, raw Slack user IDs, decorative emoji,
  duplicated paragraphs, and fenced-code preservation.
- Hook lifecycle compatibility now invokes Reactor-style tool lifecycle extension points around tool execution
  (`beforeTool` and `afterTool`) and records completed/failed traces without blocking the ReAct loop.
- Context compaction compatibility now carries pinned entities from dropped user messages into generated summaries,
  preserving issue keys and quoted terms for pronoun resolution across later turns.

## Execution Plan

1. Keep `pnpm check` green as the migration acceptance gate.
2. Run `REACTOR_SOURCE_DIR=<local-reactor-path> pnpm verify:reactor-routes` after any API compatibility change.
3. Add new work as product hardening tickets rather than migration backlog.

## Migration Rules

- Keep private names, organizations, real traces, credentials, and absolute source paths out of Muse.
- Prefer generic examples such as `user-1`, `workspace-1`, `read_file`, and `provider/model`.
- Each migration unit gets its own conventional commit.
- Run narrow package tests first, then `pnpm check` before committing.
- Pass local Reactor paths to verification commands through env vars or CLI args; do not commit machine-specific paths.
