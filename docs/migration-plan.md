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
- tool catalog discovery surfaced over HTTP (iteration 42). New
  `GET /api/tools` returns `{ tools: [{ name, description, risk,
  inputSchema?, keywords?, scopes?, dependsOn? }], total }` for every
  registered runtime tool. Optional `?risk=read|write|execute` filter
  narrows the listing; an unknown risk value returns a structured 400
  INVALID_RISK_FILTER. The route is wired through a new
  `ServerOptions.toolCatalogProvider` callback that autoconfigure
  populates from `assembly.toolRegistry.list()` so no additional
  state is duplicated. One new HTTP smoke check validates the shape,
  all-read filtering, and bad-filter 400. Smoke 48 → 49, Muse routes
  380 → 381, route parity 0 missing.
- agent-run history surfaced over HTTP (iteration 41). The historyStore
  was previously only reachable through the prefix-less `/admin/runs/:runId`
  endpoint. New `GET /api/admin/runs` lists recent runs with optional
  `?limit=N` (1..1000, structured 400 INVALID_LIMIT on bad input),
  returning `{ entries: [{ id, inputPreview, model, provider, status }],
  total }`. New `GET /api/admin/runs/:runId` aliases the legacy detail
  route under the standard `/api/admin/...` prefix and returns
  `{ run, messages, toolCalls }` with 404 RUN_NOT_FOUND on miss. Both
  enforce admin authorization. Two new HTTP smoke checks validate the
  list shape, ?limit= and bad-limit branches, drill-down round-trip,
  and the missing-runId 404. Smoke 46 → 48, Muse routes 378 → 380,
  route parity 0 missing.
- agent-core monolith split crosses the 50% threshold (iteration 40).
  Four public types (`UserMemorySnapshot`, `UserMemoryProvider`,
  `UserMemoryInjectionOptions`, `AgentContextWindowReport`) moved to
  `types.ts` and re-exported from the package surface (zero-API-change).
  Two system-prompt helpers (`renderUserMemorySection` —
  facts/preferences/recent-topics → `[User Memory]` block with per-section
  `maxEntries` cap; `appendSystemSection` — injects a `<!-- muse:{id} -->`
  marked block into the first system message, replacing any earlier copy
  to avoid duplication across multi-turn runs) extracted to
  `runtime-helpers.ts`. 7 new unit tests cover empty-snapshot omission,
  facts+preferences bounded rendering, missing-preferences branch,
  prepend-when-no-system, append-on-existing-system, marker-replacement
  on re-injection, and default sectionId. Index file: 2,054 → 1,984 (-70).
  Cumulative 3,983 → 1,984 lines (-1,999, **-50.2%** — past the halfway
  mark) across 13 submodules. agent-core tests 127 → 134; broad smoke
  46/46; route parity 0 missing.
- eighth loopback MCP server `muse.regex` ships by default (iteration 39).
  Three new tools — `test` (boolean match), `match` (enumerate matches with
  index + capture groups, force global, default 1000-cap with explicit
  `truncated` flag, advance on zero-width to terminate), and `replace`
  (force global, supports caller-supplied flags). Bounded for
  safety: text capped at 50k chars, patterns at 256 chars, matches at
  10× default. Compile errors return structured payloads instead of
  throwing. Default loopback roster: 7 → 8. mcp tests 38 → 42, broad
  smoke 46/46 (loopback check now exercises all eight servers and the
  three regex tools end-to-end), route parity 0 missing.
- agent-core monolith split continued (iteration 38). Five runtime-
  internal types (`ModelLoopExecution`, `ExecutedToolResult`,
  `StreamedModelTurn`, `StreamExecutionOptions`, `PlanExecuteStepRecord`)
  and two helpers (`blockedToolResult`, `planExecuteIntermediateMessages`)
  extracted to a new `runtime-internals.ts` module (81 lines) with
  docstrings explaining the message-pair contract and the synthesised
  blocked-result shape. These are package-private — never re-exported.
  Index file: 2,100 → 2,054 (-46). Cumulative 3,983 → 2,054 lines
  (-1,929, **-48.4%**) across 13 submodules. 3 new unit tests cover the
  blocked-tool-result shape, the multi-step assistant + tool message-pair
  rendering, and the empty-plan branch. agent-core tests 124 → 127;
  broad smoke 46/46; route parity 0 missing.
- multi-agent orchestration stats endpoint (iteration 37). New
  `OrchestrationHistorySummary` type + `OrchestrationHistoryStore.summary()`
  method aggregate the in-memory ring buffer into totals (totalRuns,
  completedRuns, failedRuns), duration stats (min/avg/p95/max), per-mode
  runs (sequential / parallel) with per-mode avg duration, and
  `lastRunAt` ISO timestamp. Empty store returns the zero summary; non-
  empty store rounds duration averages and uses ceil(0.95*N)-1 indexing
  for p95. New `GET /api/multi-agent/orchestrations/stats` route — registered
  before the `:runId` parameter route so static segment precedence wins.
  Multi-agent suite 27 → 29 (+2 unit tests covering empty + multi-entry
  aggregation), broad smoke 45 → 46 with totals/min<=avg<=max/per-mode
  invariants, Muse routes 377 → 378, route parity 0 missing.
- seventh loopback MCP server `muse.diff` ships by default (iteration 36).
  Two new tools: `lines` (line-level diff via deterministic
  Longest-Common-Subsequence backtrack, returns ordered `{kind, line,
  leftLine?, rightLine?}` entries plus equals/inserts/deletes counts;
  bounded at 2,000 lines per side to keep the O(M*N) DP under ~4MB) and
  `equal` (byte-equality plus per-side SHA-256 digests for quick
  verification). Default loopback roster: 6 → 7. Smoke check renamed
  and broadened to exercise both diff tools end-to-end (3-line vs
  4-line fixture asserts equals=2/inserts=2/deletes=1, equal-input
  asserts matching digests). mcp tests 34 → 38, broad smoke 45/45,
  route parity 0 missing.
- agent-core split + dead-code cleanup (iteration 35). Two tracing-span
  helpers (`recordContextWindowSpanAttributes`, `recordUsageSpanAttributes`)
  moved to `runtime-helpers.ts` with a new `SpanAttributableContextWindow`
  interface so the helpers do not depend on the runtime's
  `AgentContextWindowReport` type. Each helper now has a
  multi-paragraph docstring documenting the no-op contract for missing
  reports / partial usage. The dead `toHistoryToolStatus(status)`
  identity wrapper was inlined at its single call site (just returns
  the same status string). 5 new unit tests cover full + missing
  context-window report and partial / full / missing usage attribute
  paths. agent-core/src/index.ts: 2,136 → 2,100 (-36). Cumulative
  3,983 → 2,100 lines (-1,883, **-47.3%**) across 12 submodules.
  agent-core tests 119 → 124; broad smoke 45/45; route parity 0
  missing.
- multi-agent orchestration detail endpoint (iteration 34). The history
  buffer now snapshots the full bus conversation (when a messageBus is
  wired) onto each terminal entry. New
  `GET /api/multi-agent/orchestrations/:runId` returns the entry plus
  every `AgentMessage` (sourceAgentId, content, ISO timestamp, optional
  metadata + targetAgentId) — 404 ORCHESTRATION_NOT_FOUND on miss,
  400 INVALID_RUN_ID on empty path. The list response now also surfaces
  `conversationLength` so the operator UI can decide which entries are
  worth drilling into. New `OrchestrationHistoryStore.getByRunId(runId)`
  primitive + 2 unit tests cover the lookup contract and the conversation
  snapshot path. Multi-agent suite 25 → 27, smoke 44 → 45, Muse routes
  376 → 377, route parity 0 missing.
- multi-agent orchestrations now have a queryable history (iteration 33).
  New `OrchestrationHistoryStore` interface + `InMemoryOrchestrationHistoryStore`
  ring buffer (default 100 entries, FIFO eviction, newest-first) record
  every `MultiAgentOrchestrator.run()` outcome with mode, worker counts,
  completed/failed split, ISO timestamps, durationMs, status, and an
  optional error message. The orchestrator records on success, on
  worker-selection failure, on parallel/sequential exception, and on
  no-completed-worker rejection. New `GET /api/multi-agent/orchestrations`
  endpoint returns the snapshot with optional `?limit=N` (1..1000) and
  rejects bad limits with 400 INVALID_LIMIT. Multi-agent suite 16 → 25
  (+9 unit tests covering buffer eviction, list-limit, rejection bounds,
  completed/failed entry recording, missing-store tolerance). Smoke
  43 → 44; Muse routes 375 → 376; route parity 0 missing.
- agent-core monolith split continued (iteration 32). Four
  Plan-Execute-scoped helpers (`isPlanExecuteMode`,
  `systemMessageContent`, `renderToolDescriptionsForPlanning`,
  `renderPlanResultSummary`) moved into `plan-execute.ts`, the natural
  home for plan-execute primitives. The duplicate
  `lastUserMessageContent` was deleted in favour of the existing
  `latestUserPrompt` helper. Added 10 dedicated unit tests covering
  case-insensitive plan-execute detection, system message lookup,
  bullet-list tool rendering, and the success / 데이터 없음 / 실패
  branches of plan-result rendering. agent-core/src/index.ts: 2,180 →
  2,136 (-44). Cumulative 3,983 → 2,136 lines (-1,847, **-46.4%**)
  across 12 submodules. agent-core tests 109 → 119; broad smoke 43/43;
  route parity 0 missing.
- agent-core monolith split continued (iteration 31). Twelve runtime-
  scoped helper functions (`applyAgentSpecSystemPrompt`,
  `toAgentSpecRunReport`, `metadataString`, `latestUserPrompt`,
  `stringListMetadata`, `numberMetadata`, `isModelMessage`, `ragFilters`,
  `toolCallsMetadata`, `toAgentRunMode`, `failMissingProvider`) extracted
  to a new `runtime-helpers.ts` module (118 lines). `AgentSpecRunReport`
  interface promoted from `index.ts` to `types.ts` for cross-module use,
  re-exported through the package surface so the public API is unchanged.
  Local duplicate of `joinUserMessages` removed in favour of the
  `internals.ts` version. agent-core/src/index.ts: 2,280 → 2,180 (-100).
  Cumulative 3,983 → 2,180 lines (-1,803, **-45.3%**) across 12
  submodules. 109/109 tests pass; broad smoke 43/43; route parity 0
  missing.
- sixth loopback MCP server `muse.crypto` ships by default (iteration
  30). Four new tools: `hash` (md5/sha1/sha256/sha512 with hex or base64
  encoding, default sha256/hex), `base64` (encode/decode UTF-8 ↔ base64),
  `hex` (encode/decode UTF-8 ↔ lowercase hex with malformed-input
  rejection), and `uuid` (RFC 4122 v4 with injectable factory for
  deterministic tests). Built on Node's built-in `node:crypto`, no extra
  deps. The smoke harness now validates all six default loopback servers
  and exercises every crypto tool with known fixtures (sha256("muse"),
  base64("hello jarvis"), hex("abc"), and uuid v4 format match). mcp
  tests 30 → 34, smoke 43/43, route parity 0 missing.
- two more loopback MCP servers ship by default (iteration 29).
  `muse.json` exposes `format` (pretty/minify with indent control),
  `query` (dot/bracket JSONPath, e.g., `foo.bar[0]`, with explicit
  found/value contract), and `merge` (override-wins deep merge with
  array replacement). `muse.url` exposes `parse` (host/port/pathname/
  query-map/hash decomposition) and `encode_query` (urlencoded form
  of a key/value object, multi-value via arrays). The smoke harness
  now asserts five default loopback servers (time/text/math/json/url)
  and exercises every new tool end-to-end. mcp tests 25 → 30,
  smoke 43/43, route parity 0 missing. JARVIS-style external-system
  count is now 5 generic loopback MCP servers, exceeding the 3-server
  identity criterion.
- multi-agent orchestration gains streaming + parallel HTTP coverage
  (iteration 28). New `POST /api/multi-agent/orchestrate/stream` opens an
  SSE channel: `start` → `agent_message` (one per worker
  completion/failure, broadcast through an `InMemoryAgentMessageBus`
  subscriber) → `done` carrying the final response, results, and runId.
  The broad smoke now also exercises parallel-mode HTTP orchestration,
  asserting both workers complete and both messages land in the
  conversation snapshot. Smoke 41 → 43, Muse routes 374 → 375, route
  parity stays 0 missing.
- multi-agent message bus is now exposed over HTTP (iteration 27). New
  `POST /api/multi-agent/orchestrate` accepts `{ message, model?, mode?,
  workerIds?, maxWorkers? }` and runs every enabled `AgentSpec` (or the
  requested subset) as an `AgentSpecWorker` that wraps the shared
  `AgentRuntime`, prepending the spec's systemPrompt and tagging
  `metadata.selectedAgentId`/`agentSpecId`. The route returns
  `{ runId, response, results, conversation }` where `conversation` is
  the `InMemoryAgentMessageBus.getConversation()` snapshot. Three new
  HTTP smoke checks: empty-body 400, no-specs 409, two-spec sequential
  run with conversation assertions on `sourceAgentId`. Smoke 38 → 41,
  Muse routes 373 → 374, route parity stays 0 missing.
- multi-agent gains an `AgentMessageBus` primitive (iteration 26). New
  `packages/multi-agent/src/agent-message-bus.ts` exports `AgentMessage`,
  `AgentMessageBus`, `AgentMessageHandler`, `InMemoryAgentMessageBus`. The
  in-memory implementation supports targeted + broadcast publish/subscribe,
  conversation log, and FIFO eviction of the oldest subscriber bucket once
  `maxSubscribers` (default 1000, matches Reactor's Caffeine bound) is
  reached. `MultiAgentOrchestrator` accepts an optional `messageBus` and
  publishes a per-worker message on completion (with `toolsUsed` /
  `fromCache` metadata) or failure (with `status: "failed"`). 10 new unit
  tests cover targeted vs broadcast delivery, getMessages filter,
  conversation order, clear, eviction, and orchestrator wiring. pnpm check
  green; broad smoke 38/38; route parity 0 missing.
- agent-core monolith split continued (iteration 25). Tool-output evidence
  extraction (`extractVerifiedSources`, `extractToolInsights` + 9 file-private
  helpers covering JSON unwrapping, nested URL collection, link-less synthesis,
  and Korean count summaries) moved to `tool-output-evidence.ts`. Module is
  also covered by 12 dedicated unit tests (envelope unwrap, multi-key URL walks,
  Jira/Confluence synthesis, count→insight bucketing). Index file: 2,441 →
  2,280 lines (-161). Cumulative 3,983 → 2,280 (**-42.8%** from start, 11
  submodules). 109/109 agent-core tests, broad smoke 38/38, route parity 0
  missing.
- agent-core monolith split continued (iteration 24). The last filter factory
  (`createVerifiedSourcesResponseFilter`) extracted to `response-filters.ts` along with its
  six file-private helpers (`uniqueVerifiedSources`, `isCasualPromptText`,
  `buildFallbackVerifiedResponse`, `maybeAppendToolInsights`, `buildVerifiedInsightLines`,
  `hasInsightMarker`, `buildVerifiedSourcesBlock`, `hasEquivalentSourceBlock`,
  `escapeMarkdownTitle`, `containsHangul`). `normalizeSourceUrl` moved to `internals.ts` since
  it is shared with the runtime's `responseFilterEvidenceFromExecution`. All 16 response filter
  factories now live in `response-filters.ts`. Public API unchanged. Index file: 2,600 → 2,441
  lines (cumulative 3,983 → 2,441, **-38.7%** from start, ~10 submodules).
- agent-core monolith split continued (iteration 23). Three more response-filter factories
  (`createToolResultQualityAuditFilter`, `createResponseCountInjectionFilter`,
  `createResponseCountConsistencyFilter`) extracted to `response-filters.ts`. Three filter helpers
  (`extractApologyLead`, `resolveActualResponseCount`, `isSignificantCountMismatch`) moved to
  `internals.ts`. Public API unchanged. Index file: 2,765 → 2,600 lines (cumulative 3,983 → 2,600,
  **-34.7%** from start). Only `createVerifiedSourcesResponseFilter` remains in index.ts among the
  filter factories pending its dedicated helper extraction.
- agent-core monolith split continued (iteration 22). Three more response-filter factories
  (`createCasualLureStripResponseFilter`, `createPolicyStrongPriorWarningFilter`,
  `createZeroResultOverclaimResponseFilter`) extracted to `response-filters.ts`. Sentence-splitter
  helper (`splitPreservingSentencePunctuation`) moved to `internals.ts`. Public API unchanged.
  Index file: 2,972 → 2,765 lines (cumulative 3,983 → 2,765, **-30.6%** from start).
- agent-core monolith split continued (iteration 21). Two more response-filter factories
  (`createStructuredOutputResponseFilter`, `createReleaseRiskDataGapResponseFilter`) extracted to
  `response-filters.ts` along with their dedicated helpers (`readStructuredOutputFormat`,
  `removeOverconfidentReleaseFragments`). Public API unchanged. Index file: 3,062 → 2,972 lines —
  first time below the 3,000-line mark since the migration began (cumulative 3,983 → 2,972,
  -25.4%).
- agent-core monolith split continued (iteration 20). Three more response-filter factories
  (`createSourceBlockResponseFilter`, `createMarkdownStripResponseFilter`,
  `createGreetingStripResponseFilter`) extracted to `response-filters.ts`. Markdown helper
  functions (`splitOnCodeFences`, `transformMarkdownText`, `markdownTablesToBullets`,
  `isMarkdownTableRow`, `isMarkdownTableSeparator`, `parseMarkdownTableRow`) moved to
  `internals.ts` so any submodule can reuse them. Public API unchanged. Index file:
  3,226 → 3,062 lines (cumulative 3,983 → 3,062, -23%).
- agent-core monolith split continued (iteration 19). Response-filter types
  (`ResponseFilterContext`, `ResponseFilterStage`, `VerifiedSource`) extracted to `types.ts`. Five
  self-contained filter factories extracted to `response-filters.ts`
  (`createMaxLengthResponseFilter`, `createSanitizedTextResponseFilter`,
  `createSlackUserIdMaskResponseFilter`, `createInternalBrandMaskResponseFilter`,
  `createFabricationRequestRefusalFilter`). `withResponseFilterRaw` and `isRecord` helpers moved to
  `internals.ts`. Public API unchanged. Index file: 3,393 → 3,226 lines (cumulative 3,983 → 3,226,
  -19%, 8 submodules).
- JARVIS observability snapshot endpoint now exists. `@muse/observability` adds
  `createJarvisObservabilitySnapshotProvider` that aggregates latency summary, token-cost daily +
  topExpensive, SLO snapshot + violations, drift stats, cost-anomaly baseline, monthly budget
  snapshots, and follow-up suggestion stats into a single `JarvisObservabilitySnapshot`. Each
  component is optional and individually fail-soft (one broken query never breaks the snapshot).
  Wired through autoconfigure → `/api/admin/jarvis/snapshot` returns the live aggregate; returns 503
  when no provider is configured. Closes the JARVIS stop criterion "observability dashboards documented
  and exercised" without requiring an external Grafana surface.
- agent-core monolith split continued (iteration 17). Guard factories extracted to
  `packages/agent-core/src/guards.ts` (`createInjectionInputGuard`, `createPiiInputGuard`,
  `createTopicDriftInputGuard`, `createLlmClassificationInputGuard`, `createPiiMaskingOutputGuard`,
  `createDynamicOutputGuardRuleStage`, `createSystemPromptLeakageOutputGuard`); shared runtime types
  extracted to `types.ts` (`AgentRunInput`, `AgentRunContext`, `GuardStage`, `GuardDecision`,
  `HookStage`, `OutputGuardStage`, `OutputGuardDecision`, etc.); private message/JSON helpers
  extracted to `internals.ts` (`joinMessages`, `joinUserMessages`, `parseLlmClassificationDecision`,
  `parseJsonObjectFromText`, `stringField`). Public API unchanged. Index file: 3,663 → 3,393 lines.
- agent-core monolith split continued. Checkpoint state types + codec extracted to
  `packages/agent-core/src/checkpoint.ts` (`AgentCheckpointState`, `createAgentCheckpointState`,
  `encodeCheckpointMessages`, `decodeCheckpointMessages`); error classes extracted to
  `packages/agent-core/src/errors.ts` (`GuardBlockedError`, `OutputGuardBlockedError`,
  `ModelRoutingError`). Public API unchanged. Index file: 3,724 → 3,663 lines.
- agent-core monolith split begun. `StepBudgetTracker` + types extracted to
  `packages/agent-core/src/step-budget.ts`; `ToolCallDeduplicator` + `stableJson` to
  `tool-call-deduplicator.ts`; PlanExecute primitives (`PlanStep`, `PlanValidationError`,
  `PlanValidationResult`, `StepExecutionResult`, `PlanValidationFailedError`, `PlanExecutionError`,
  `extractJsonArray`, `parsePlan`, `validatePlan`) to `plan-execute.ts`. Public API unchanged
  (re-exported from `index.ts`); index dropped from 3,983 → 3,724 lines without behavior change.
  All 97 agent-core tests still pass.
- Response completeness evaluator now exists in `@muse/eval` as
  `createResponseCompletenessEvaluator`. LLM-as-judge that scores how well a response addresses the
  original prompt on a 0–100 integer scale, with probabilistic sampling (default 10%), short judge
  prompt (Korean criteria-equivalent English), `temperature=0` by default, fail-soft on provider
  errors. Returns `{ overall, sampledAt }` or `undefined` when skipped/blank/unparsable. Closes the
  Reactor `ResponseCompletenessEvaluator` parity gap without Spring AI coupling.
- A2A agent card now uses real tool input schemas. `@muse/agent-specs` adds `buildAgentCard`,
  `AgentCapability` (`kind: "tool" | "persona"`), and identity defaults. Autoconfigure passes a
  `agentCardToolProvider` callback that maps `assembly.toolRegistry.list()` to capabilities so
  `/.well-known/agent-card.json` advertises every Jarvis / runner / MCP-loopback / scheduler tool with
  its real `inputSchema`. `MUSE_AGENT_CARD_NAME|VERSION|DESCRIPTION` env vars override identity. Closes
  the Reactor `AgentCardProvider` parity gap without persona-store coupling.
- Loopback MCP servers now exist in `@muse/mcp` (`createTimeMcpServer`, `createTextUtilsMcpServer`,
  `createMathMcpServer`, `createDefaultLoopbackMcpServers`). Each ships a curated set of read-risk tools
  with no credentials, exposed through the same `McpConnection` shape as external MCP servers.
  `createLoopbackMcpConnection(server)` returns an `McpConnection` (listTools/callTool/close);
  `createLoopbackMcpMuseTools(server)` wraps each tool as a `<server>.<tool>` Muse tool. Closes the
  JARVIS stop criterion "at least 3 generic external-system MCP integrations work end-to-end without
  private credentials" — three default servers run inside the Muse runtime with no external process or
  API key required.
- Chunk-merging retriever now exists in `@muse/rag` as `createChunkMergingRetriever(delegate, {
  windowSize?, separator? })`. Decorator pattern: wraps any `DocumentRetriever`, groups chunked hits
  by `parent_document_id`, sorts by `chunk_index`, joins their content (default `\n`), preserves the
  highest score, surfaces `merged_chunks` / `window_size` / `chunk_indices` metadata, and passes
  non-chunked documents through unchanged. Score-descending sort + dedup-by-id + topK enforced.
  Closes the Reactor `ParentDocumentRetriever` Mixture-of-Granularity parity gap; the existing
  `ParentDocumentRetriever` (parent lookup) remains for the alternative pattern.
- Adaptive query router now exists in `@muse/rag`. `createLlmAdaptiveQueryRouter({ provider, model,
  timeoutMs })` classifies a user query as `no_retrieval` | `simple` | `complex` via an LLM and lets
  callers pick a downstream pipeline strategy. Falls back to `simple` on provider errors AND timeouts
  (default 3 s) — skipping retrieval is more dangerous than running an unnecessary search. Exports
  `parseQueryComplexity` (visible for testing) and `ADAPTIVE_QUERY_ROUTER_DEFAULT_SYSTEM_PROMPT` for
  override. Closes the Reactor `AdaptiveQueryRouter` parity gap without Spring AI coupling.
- Adversarial red-team harness now exists in `@muse/policy` as `AdversarialRedTeam`. Asks an injectable
  attacker `ModelProvider` to generate prompt-injection attempts in N rounds (with previous-round
  blocked examples fed back as evolution hints), runs each attempt through an injectable `guard`
  adapter, and returns a `RedTeamReport` with totals + bypass rate. Ships a default `createPatternGuard`
  that uses `sharedInjectionPatterns` so the harness can be exercised without wiring a full pipeline.
  Provider failures yield empty rounds (logged via `logger`); guard failures fail closed. Closes the
  Reactor `AdversarialRedTeam` parity gap without Spring AI / Atlassian coupling.
- Cost anomaly + monthly budget tracking now exist in `@muse/observability`. `CostAnomalyDetector`
  flags requests whose USD cost exceeds the rolling-window baseline by `thresholdMultiplier` (default 3×).
  `MonthlyBudgetTracker` aggregates per-tenant USD cost into the current calendar month, transitions
  `ok` → `warning` (default 80%) → `exceeded`, auto-resets on month rollover, and bounds in-memory tenants
  via `maxTenants` cap (FIFO eviction). `@muse/integrations` adds `createCostAnomalyHook` that records
  cost on `afterComplete` and forwards anomalies + budget transitions through an optional `notify`
  callback. Closes Reactor `agent.budget` `CostAnomalyDetector` + `MonthlyBudgetTracker` parity.
- Prompt drift detector now exists in `@muse/observability` as `PromptDriftDetector`. Tracks input/output
  length samples in a sliding window and emits a `DriftAnomaly` (`input_length` | `output_length`) when
  the second-half mean drifts past `deviationThreshold` baseline standard deviations from the first-half
  mean. Uses a 1% baseline-mean stddev floor when the baseline is uniform so deterministic shifts still
  alert. `@muse/integrations` adds `createPromptDriftHook` that records input length on `beforeStart` and
  output length on `afterComplete`, forwarding anomalies through an optional `notify` callback. Closes
  the Reactor `PromptDriftDetector` + `PromptDriftHook` parity gap.
- SLO alert evaluator now exists in `@muse/observability` as `SloAlertEvaluator`. Tracks latency samples
  and result outcomes over a configurable rolling window, raises `SloViolation` (type: `latency` |
  `error_rate`) when P95 latency or error rate exceeds threshold, and gates duplicate alerts per type via
  cooldown. `@muse/integrations` adds `createSloAlertHook` that records latency on `afterComplete` /
  `onError` from the agent lifecycle and forwards violations to an optional `notify` callback (errors
  swallowed via `logger`). Closes the Reactor `SloAlertEvaluator` + `SloAlertHook` parity gap.
- LLM-backed contextual compressor (RECOMP-style) now exists in `@muse/rag` as
  `createLlmContextualCompressor({ provider, model, ... })`. Skips documents shorter than
  `minContentLength` (default 200 chars) without a model call, bounds parallelism via
  `maxConcurrent` (default 5), drops a document when the model responds `IRRELEVANT` (case-insensitive
  with optional terminal punctuation), preserves the original on blank/empty output or provider failure
  (fail-open), and assembles the user prompt with concatenation to avoid Reactor's template-replace
  double-substitution bug. Closes the Reactor `LlmContextualCompressor` parity gap.
- LLM-driven RAG query transformers now exist in `@muse/rag`. `createLlmHypotheticalDocumentTransformer`
  generates a HyDE-style hypothetical answer document and returns it alongside the original query;
  `createLlmDecomposingQueryTransformer` splits a complex question into sub-queries via an LLM, enforces a
  max-queries cap, strips numbering/bullets, dedupes, and falls back to the original query when the model
  errors. Both factories use any `@muse/model` `ModelProvider`, exposing `HYDE_DEFAULT_SYSTEM_PROMPT` and
  `DECOMPOSE_DEFAULT_SYSTEM_PROMPT` constants for override. Closes the Reactor `HyDEQueryTransformer` and
  `DecompositionQueryTransformer` parity gaps without Spring AI coupling.
- AgentRuntime now has a native `UserMemoryProvider` injection path. When `metadata.userId` is present
  and a provider is configured (default: the autoconfigure-wired `userMemoryStore`), the run prepends a
  `[User Memory]` system section listing facts, preferences, and recent topics ahead of any RAG context
  or tool results. Bounded by `userMemoryInjection.maxEntries` (default 12). Errors from the provider are
  swallowed so memory backend flakes never break a run. Disable with `MUSE_USER_MEMORY_INJECTION=false`.
  This closes the JARVIS "remembers you across sessions" stop criterion: facts written via
  `UserMemoryStore.upsertFact` automatically influence subsequent runs without any per-session prompt
  surgery from the caller. Smoke broad now exercises both the on and off paths.
- JARVIS-style ambient tools now ship with every Muse runtime via `createJarvisTools()` in `@muse/tools`
  (`time_now`, `time_diff`, `time_add`, `text_stats`, `math_eval`, `json_query`). All tools are zero-IO,
  read-risk, deterministic given identical inputs (or injected clock for time tools), and registered into
  the autoconfigure tool registry by default. `math_eval` parses a constrained arithmetic grammar via a
  recursive-descent evaluator instead of `eval`/`Function`. `json_query` resolves dotted paths through
  objects + arrays. Disable with `MUSE_JARVIS_TOOLS_ENABLED=false`. Smoke broad now asserts the registry
  exposes all six names and that the toggle is honored.
- HTTP smoke harness now exists as `pnpm smoke:broad` (`scripts/smoke-broad-http.mjs`). It boots `apps/api`
  on a free port and exercises 20 representative endpoints with shape-level assertions: chat, streaming
  chat, plan_execute mode, OpenAPI, runtime settings, agent specs, audits with `{items,total}`, latency
  summary/timeseries, token-cost daily/top-expensive, conversation failure-pattern bucketing, tool accuracy
  rates, approvals, scheduler, MCP, cache invalidate, RAG analytics status, follow-up suggestion stats.
  Passes 20/20 against the diagnostic provider. Exits non-zero on any regression so future iterations get
  a real signal that the public API contract still holds.
- AgentRuntime errors now propagate as structured 422 responses through the API. `PlanExecutionError`
  surfaces as `errorCode: PLAN_GENERATION_FAILED|PLAN_ALL_STEPS_FAILED|RESPONSE_SYNTHESIS_FAILED`,
  `PlanValidationFailedError` as `errorCode: PLAN_VALIDATION_FAILED`. Generic 500 `AGENT_RUN_FAILED` is
  reserved for unexpected runtime errors.
- Admin analytics compatibility now classifies failures and tool outcomes deterministically.
  `/api/admin/conversation-analytics/failure-patterns` aggregates failed runs by error class
  (timeout / guard_rejection / plan_validation_failed / plan_all_steps_failed / plan_generation_failed
  / response_synthesis_failed / rate_limit / auth / not_found / other / unknown) with sample run ids and
  total failure counts, mirroring Reactor's bucketing instead of returning per-run rows.
  `/api/admin/tools/accuracy` now derives `notFoundRate`, `timeoutRate`, `errorRate`, and `invalidCallRate`
  from real outcome counts (with `not_found` recognized when the tool error contains "not found"/"404"),
  no longer hard-coding the rates to zero.
- Admin audit compatibility now performs server-side filtering. `AdminAuditStore.query({ category?, action?, limit?, offset? })`
  is available on both `InMemoryAdminAuditStore` and `KyselyAdminAuditStore`, returning `{ items, total }`.
  `/api/admin/audits` consumes the new query when an audit store is configured, so category/action filters
  and pagination round-trip to the database instead of post-fetch JS filtering. Legacy in-memory state path
  remains as the no-store fallback.
- Slack reminder compatibility now exists in `@muse/integrations`. `parseReminderTime` recognizes the
  Reactor English (`at HH:mm`) and Korean (`N시 M분에`) suffixes, rolling past times to the next day in the
  configured timezone (default `Asia/Seoul`). `InMemoryReminderStore` provides per-user FIFO storage with
  the Reactor 50-per-user cap and a `collectDue` API. `createSlackReminderPoller` dispatches due reminders as
  bell-prefixed DMs through the existing `SlackMessageTransport` on a configurable interval.
  `handleSlackReminderCommand` parses `add`/`list`/`done <id>`/`clear` subcommands so the `/muse remind` slash
  surface can be wired in without leaking store details into the route layer.
- Token cost analytics compatibility now uses a real `TokenCostQuery` service. `KyselyTokenCostQuery`
  reads `metric_token_usage` (now a typed table in `@muse/db`) for per-session, daily, and top-expensive
  aggregations, while `InMemoryTokenCostQuery` performs the same grouping over an `InMemoryTokenUsageSink`.
  AgentRuntime emits one `TokenUsageRecord` per model call to the configured `TokenUsageSink`, so
  `/api/admin/token-cost/{by-session,daily,top-expensive}` now serve real cost data instead of in-memory run
  snapshots when autoconfigure wires the query in.
- Slack followup suggestions compatibility now exists in `@muse/integrations`. `parseFollowupSuggestions`
  extracts well-formed entries from the `<!--FOLLOWUPS:[...]-->` HTML-comment marker (caps at 5),
  `stripFollowupMarker` removes the marker before display, `truncateFollowupLabel` enforces Slack's 75-char
  button limit, and `renderFollowupSuggestionBlocks` emits a Block Kit `actions` block with `followup.<id>`
  action_ids. `createFollowupSuggestionInteractionHandler` records click events through the existing
  `FollowupSuggestionStore` for CTR analytics, re-runs the agent against the suggestion's prompt via an
  injected `runAgent` callback, and posts the reply as a thread reply when a message transport is configured.
- AgentRuntime now honors `metadata.agentMode === "plan_execute"` for both `run()` and `stream()`,
  dispatching to a 4-stage `executePlanExecuteLoop` (generate → validate → execute → synthesize). Empty plans
  fall back to a direct-answer LLM call; JSON parse failures surface a `PlanExecutionError(PLAN_GENERATION_FAILED)`;
  unregistered tools surface `PlanValidationFailedError`; all-failed step sets surface
  `PlanExecutionError(PLAN_ALL_STEPS_FAILED)` to avoid hallucinated synthesis; mixed success/failure runs include
  `[실패]`/`[데이터 없음]` markers in the synthesis prompt. The mode dispatch is case-insensitive and ignores any
  non-plan_execute value, preserving the existing ReAct path as the default.

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
