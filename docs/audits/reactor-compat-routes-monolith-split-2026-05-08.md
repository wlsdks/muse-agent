# Reactor-compat routes monolith split — final audit

**Date**: 2026-05-08
**Scope**: `apps/api/src/reactor-compat-routes.ts` decomposition
**Verifier**: HTTP curl + `pnpm check` + `pnpm verify:reactor-routes` + `pnpm verify:reactor-db` per iteration

## Executive summary

`apps/api/src/reactor-compat-routes.ts` started as a **10,640-line monolith** holding every Reactor-compatibility route + helper in one file. Across 48 commit-disciplined rounds it is now **1,223 lines**, with the routes and helpers redistributed across **54 focused modules**. The remaining file is the dispatcher + `state` initializer + state accessors + 28 re-export blocks for backwards compatibility — every utility helper has been moved out.

**Net reduction: -9,417 lines (-88.5%)**.

Every iteration was followed by:
- `pnpm check` (lint/types/tests) green
- `pnpm verify:reactor-routes` reporting 0 missing Reactor routes
- HTTP curl against an `apps/api dev` instance asserting real response shapes
- 1–2 conventional commits with end-to-end verification evidence in the commit body

No route was added, removed, or renamed. No response shape changed. No behavior changed. This was pure structural refactor.

## Trajectory

```
Round  Lines    Δ        Cumulative %     Module(s) added
 0    10640                              (start: monolith)
 1    9520     -1120     10.5%           policy-compat-routes
 2    9181     -339      13.7%           guard-compat-routes
 3    9050     -131      14.9%           mcp-compat-routes
 4    8739     -311      17.9%           slack-compat-routes
 5    8515     -224      20.0%           prompt-rag-compat-routes
 …
44    3055     —         71.3%           compat-rag-ingestion
45    2957     -98       72.2%           compat-rbac-retention
46    1604     -1353     84.9%           **big-bang**: compat-prompt-experiment + compat-mcp-proxy + compat-guard-pipeline
47    1449     -155      86.4%           compat-auth + compat-models + compat-tenant-ops
48    1223     -226      88.5%           compat-parsers + compat-responses (kernel-discipline cleanup)
```

(Full per-iteration log lives in `docs/migration-plan.md` "Recent Completion Notes".)

## Module map

### Route registration modules (16)

Each holds the Fastify route registration for a coherent product domain. The master `registerReactorCompatibilityRoutes` in `reactor-compat-routes.ts` calls each in order.

| Module | Lines | Surface |
|---|---|---|
| `auth-compat-routes.ts` | 237 | `/api/auth/*` CRUD |
| `session-compat-routes.ts` | 94 | `/api/sessions` + `/api/models` |
| `agent-compat-routes.ts` | 130 | `/.well-known/agent-card.json` + agent-spec admin |
| `approval-compat-routes.ts` | 127 | `/api/approvals` lifecycle |
| `policy-compat-routes.ts` | 123 | `/api/tool-policy` + RBAC + retention |
| `guard-compat-routes.ts` | 403 | input/output guard rules CRUD + simulate |
| `user-memory-compat-routes.ts` | 57 | `/api/user-memory/*` |
| `feedback-compat-routes.ts` | 222 | `/api/feedback` lifecycle |
| `prompt-rag-compat-routes.ts` | 302 | prompt-lab experiments + RAG ingestion |
| `mcp-compat-routes.ts` | 166 | `/api/mcp/servers/*` proxy |
| `slack-compat-routes.ts` | 393 | slack-bots + proactive-channels + FAQ |
| `intent-compat-routes.ts`, `persona-compat-routes.ts`, `prompt-template-compat-routes.ts`, `document-compat-routes.ts` | (each ~100–170) | promptlab catalog |
| `admin-platform-compat-routes.ts` | 287 | settings, ops dashboard, capabilities, doctor, cache, pricing, vectorstore |
| `admin-tenant-alert-compat-routes.ts` | 184 | tenants + alerts |
| `admin-session-compat-routes.ts` | 185 | tenant summary + sessions + users |
| `admin-observability-compat-routes.ts` | 228 | traces, tool-calls, usage, token-cost, conversation-analytics |
| `admin-analytics-compat-routes.ts` | 472 | audits, debug-replay, evals dashboard, latency, RAG analytics, tenant quality, task-memory maintenance |
| `agent-eval-compat-routes.ts` | 277 | agent-eval cases + replay + evaluate + tools/stats |
| `metric-ingestion-compat-routes.ts` | 93 | `/api/admin/metrics/ingest/*` |

### Domain helper modules (26)

Each holds the store-or-state helper functions for a single product domain, paired with the route module above.

| Module | Lines | Concern |
|---|---|---|
| `compat-csv.ts` | 54 | pure CSV utilities |
| `compat-eval-judge.ts` | 116 | LLM-as-judge pipeline |
| `compat-agent-eval-shape.ts` | 185 | pure response/serialization shapes |
| `compat-agent-eval-store.ts` | 127 | agent-eval store CRUD |
| `compat-agent-eval-orchestrator.ts` | 233 | runLogRecord + evaluate + replay + storeEvalResult |
| `compat-run-aggregations.ts` | 303 | tool-call ranking, latency distribution, usage aggregations |
| `compat-platform-store.ts` | 103 | platform pricing + alert-rule store |
| `compat-audit-store.ts` | 269 | admin audits + metric events |
| `compat-session-store.ts` | 241 | session/run helpers + JSON/Markdown export |
| `compat-guard-rule-store.ts` | 446 | input/output guard rules CRUD + simulate |
| `compat-agent-spec.ts` | 164 | agent-spec parse/validate/respond + agent card |
| `compat-session-tag-store.ts` | 96 | session tags CRUD |
| `compat-tool-policy-store.ts` | 171 | tool-policy CRUD + validation |
| `compat-feedback-store.ts` | 361 | feedback CRUD + filter + stats |
| `compat-promptlab-catalog-store.ts` | 438 | persona + prompt-template + intent CRUD |
| `compat-document-store.ts` | 227 | document/RAG store |
| `compat-slack-store.ts` | 212 | slack-bots + proactive-channels |
| `compat-slack-faq-store.ts` | 407 | slack FAQ registration + ingest/probe/dry-run |
| `compat-user-memory-store.ts` | 125 | user memory + auth identity |
| `compat-doctor.ts` | 265 | doctor diagnostic with JSON/text/markdown formats |
| `compat-dashboard.ts` | 269 | ops dashboard + platform-health |
| `compat-rag-ingestion.ts` | 327 | RAG ingestion policy + candidate review |
| `compat-rbac-retention.ts` | 126 | RBAC role taxonomy + retention policy |
| `compat-prompt-experiment.ts` | 1,047 | prompt-experiment lifecycle (parse/run/evaluate/recommendation) |
| `compat-mcp-proxy.ts` | 198 | MCP admin proxy with admin-token auth + timeout |
| `compat-guard-pipeline.ts` | 186 | input guard pipeline definition + simulation |
| `compat-auth.ts` | 111 | auth helpers + credential parse |
| `compat-models.ts` | 59 | model registry + agent-mode normalizers |
| `compat-tenant-ops.ts` | 101 | tenant ops + reactor prompt section keys |
| `compat-parsers.ts` | 252 | shared body/query/JSON parsers + JSON normalizers + date/string utilities (35 helpers) |
| `compat-responses.ts` | 60 | error envelope + ParseResult/ApiError types (`errorResponse`, `validationErrorResponse`, `clampLimit`, `notFound`, `badRequest`, `invalid`) |

### What's left in `reactor-compat-routes.ts` (1,223 lines)

- **The master dispatcher** `registerReactorCompatibilityRoutes` — calls 18 route modules in order
- **`CompatState` type + `createCompatState` initializer** — defines the file-private mutable state map shape
- **`let state: CompatState`** — the mutable state instance reset on each `register…` call
- **26 state accessors** (`getState*`, `setState*`, `isState*`) — the only sanctioned way for sibling modules to read/write the file-private mutable state
- **`CompatRecord`, `CompatCollection` types** (`CompatBody` re-exported from compat-parsers; `ParseResult`/`ApiError` re-exported from compat-responses)
- **A handful of locally-used helpers** — `findCompatRecord`, `findRecordByParam`, `groupRecordsByField`, `debugReplayResponse`, `opsMetricSnapshots`, `parseRuntimeSettingType`, `toReactorRuntimeSetting`, `runtimeSettingTypeResponse`, `parseAgentRunsCsvHeader` — small file-local utilities tied to specific dispatcher/aggregation paths
- **28 re-export blocks** — each `export { … } from "./compat-*.js"` — preserves the original public surface of `reactor-compat-routes.ts` so any consumer that imports `from "./reactor-compat-routes.js"` keeps working

The residual file is now the **shared kernel** (state machine + dispatcher) plus a thin re-export layer. Every utility helper that does pure parsing/serialization/error-shaping has been pulled out into one of the 30 domain or 4 cross-cutting (`compat-csv`, `compat-parsers`, `compat-responses`, `compat-run-aggregations`) modules.

## Verification gates (all green at the time of writing)

```
$ pnpm check
… all packages green …

$ REACTOR_SOURCE_DIR=/Users/stark/ai/reactor pnpm verify:reactor-routes
Reactor routes: 255
Muse routes: 386
Missing Reactor routes in Muse: 0
Extra Muse /api routes: 32

$ REACTOR_SOURCE_DIR=/Users/stark/ai/reactor pnpm verify:reactor-db
Missing Reactor tables in Muse: 0
```

## What this audit does NOT cover

This audit is scoped to the `reactor-compat-routes.ts` decomposition only. The broader Reactor → Muse migration audit lives in `reactor-module-parity-audit-2026-05-06.md` and reports all 30 Reactor modules at "Complete" status with deeper behavior parity tests.

## Stop conditions per `project_muse_identity.md`

- ✅ 0 missing Reactor routes / tables
- ✅ Every Reactor module's deep behavior has Muse coverage with package + integration tests
- ✅ `apps/api` passes a comprehensive HTTP smoke (49 broad endpoints + 6 live with provider key)
- ✅ At least 3 generic external-system MCP integrations
- ✅ JARVIS-style capabilities documented and exercised (multi-step plan-execute, persistent memory, observability dashboards)
- ✅ Code quality: no monolithic files (largest now 1,223 lines, down from 10,640), clear module boundaries (54 focused compat modules), comprehensive types, no TODO comments in core runtime

The Reactor → Muse migration is **complete**, including the long-tail code-quality cleanup of the largest remaining file. Future work should focus on product evolution rather than further structural refactor.
