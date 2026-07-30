# @muse/observability

Tracing, metrics, and cost/latency accounting for agent runs: span/trace sinks, the
`AgentMetrics` interface and its in-memory/derived/SLO-feeding implementations, token-usage and
token-cost recording, the startup doctor, and drift/budget/SLO detectors.

## Public surface

- `.` (`src/index.ts`) — `MuseTracer`/`SpanHandle`, `AgentMetrics` and its implementations
  (`InMemoryAgentMetrics`, `NoOpAgentMetrics`, `createDerivedAgentMetrics`,
  `createSloFeedingAgentMetrics`), the tracer kernel (`NoOpMuseTracer`, `InMemoryMuseTracer`,
  `PersistedMuseTracer`) and its `TraceEventSink` adapters (in-memory, Kysely, OpenTelemetry,
  Pino, Timescale), latency queries (`InMemoryLatencyQuery`, `KyselyLatencyQuery`), token-usage
  sinks and cost queries (`InMemoryTokenUsageSink`, `KyselyTokenUsageSink`,
  `KyselyTokenCostQuery`, `createBudgetTrackingTokenUsageSink`), local JSONL token-usage
  aggregation (`JsonlTokenUsageSink`, `aggregateTokenUsage`), `InMemoryFollowupSuggestionStore`,
  `StartupDoctor` and its cache/MCP checks, and the sliding-window detectors
  (`PromptDriftDetector`, `SloAlertEvaluator`, `MonthlyBudgetTracker`).

## Depends on

- `@muse/db` — Kysely-backed sinks (`KyselyTraceEventSink`, `KyselyTokenUsageSink`, etc.) read
  and write through the shared `MuseDatabase` schema.
- `@muse/model` — token-usage records are typed against `ModelUsage`.
- `@muse/shared` — `JsonObject` and other base primitives.

## Rules that bind this package

- Every Kysely-backed sink has an in-memory counterpart so a caller without PostgreSQL still
  runs, per `../../.claude/rules/architecture.md`'s database rules.
- No provider-specific assumptions belong here — `MuseTracer`/`AgentMetrics` stay
  vendor-neutral per `../../.claude/rules/architecture.md`.

## Tests

`pnpm --filter @muse/observability test`
