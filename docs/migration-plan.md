# Muse Migration Plan

Source baseline: Reactor has 31 Gradle modules under `/modules` plus the root `app` bootstrap project.

Current Muse baseline:
- Packages: 23
- Apps: 3
- Rust crates: 1
- Verified gate: `pnpm check`
- Branch state: verify with `git status -sb` before pushing or merging
- Route parity is currently tracked separately from DB/state parity.

## Current Count

| Bucket | Count | Meaning |
| --- | ---: | --- |
| Reactor source modules with Muse landing zones | 31 | Every `modules/*` source module has a package or API target |
| Reactor included projects with Muse landing zones | 32 | `app` plus all 31 source modules are mapped |
| Cross-cutting compatibility areas | 4 | Context, response filtering, hooks, and multi-agent behavior are tracked as capabilities, not Reactor source modules |
| HTTP route parity | 255 / 255 | Every Reactor controller route under `app` and `modules` is registered in Muse |
| DB table parity | 52 / 52 | Every Reactor persistent table name has a Muse migration target; store wiring is still being migrated |
| Functionally exercised source modules | 31 | Core behavior exists and is covered by package/API tests |
| Deep-hardening areas still open | 4 | Response filters, Slack behavior, hook/context behavior, and DB-backed state parity remain open |
| Remaining unmapped modules | 0 | No source module is without a target |

## Completed Migration Areas

| Reactor module | Muse target | Current status |
| --- | --- | --- |
| `app` | `apps/api` | Runtime bootstrap, environment assembly, Fastify server entrypoint |
| `agent` | `packages/agent-core` | ReAct loop, tool execution, streaming, guards, hooks, cache, RAG, history |
| `api` | `apps/api` | Chat, SSE chat, auth, settings, agent specs, history, MCP, scheduler, quality routes |
| `admin` | `apps/api`, `packages/runtime-state`, `packages/db` | Metrics, cache, alert, cost, SLO, tenant ops |
| `approval` | `packages/policy`, `packages/runtime-state` | Approval policies and pending approval stores exist |
| `auth` | `packages/auth`, `apps/api`, `packages/db` | JWT auth, password hashing, DB/in-memory user store, DB/in-memory revocation, guard, rate limiting |
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
| `model-routing` | `packages/model` | Provider registry, prefix routing, OpenAI-compatible, OpenAI, OpenRouter, Ollama, Anthropic, and Gemini adapters exist |
| `observability` | `packages/observability`, `packages/runtime-state`, `packages/db` | Tracing, persisted trace events, metrics, and history stores exist |
| `persistence-schema` | `packages/db` | Kysely schema covers runtime, scheduler, MCP, and admin state |
| `promptlab` | `packages/promptlab`, `apps/api` | Prompt variants, experiments, runner, ranking, and admin API exist |
| `prompts` | `packages/prompts` | Prompt assembly, response format instructions, and cache boundary helpers exist |
| `rag` | `packages/rag` | Chunking, BM25/RRF retrieval, reranking, context building, and in-memory corpus exist |
| `resilience` | `packages/resilience` | Circuit breaker registry, retry, timeout, and model fallback primitives exist |
| `runtime-settings` | `packages/runtime-settings`, `apps/api` | Runtime settings service/store and API surface exist |
| `scheduler` | `packages/scheduler`, `apps/api` | CRUD, execution records, cron, and scheduler locks exist |
| `slack` | `packages/integrations`, `apps/api` | Signed Events API dispatch plus thread replies, slash-command channel/thread posting, interaction dispatch, persisted response tracking and feedback metadata, response_url fallback, and Slack mrkdwn response formatting exist |
| `tool` | `packages/tools` | Tool registry, executor, sanitizer, and approval path exist |
| `web` | `apps/api`, `apps/web` | HTTP/SSE run endpoints, typed error surfaces, and initial Vite/React operator UI exist |

## Cross-Cutting Compatibility Areas

These are not Reactor Gradle modules, but they are kept as explicit migration checks because they affect parity across
multiple source modules.

| Area | Muse target | Current status |
| --- | --- | --- |
| Context handling | `packages/memory`, `packages/agent-core` | Context trimming, pinned-entity compaction summaries, and assistant/tool message-pair handling exist |
| Response filtering | `packages/policy`, `packages/agent-core` | Output guards, verified-source rendering, source/structured filters, markdown/sanitized-text cleanup, greeting/lure stripping, fabrication refusal, policy-prior warning, max-length truncation, Slack ID masking, internal brand masking, tool-result quality audit, response-count injection/consistency, zero-result overclaim cleanup, and release-risk data-gap cleanup exist |
| Hook lifecycle | `packages/agent-core`, `packages/runtime-state`, `packages/integrations` | Agent/tool hook callbacks, trace persistence, and webhook signing exist |
| Multi-agent orchestration | `packages/multi-agent` | Supervisor, worker selection, fallback, sequential/parallel delegation, and handoff trace primitives exist |

## Remaining Deep-Hardening Areas

No known source module remains unmapped.
The remaining checks are cross-module behavior parity checks that should be closed before calling the migration
fully done:

1. Response filters: compare Reactor's verified-source extractor edge cases against Muse extraction
   (nested URL fields, synthesized source directories, and source relevance filtering still need broader parity tests).
2. Slack behavior: verify Socket Mode behavior beyond the HTTP webhook, threaded response tracking, and feedback-store wiring now covered in Muse packages.
3. Hook/context behavior: verify message-pair integrity under broader runtime smoke tests.
4. DB-backed state parity: move remaining Reactor-compatible state out of process-local compatibility Maps and into Kysely-backed stores.

Latest route parity check: `REACTOR_SOURCE_DIR=<local-reactor-path> pnpm verify:reactor-routes` reports 255 Reactor
routes, 369 Muse routes, and 0 missing Reactor routes.

Latest DB parity check: `REACTOR_SOURCE_DIR=<local-reactor-path> pnpm verify:reactor-db` reports 52 Reactor tables,
64 Muse tables, and 0 missing Reactor tables. This is table-name parity only; remaining work is moving compatibility
route state and runtime services onto Kysely-backed stores.

## Recent Completion Notes

- MCP now uses real SDK transports for stdio, SSE, and streamable HTTP.
- Slack signed slash commands and URL verification are wired through API routes.
- Admin APIs cover metrics, cache invalidation, and circuit breaker reset operations.
- Scheduler has management routes plus a Node cron runtime.
- OpenAI-compatible streaming preserves streamed tool-call deltas, while `/api/chat/stream` emits Reactor-style
  `tool_start`, `tool_end`, and empty `done` SSE events.
- CLI remote chat can now use `/api/chat/stream` with `--stream`, while still recording `.muse/runs/*.jsonl` state.
- CLI auth now stores API bearer tokens in an encrypted credential file and reuses them for remote API calls when no
  explicit token is provided.
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
- Reactor-compatible admin session tags now use a shared `SessionTagStore` with in-memory and Kysely-backed
  implementations instead of route-local state when the runtime assembly provides a database handle.
- Reactor-compatible conversation summaries now use a shared memory-layer `ConversationSummaryStore` with
  in-memory and Kysely-backed UPSERT semantics matching Reactor's `conversation_summaries` table.
- Reactor-compatible RAG ingestion policy and candidate review routes now use shared `RagIngestionPolicyStore`
  and `RagIngestionCandidateStore` implementations with in-memory and Kysely-backed persistence.
- Reactor-compatible Slack bot instances and channel FAQ registrations now use shared integrations stores with
  in-memory and Kysely-backed persistence.
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
- Auth runtime assembly now switches to async Kysely-backed users and token revocations when a database handle is
  provided, while preserving the existing in-memory sync auth service for local tests and no-DB mode.
- `crates/runner` now exists as the initial Rust child-process runner scaffold with a JSON stdin/stdout contract,
  timeout handling, output truncation, controlled env/cwd support, and path-command rejection. It still needs local
  `cargo test` verification in an environment with Cargo installed.
- `apps/web` now exists as a Vite/React/TanStack Query operator surface for API health, chat, pending approvals, and
  recent run summaries, with `pnpm --filter @muse/web build` and package test coverage passing.
- The CLI remote `chat` command now writes workspace run state to `.muse/runs/*.jsonl` by default, preserving the API
  response and source metadata for later inspection.
- The CLI `chat --local` path now runs through the shared `packages/autoconfigure` / `packages/agent-core` runtime
  instead of forking agent behavior, and writes the same `.muse/runs/*.jsonl` state with `source: "cli.local"`.
- The model layer now includes Muse-owned adapters for OpenAI, Anthropic, Gemini, OpenRouter, Ollama, and
  OpenAI-compatible endpoints; autoconfigure can select named providers without making `agent-core` depend on vendor SDKs.
- `packages/tools` now exposes a `run_command` tool that bridges risky execution through the Rust runner child process
  when `MUSE_RUNNER_ENABLED=true`, leaving approval gating to the existing tool approval policy.
- Observability now has a persisted trace-event sink and tracer wired through DB-backed autoconfigure, so completed
  spans can be written into the queryable `trace_events` table instead of staying local-only.
- Tool Policy compatibility now uses a package-level `ToolPolicyStore` with Kysely and in-memory implementations;
  DB-backed runtime assembly persists `/api/tool-policy` state into the `tool_policy` table instead of relying only
  on the process-local compatibility map.
- User Memory compatibility now uses a package-level `UserMemoryStore` with Kysely and in-memory implementations;
  DB-backed runtime assembly persists `/api/user-memory/:userId` facts/preferences into the `user_memories` table.
- Admin audit and metric ingestion compatibility now use runtime-state stores with Kysely-backed persistence for
  `admin_audits` and `metric_audit_trail` when the API is assembled with a database handle.
- Platform pricing and alert-rule compatibility now use runtime-state stores with Kysely-backed persistence for
  `model_pricing` and `alert_rules` instead of route-local Maps when a database handle is configured.
- Feedback compatibility now uses a package-level `FeedbackStore` in `packages/promptlab`; DB-backed API assembly
  persists submit/list/review/delete flows into the `feedback` table while preserving the Reactor response envelope
  and optimistic version checks.
- Prompt Lab experiment compatibility now uses a package-level `PromptLabExperimentStore` in `packages/promptlab`;
  DB-backed API assembly persists experiment lifecycle, generated trials, and reports into `experiments`, `trials`,
  and `experiment_reports` while retaining the Reactor response envelopes.
- Persona, prompt-template/version, and intent compatibility now use a package-level `PromptLabCatalogStore`;
  DB-backed API assembly persists those admin catalogs into `personas`, `prompt_templates`, `prompt_versions`, and
  `intent_definitions` instead of process-local Maps.
- Guard rule compatibility now uses a package-level `GuardRuleStore` in `packages/policy`; DB-backed API assembly
  persists input guard rules, output guard rules, and output guard audits into their Reactor-compatible tables while
  retaining existing fail-close/fail-open runtime behavior.
- Context trimming now treats assistant messages with multiple tool calls and their tool responses as one integrity
  group, with deterministic regression coverage in `packages/memory`.
- RAG/document tests were rechecked against migration redaction rules; current document bodies remain synthetic
  fixtures rather than private workspace content.
- Agent eval and debug replay compatibility now use a package-level `AgentEvalStore`; DB-backed API assembly
  persists promoted eval cases, run logs, deterministic and LLM-judge results, and debug replay captures while keeping
  judge calls behind Muse `ModelProvider`.
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
- Agent budget compatibility now includes a provider-neutral step token budget tracker for model steps and tool-output
  steps, with explicit `ok`, `soft_limit`, and `exhausted` states.
- ReAct loop compatibility now deduplicates repeated completed tool calls by tool name and canonical arguments, reusing
  the completed output while preserving assistant/tool message-pair integrity.
- Approval context compatibility now recognizes `jira_`, `confluence_`, and `bitbucket_` read-tool names, extracts
  Reactor-style impact scopes, and redacts PII before rendering approval requests without coupling Muse to a live
  Atlassian tenant.
- IAM token exchange compatibility now exists as a verifier-injected auth service and `/api/auth/exchange` alias,
  preserving Reactor response envelopes while keeping live public-key fetching behind an adapter boundary.
- Context compaction compatibility now carries pinned entities from dropped user messages into generated summaries,
  preserving issue keys and quoted terms for pronoun resolution across later turns.
- Multi-agent compatibility now includes package-level sequential and parallel delegation modes in addition to
  supervisor worker selection and failure fallback.
- Slack Events API compatibility now dispatches signed `app_mention` and DM/thread `message` callbacks into the same
  command execution path, ignores bot/subtype events, deduplicates retry `event_id`s, and strips bot mention prefixes.
- Slack Events API delivery now posts Reactor-style `chat.postMessage` thread replies for handled events when a Slack bot
  token or injected message transport is configured.
- Slack slash-command delivery now prefers Reactor-style channel question posting plus threaded answer posting when a
  Slack bot token or injected message transport is configured, and falls back to `response_url` if posting is unavailable.
- Slack interaction compatibility now includes Reactor-style `block_actions`/`view_submission` parsing and action-id
  prefix dispatch, with signed HTTP interaction callbacks wired into the Slack route layer.
- Slack feedback button compatibility now includes a bounded/injectable bot-response tracker plus `feedback.up/down`
  handler that restores the original session prompt, persists feedback metadata when a store is configured, calls a
  feedback sink, and posts thread/ephemeral acknowledgements.
- Slack progress hook compatibility now exists as `createSlackProgressHook`, calling
  `assistant.threads.setStatus` from `beforeTool`/`afterTool` lifecycle events with throttled, friendly-named
  Korean status updates. Activates only when `slackChannelId` + `slackThreadTs` metadata are present, swallows
  transport errors, and resets the 2-minute Slack thinking-indicator TTL on each tool boundary.
- Admin latency analytics compatibility now uses a real `LatencyQuery` service. `KyselyLatencyQuery` aggregates
  `trace_events` rows with `DATE_TRUNC`-style bucketing plus `PERCENTILE_CONT(0.95)` for p95, while
  `InMemoryLatencyQuery` performs the same bucketing/percentile math against an `InMemoryTraceEventSink` for the
  no-DB scaffold. `/api/admin/metrics/latency/{summary,timeseries}` now consume the query when autoconfigure wires it
  in, falling back to the previous in-memory run-history aggregation only when no query is configured.
- PlanExecute scaffolding now exists in `@muse/agent-core` (`PlanStep`, `StepExecutionResult`,
  `PlanValidationError`, `PlanValidationResult`, `PlanValidationFailedError`, plus `extractJsonArray`,
  `parsePlan`, `validatePlan` helpers) and `@muse/prompts` (`buildPlanningSystemPrompt`). These mirror Reactor's
  `agent.plan.PlanStep` / `agent.plan.PlanValidator` / `agent.impl.prompt.PlanningPromptBuilder` and are the
  primitives the upcoming PlanExecute loop will compose.

## Execution Plan

1. Keep `pnpm check` green as the migration acceptance gate.
2. Run `REACTOR_SOURCE_DIR=<local-reactor-path> pnpm verify:reactor-routes` after any API compatibility change.
3. Run `REACTOR_SOURCE_DIR=<local-reactor-path> pnpm verify:reactor-db` after any DB/store compatibility change.
4. Work through `docs/superpowers/plans/2026-05-06-reactor-migration-completion.md` in priority order.

## Migration Rules

- Keep private names, organizations, real traces, credentials, and absolute source paths out of Muse.
- Prefer generic examples such as `user-1`, `workspace-1`, `read_file`, and `provider/model`.
- Each migration unit gets its own conventional commit.
- Run narrow package tests first, then `pnpm check` before committing.
- Pass local Reactor paths to verification commands through env vars or CLI args; do not commit machine-specific paths.
