# 610 — `SloAlertEvaluator` validates `minSamples` at construction so NaN / Infinity can't silently disable the sample-floor gate and fire spurious alerts on under-populated windows

## Why

`packages/observability/src/observability-detectors.ts:SloAlertEvaluator`
is the rolling-window P95 latency + error-rate alerting primitive
that the runtime decorates `AgentMetrics.recordAgentRun` with. The
constructor validates `latencyThresholdMs`, `errorRateThreshold`,
`windowSeconds`, `cooldownSeconds` — but NOT `minSamples`:

```ts
this.#minSamples = Math.max(1, options.minSamples ?? 5);
```

`?? 5` doesn't catch NaN / Infinity (`NaN ?? 5 === NaN`). Then
`Math.max(1, NaN) === NaN`. The downstream guard at line 365:

```ts
if (this.#latencies.length < this.#minSamples) {
  return undefined;
}
```

`latencies.length < NaN` is always `false`. The sample-floor gate
is silently disabled — every evaluation proceeds even when only
one or two latency samples have been recorded. The detector
fires an alert on a P95 derived from a single sample, which is
statistically meaningless and operationally noisy.

The sibling `PromptDriftDetector` in the same file (line 177-179)
already throws on invalid `minSamples`:

```ts
if (!Number.isFinite(minSamples) || minSamples <= 0) {
  throw new Error("PromptDriftDetector minSamples must be positive");
}
```

SLO carries the same configurator semantically but missed the
same guard.

Step-8 redirect: this iteration's defect class is "construction-
time validation of a configurator option that the established
sibling class already validates" — a parity / consistency gap,
not a primary finite-guard. Last in-family was goal 609 (finite-
clamp on a public exported helper); this is a different surface
(constructor validation throw vs runtime-arithmetic clamp).
Recent 10 iters: 609 (finite-clamp), 608 (integer precision),
607 (state observability), 606 (BOM), 605 (dedup), 604 (memory
cap), 603 (CLI), 602 (Invalid-Date), 601 (regex), 600 (timeout)
— only 609 is adjacent; this is the 2nd finite-related fix in
last 10, safely under the Step-8 threshold.

## Slice

- `packages/observability/src/observability-detectors.ts:SloAlertEvaluator`:
  - Added a fifth construction-time check, mirroring the
    existing four (latencyThresholdMs / errorRateThreshold /
    windowSeconds / cooldownSeconds):
    ```ts
    if (
      options.minSamples !== undefined
      && (!Number.isFinite(options.minSamples) || options.minSamples <= 0)
    ) {
      throw new Error("SloAlertEvaluator minSamples must be positive");
    }
    ```
  - `options.minSamples !== undefined` lets the default path
    (5) still flow through unchanged. An explicit
    `minSamples: 0` / `-1` / `NaN` / `Infinity` throws with a
    clear message at construction, instead of silently
    poisoning evaluation.
  - The `Math.max(1, options.minSamples ?? 5)` line is
    untouched — it stays as the "floor at 1" safety net for
    the default-5 path (which is already > 1, so the floor is
    only active if someone passes a future positive < 1
    fraction).
- `packages/observability/test/observability.test.ts`:
  - One new test in the `SloAlertEvaluator` describe. Loops
    over `[NaN, Infinity, 0, -1]` and asserts each throws
    with the exact "must be positive" message. Then asserts
    the default (no minSamples) and an explicit positive
    (`minSamples: 10`) construction both succeed.

## Verify

- `@muse/observability` suite green (77 passed, +1 vs baseline
  76, 0 failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): removing the new
  validation block makes the test fail with
  `expected throw for minSamples=NaN: expected [Function] to throw
  an error` — exactly the silent-acceptance symptom documented
  above (NaN passes through, no throw, the constructor returns
  an evaluator with a NaN sample floor).
- `pnpm check` EXIT=0 (apps/api 258 passed, apps/cli 1041
  passed, every workspace green); `pnpm lint` 0/0; `pnpm
  guard:core` clean; byte-scan clean on both touched files;
  `git status` shows only the two intended files plus this
  goal doc.
- No LLM request-response wire path touched; `smoke:live` does
  not apply. SloAlertEvaluator is an in-process derived-metric
  fan-out target, not HTTP surface.

## Status

Done. Constructor validation is now consistent across every
numeric option in the SLO evaluator AND parallel with the
sibling `PromptDriftDetector` in the same file:

| Option                  | Before                                  | After                       |
| ----------------------- | --------------------------------------- | --------------------------- |
| `latencyThresholdMs`    | throws on non-finite / negative         | unchanged                   |
| `errorRateThreshold`    | throws on out-of-range [0, 1]           | unchanged                   |
| `windowSeconds`         | throws on non-finite / non-positive     | unchanged                   |
| `cooldownSeconds`       | throws on non-finite / negative         | unchanged                   |
| **`minSamples`**        | **silently NaN-poisoned**               | throws on invalid (**fixed**) |

No CAPABILITIES line / no OUTWARD-TARGETS flip: a robustness /
constructor-validation parity `fix:`, recorded honestly with
this backlog row — not a false metric.

## Decisions

- **Throw, not silently default.** The four sibling checks
  in the same constructor throw; matching the established
  pattern keeps the contract uniform. A silent default would
  be a half-fix — operators wouldn't see their misconfigured
  knob, just the wrong behavior downstream. Fail-fast at
  construction time is the right posture for a derived-metric
  that runs hot in production.
- **`!== undefined` first, then validate.** Lets the default
  path (omit `minSamples` entirely → defaults to 5) flow
  through unchanged. Only explicit invalid values throw. This
  matches how `PromptDriftDetector` handles it implicitly
  (its `??` then validate flow), translated to the SLO
  evaluator's typed-as-optional shape.
- **Keep `Math.max(1, options.minSamples ?? 5)`.** With the
  upstream throw, the `Math.max(1, ...)` is now defending
  against… nothing reachable. But removing it would change
  the apparent invariant ("minSamples is at least 1") at the
  field, and a future maintainer adding a default-overriding
  branch could re-introduce the bug. Three tokens kept; the
  defensive intent stays legible.
- **Same exact error-message style** as `PromptDriftDetector`
  ("X must be positive"), so an operator hitting both
  detectors with the same misconfiguration sees parallel
  error messages.
- **Test fixture reuses the existing block's base options.**
  Doesn't introduce a new describe — the SLO block already
  pins the constructor's existing throws implicitly (every
  test happy-paths through it). Adding a focused negative-case
  test alongside the existing positives is the smallest
  expansion.
- **Mutation choice.** Reverted exactly the four-line block
  that gates the throw. The mutation reproduces the pre-fix
  shape — the realistic regression a maintainer might
  introduce while "tidying up the constructor; the
  Math.max(1, ...) already handles it." That comment would
  be wrong (Math.max(1, NaN) is NaN), and the mutation test
  catches it.

## Remaining risks

- **`createDerivedAgentMetrics.recordTokenUsage`** (in
  observability-agent-metrics.ts:124-130) passes
  `usage.inputTokens` / `usage.outputTokens` to the drift
  detector with `typeof === "number"` only — that accepts
  NaN/Infinity. The drift detector then finite-guards (line
  187, 197), so the bad value is dropped — but the guard
  lives inside the recipient rather than the dispatcher.
  Defense-in-depth at both layers would be tighter; out of
  scope here.
- **`#evictExpired`** logic uses `at < now - windowMs`. With
  a NaN `at` (impossible today since `recordLatency` finite-
  guards), the eviction would never fire. Out of scope.
- **Same-file `MonthlyBudgetTracker`** wasn't audited for
  matching constructor validation. If its options accept
  non-finite values silently, the same parity argument would
  apply — separate iteration if a real concern surfaces.
