# 646 — `InMemoryAgentMetrics` applies a FIFO `maxEntries` cap (default 10,000) so a long-running dogfood / dev process with no DB-backed metrics store can't leak unbounded memory by accumulating every `recordAgentRun` / `recordTokenUsage` / `recordGuardRejection` / `recordOutputGuardAction` event forever

## Why

`packages/observability/src/observability-agent-metrics.ts:InMemoryAgentMetrics`
was the in-memory fallback for the AgentMetrics surface — used
when no DB-backed sink is wired (dev mode, autoconfigure
fallback, every vitest run). Pre-fix:

```ts
export class InMemoryAgentMetrics implements AgentMetrics {
  private readonly events: RecordedMetricEvent[] = [];

  recordAgentRun(event)      { this.events.push({ payload: ..., type: "agent_run" }); }
  recordGuardRejection(...)  { this.events.push({ payload: ..., type: "guard_rejection" }); }
  recordOutputGuardAction(.) { this.events.push({ payload: ..., type: "output_guard_action" }); }
  recordTokenUsage(...)      { this.events.push({ payload: ..., type: "token_usage" }); }
  // …
}
```

FOUR push sites, ZERO eviction. Every agent run, every guard
rejection, every token-usage record grows the array
monotonically. The class has NO `clear()`, NO TTL, NO cap.

### Reachability

- **Default autoconfigure**: when no Postgres / Kysely metrics
  sink is configured, autoconfigure wires
  `new InMemoryAgentMetrics()` as the production fallback.
  A dogfood machine running Muse for days / weeks without a DB
  accumulates a record per agent run + per guard event + per
  token-usage report.
- **Per-run memory pressure**: a typical agent run produces
  3-5 events (recordAgentRun + recordTokenUsage + 0-3 guard
  events). At ~500 bytes JSON-encoded per event, 100 runs/day
  = ~2.5 MB/day = ~75 MB/month = ~900 MB/year.
- **Test envs**: every vitest worker that constructs an
  `InMemoryAgentMetrics` accumulates events for the test's
  lifetime. Bounded by test scope (the instance is GC'd at
  end of test), so not catastrophic — but still a slow leak
  in long-running watch-mode runs.

### Sibling stores ALL have caps

| Class                                  | Cap mechanism                  |
| -------------------------------------- | ------------------------------ |
| `InMemoryAgentMessageBus`              | `maxSubscribers` (1000)        |
| `CircuitBreakerRegistry`               | `maxBreakers` (defaultMaxBreakers) |
| `InMemoryScheduledJobStore`            | `maxJobs` (1000)               |
| `InMemoryScheduledJobExecutionStore`   | `maxEntries` (200)             |
| `InMemoryDebugReplayCaptureStore`      | — (no cap, but TTL via purgeExpired) |
| `InMemoryResponseCache`                | `maxSize` (1000) + TTL          |
| `InMemoryUserStore`                    | `maxUsers` (defaultMaxUsers)   |
| `InMemoryRuntimeSettingsStore`         | unbounded (small KV, OK)       |
| **`InMemoryAgentMetrics`**             | **NONE**                       |

`InMemoryAgentMetrics` was the missed sibling.

### Defect class

**Unbounded in-memory array growth — missing FIFO cap on a
diagnostic-collector class that gets wired by default when
no DB is configured**. Fresh against the recent window:

- 645: file-mode 0o600
- 644: finite-guard (data destruction)
- 643: strict int-parse on HTTP query params
- 642: stream error listener (read side)
- 641: cacheTtlMs finite-guard
- 640: word-boundary keyword matching
- 639: keyword dedup
- 638: lenient base64url decode (auth)
- 637: lenient base64 decode (loopback)
- 636: HTTP timeout

Unbounded-growth / memory-leak hasn't been touched. Closest
sibling is goal 619 (RuleBasedAgentWorker constructor
filtered blank keywords) — also about preventing accumulation
of useless state — but the defect surface is completely
different.

## Slice

- `packages/observability/src/observability-agent-metrics.ts:InMemoryAgentMetrics`:
  - New exported `InMemoryAgentMetricsOptions` interface with
    `maxEntries?: number`. Default 10,000.
  - Constructor: extracts `raw = options.maxEntries ?? 10_000`,
    then `Number.isFinite(raw) && raw > 0 ?
    Math.max(1, Math.trunc(raw)) : 10_000`. Falls back to
    default on NaN / Infinity / 0 / negative (same posture
    as goal 641's cacheTtlMs guard).
  - All four `push` sites factored through a private
    `append(event)` method that performs the push AND the
    FIFO eviction (`splice(0, length - maxEntries)`).
  - `recordedEvents()` and the four `record*` methods'
    behavior is unchanged on the happy path.
- `packages/observability/test/observability.test.ts`:
  - Three new tests in the existing `AgentMetrics` describe:
    1. **FIFO eviction on cap exceeded** — `maxEntries: 3`,
       push 5 `recordAgentRun` events with distinct `runId`s,
       assert the first two evicted (only `r-3`, `r-4`, `r-5`
       remain in insertion order).
    2. **Mixed event types share the cap** — `maxEntries: 2`,
       push one of EACH event type (agent_run + guard_rejection
       + output_guard_action + token_usage). After 4 pushes
       with cap 2, only the last 2 (`output_guard_action` +
       `token_usage`) remain. Pins that the cap is shared
       across all four push sites.
    3. **Fallback to default on poison cap** — iterate
       `[NaN, Infinity, 0, -1]`, construct a fresh instance
       for each, push one record, assert it survives. Pins
       the finite-guard branch.

## Verify

- `@muse/observability` suite green (83 passed, +3 vs the
  pre-iter baseline of 80, 0 failed).
- **Clean-mutation-proven** (Edit-based): reverting the
  `append` method body back to bare `this.events.push(event)`
  (removing the eviction lines) makes EXACTLY two of the
  three new tests fail with the literal symptom — 5 events
  retained instead of 3 (FIFO eviction test), 4 events
  retained instead of 2 (mixed-types test). The fallback-
  default test passes both pre- and post-fix because a
  single record fits any positive cap (and the pre-fix
  unbounded behavior also retains 1 record).
- `pnpm check` green: apps/api 270/270, apps/cli 1101/1101,
  every workspace; tsc strict EXIT=0.
- `pnpm lint` 0/0, `pnpm guard:core` clean, byte-scan clean.
- No LLM request/response wire path touched. `smoke:live`
  doesn't apply.

## Status

Done. The InMemory metrics sink is now bounded, matching
every sibling InMemory-fallback class in the codebase:

| Push count vs cap          | Before                         | After                       |
| -------------------------- | ------------------------------ | --------------------------- |
| 50 pushes, cap=10,000      | 50 retained                    | unchanged                   |
| 10,000 pushes, cap=10,000  | 10,000 retained                | unchanged                   |
| **10,001 pushes, cap=10,000** | **10,001** (unbounded growth) | **10,000** (FIFO, oldest dropped) |
| 5 pushes, cap=3            | **5** (cap ignored)            | **3** (oldest 2 dropped)    |
| Push with NaN cap          | unbounded                      | falls to 10,000 default     |
| Push with Infinity cap     | unbounded                      | falls to 10,000 default     |
| Push with 0 / -1 cap       | unbounded                      | falls to 10,000 default     |

No CAPABILITIES line / no OUTWARD-TARGETS flip: a robustness
/ unbounded-growth `fix:` on the dev-fallback metrics sink.
Recorded honestly with this backlog row.

## Decisions

- **Default 10,000 entries**. At ~500 bytes/event JSON-
  encoded, this is ~5 MB upper bound — survivable for
  dogfood, generous for tests. Matches the order of magnitude
  the sibling caps use (1000 for breakers/messages, 200 for
  scheduled job executions, 500 for episodes).
- **FIFO eviction via `splice`** rather than `shift`-loop.
  `shift()` is O(n) per call; `splice(0, delta)` is one O(n)
  operation when overflow occurs. For typical workloads
  overflow is rare (cap is 10k); the splice cost amortises.
- **`append()` private method** factors the eviction so
  every push site shares the same logic. A future record-
  type addition (e.g. `recordSpanLatency`) just calls
  `this.append(...)` and inherits the cap.
- **Finite-guard fallback** for NaN / Infinity / 0 / negative
  cap (same family as goals 608 / 641 / 644). Defense
  against operator typos / corrupt configs / unit-slipped
  options. Less critical than 644's data-destruction case
  here, but consistent with the established posture.
- **`Math.max(1, Math.trunc(raw))`** for valid input. The
  `Math.max(1, …)` ensures a poison `0.5` doesn't truncate
  to 0 and disable the cap; the Math.trunc handles
  fractional caps cleanly.
- **No TTL** on this cap. Operations that ARE time-bounded
  (cache, response cache) use TTL; metrics events have no
  natural expiry and are useful for retrospective inspection.
  FIFO matches the "show me the last N events" diagnostic
  use case.
- **Did NOT add `recordedEvents(limit?: number)`** to allow
  callers to ask for the last N events. Out of scope; the
  current `recordedEvents()` returns the full retained
  window, which is now safely bounded.
- **Mutation choice.** Reverted only the eviction lines in
  the private `append` method. Two of three new tests fail
  with the literal symptom (5 retained vs 3, 4 retained vs
  2). The third passes pre- and post-fix because it tests
  the finite-guard fallback, which doesn't depend on the
  eviction loop.

## Remaining risks

- **Other unbounded `push` sites** in the observability
  package: `InMemoryMuseTracer.spans`, `InMemoryTraceEventSink.events`,
  `InMemoryTokenUsageSink.#events`, `PromptDriftDetector`'s
  windowed arrays (these have their own `windowSize` cap,
  actually — checked: PromptDriftDetector at line 200-203
  does `while (length > windowSize) shift()`, OK).
  - `InMemoryMuseTracer.spans` — accumulates every span.
    Used in tests primarily, not autoconfigure default.
  - `InMemoryTraceEventSink.events` — same.
  - `InMemoryTokenUsageSink.#events` — wired by autoconfigure
    as fallback. Same defect class as this fix; sibling
    iter could apply the same cap pattern.
- **Other sibling InMemory stores** — `InMemoryAgentMessageBus.allMessages`
  is documented as "expected to call clear() at supervisor
  exit." That's a contract the user is expected to honor;
  this fix doesn't change that.
- **10,000-entry cap may be too low** for a heavy multi-
  user dogfood instance. Operator can override via
  `new InMemoryAgentMetrics({ maxEntries: N })` — but no
  CLI / env knob currently wires this through. A future
  `MUSE_METRICS_INMEMORY_CAP` env var would close that
  gap.
- **Memory footprint of each event** is unbounded — a
  guard rejection's `metadata: JsonObject` could be a
  large nested object. The cap bounds entry COUNT but not
  per-entry size. Out of scope for this iter; the
  upstream metric emitters are responsible for bounding
  per-event payload.
