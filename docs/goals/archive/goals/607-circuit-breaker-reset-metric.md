# 607 — `DefaultCircuitBreaker.reset()` routes through `transition()` so a manual operator clear of a tripped breaker fires the state-change recorder (was silently bypassing metrics, breaking observability)

## Why

`packages/resilience/src/index.ts:DefaultCircuitBreaker.reset()`
is the manual operator escape hatch — an admin endpoint, a
recovery script, an in-process supervisor that decides "we know
this provider is healthy now, clear the breaker." Pre-fix:

```ts
reset(): void {
  this.currentState = "closed";
  this.consecutiveFailures = 0;
  this.successes = 0;
  this.halfOpenCalls = 0;
  this.lastFailure = undefined;
  this.openedAt = 0;
}
```

`currentState` is assigned directly. Every other state change in
the file (`onSuccess` closing from half_open, `onFailure` opening,
`evaluateState` opening → half_open) goes through `transition()`:

```ts
private transition(to: CircuitBreakerState): void {
  const from = this.currentState;
  if (from === to) {
    return;
  }
  this.currentState = to;
  this.metricsRecorder.recordCircuitBreakerStateChange?.(this.name, from, to);
}
```

`transition()` is the single place that fires the metrics
recorder. `reset()` bypassed it. So when an operator manually
cleared a tripped breaker, the metrics consumer (observability
dashboard, alerting wired off state-change events) saw a
"closed → open" event with no matching "open → closed" event —
permanently dangling, even though the breaker was actually
serving traffic again. Manual interventions silently disappeared
from telemetry.

Step-8 redirect: not finite-guard (595/596), not 0o600 (598/599),
not boolean-spelling (585/587/597), not timeout (600), not regex-
coverage (601), not Invalid-Date (602), not CLI empty-id (603),
not memory-cap (604), not dedup-parity (605), not BOM-tolerance
(606). Defect class is "observability completeness — state
mutation that bypasses the established notification seam" —
fresh.

## Slice

- `packages/resilience/src/index.ts:DefaultCircuitBreaker.reset`:
  - Reordered the body: zero the counters / timestamps first,
    then call `this.transition("closed")` last so the recorder
    observes a consistent zeroed state. Removed the direct
    `this.currentState = "closed"` assignment.
  - `transition()`'s `if (from === to) return;` early-return
    means a no-op reset (clearing an already-closed breaker)
    stays silent — operators sweeping the registry for
    safety don't pollute metrics.
- `packages/resilience/test/resilience.test.ts`:
  - One new test in the `DefaultCircuitBreaker` describe.
    Trips a `failureThreshold: 1` breaker named `llm:openai`,
    asserts `transitions === ["llm:openai:closed->open"]`. Calls
    `reset()`. Asserts `transitions === ["llm:openai:closed->open",
    "llm:openai:open->closed"]`. Calls `reset()` a second
    time on the already-closed breaker. Asserts the array is
    unchanged (no spurious `closed->closed` event).
- `docs/goals/606-skill-parser-bom-tolerance.md`:
  - Drive-by hygiene fix. The prior iteration's doc contained
    8 literal U+FEFF bytes (where I was naming the BOM
    character in prose). The `packages/shared`
    `repo-byte-hygiene` test (goal-227) flags these as
    forbidden — the BOM is a real invisible-char hazard and
    must appear only as a textual notation, not a raw byte.
    Replaced every literal occurrence with the textual
    `U+FEFF` notation. Same iteration because the
    regression came from prior-iter work in the same
    package family; bundling the doc cleanup keeps the loop
    honest about not leaving a known-broken tree behind.

## Verify

- `@muse/resilience` suite green (21 passed, +1 vs baseline 20,
  0 failed); tsc strict EXIT=0.
- `@muse/shared` suite green (18 passed, byte-hygiene test
  back to green from its pre-fix failure on doc 606).
- **Clean-mutation-proven** (Edit-based): reverting `reset()` to
  the direct-assignment shape makes the new "reset() on an open
  breaker" test fail with the missing `llm:openai:open->closed`
  entry — exactly the observability gap documented above. Fix
  restored, suite back to 21/21.
- `pnpm check` EXIT=0 (apps/api 258 passed, apps/cli 1041
  passed, every workspace green); `pnpm lint` 0/0; `pnpm
  guard:core` clean; byte-scan clean across both touched src
  files AND the cleaned-up doc 606.
- No LLM request-response wire path touched; `smoke:live`
  does not apply. Circuit-breaker reset is an in-process
  control plane operation, not HTTP surface.

## Status

Done. State-change observability is now complete across every
mutation path:

| Mutation path                           | Before                                | After                       |
| --------------------------------------- | ------------------------------------- | --------------------------- |
| closed → open (`onFailure`)             | recorded                              | unchanged                   |
| open → half_open (`evaluateState`)      | recorded                              | unchanged                   |
| half_open → closed (`onSuccess`)        | recorded                              | unchanged                   |
| half_open → open (`onFailure`)          | recorded                              | unchanged                   |
| **manual reset (any → closed)**         | **silent — bypassed `transition()`**  | recorded (**fixed**)        |
| no-op reset (closed → closed)           | silent                                | unchanged (still silent)    |

No CAPABILITIES line / no OUTWARD-TARGETS flip: a robustness /
observability completeness `fix:` on the circuit-breaker
primitive, recorded honestly with this backlog row — not a
false metric.

## Decisions

- **Route `reset()` through `transition()`, not duplicate the
  recorder call inline.** The transition method is already the
  documented single seam for "currentState changes, tell the
  recorder." Inlining the recorder call would create two paths
  to the same invariant — and a future maintainer adding a new
  side-effect to `transition()` would have to remember to
  duplicate it in `reset()`. One seam is the simpler contract.
- **Counter-zeroing happens BEFORE `transition()`.** Order
  matters for an observability consumer that inspects breaker
  state inside the recorder callback. If counters were
  non-zero at the moment the recorder fires, a dashboard
  could record "open → closed with failureCount=5" — a
  contradiction. Zeroing first means the recorder sees a
  fully-consistent post-reset snapshot.
- **No-op `reset()` stays silent** thanks to `transition()`'s
  `from === to` early-return. An operator periodically calling
  `registry.resetAll()` as a safety sweep doesn't generate a
  flood of `closed->closed` no-ops in the metrics stream.
- **Mutation choice.** Reverted exactly the two relevant lines
  (the direct `currentState = "closed"` assignment vs the
  `this.transition("closed")` call). The mutation reproduces the
  pre-fix shape — the realistic regression a maintainer might
  re-introduce while "inlining the reset for clarity."
- **Doc-606 byte cleanup bundled in.** Strictly two changes per
  iter is normally a smell, but the doc fix is a one-line
  follow-up to MY OWN prior iteration that's currently
  breaking `pnpm check`. Step 1 of the iteration-loop contract
  says "If dirty from an interrupted iter, restoring a clean
  tree IS this iteration" — the regression I introduced is
  exactly that situation. Bundling the cleanup with substantive
  forward progress (the reset() fix) keeps the loop honest
  about not regressing and avoids a thin "doc-only" commit.

## Remaining risks

- **`CircuitBreakerRegistry.evictOverflow`** (line 303-313)
  silently removes breakers from the LRU cache without
  notifying the recorder. An evicted breaker that was open
  would similarly disappear from observability. Different
  concern (eviction is not a state change on the breaker
  itself), separate iteration.
- **`successes` counter is not reset by `transition()`.** Only
  the explicit `reset()` zeroes the cumulative success count.
  That's the documented "cumulative across all closed-state
  successes" semantic — it intentionally survives state
  transitions. Out of scope; mentioned only so a future
  reader doesn't mistake it for a parallel gap.
- **No metric for `resetAll()` per-breaker calls.** The
  registry-level sweep calls `reset()` on each cached breaker
  — each call now fires the recorder once, so a sweep on a
  500-breaker registry would emit up to 500 events. That's
  the correct semantic ("each breaker individually
  transitioned"), but a future iter could add a registry-level
  `recordResetAll(count)` if the per-breaker volume becomes
  noisy in practice.
