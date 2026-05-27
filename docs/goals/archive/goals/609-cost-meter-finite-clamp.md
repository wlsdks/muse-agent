# 609 — `estimateCostUsd` clamps non-finite token counts to 0 so a single corrupt provider usage payload can't poison every downstream cost rollup with NaN / Infinity

## Why

`packages/cache/src/index.ts:estimateCostUsd` converts
`(model, inputTokens, outputTokens)` into a billed-cost figure
that downstream components (budget meters, the status command,
per-session telemetry, observability dashboards) sum across
calls. Pre-fix:

```ts
return Math.max(0, inputTokens) * inputRate + Math.max(0, outputTokens) * outputRate;
```

`Math.max(0, NaN)` returns `NaN`. `Math.max(0, Infinity)` returns
`Infinity`. JS arithmetic propagates both: `NaN * x === NaN`,
`Infinity * x === Infinity`, `NaN + x === NaN`. So a single call
where the provider returned a non-finite token count (a math
overflow, a parse glitch, a mocked fixture, a billing-side anomaly
in a 3p adapter) makes `estimateCostUsd` return NaN/Infinity. The
running cost total `runningTotal += estimateCostUsd(...)` becomes
non-finite and stays that way for the lifetime of the process —
every subsequent finite cost gets absorbed into the poisoned
total.

The same finite-guard posture goal 595/596 set on constructor
configurators (`InMemoryResponseCache.maxSize/ttlMs`,
`InMemoryContextReferenceStore`) applies here: defend at the
boundary where untrusted numeric input enters a multiplicative
chain.

Step-8 redirect: not boolean-spelling, not 0o600, not timeout,
not regex-coverage, not Invalid-Date, not CLI empty-id, not
memory-cap, not dedup-parity, not BOM-tolerance, not state-
transition observability, not integer-precision. Defect family
overlaps with 595/596 (finite-guard) but on a fresh surface — a
public exported pure function whose output flows into long-lived
running totals, not a one-time constructor configurator. The
threat shape is "every subsequent call's cost gets poisoned by
this one bad call," which is qualitatively different from "a
single misconfigured constructor disables a bound."

## Slice

- `packages/cache/src/index.ts:estimateCostUsd`:
  - Replaced the inline `Math.max(0, inputTokens) * inputRate +
    Math.max(0, outputTokens) * outputRate` with a two-line
    pre-clamp:
    ```ts
    const safeInput = Number.isFinite(inputTokens) ? Math.max(0, inputTokens) : 0;
    const safeOutput = Number.isFinite(outputTokens) ? Math.max(0, outputTokens) : 0;
    return safeInput * inputRate + safeOutput * outputRate;
    ```
  - Each side is clamped independently: NaN inputTokens kills
    the input contribution but lets a finite output side still
    bill correctly. The result is always finite.
  - Short WHY comment on the threat model.
- `packages/cache/test/cache.test.ts`:
  - One new test in the `cache metrics` describe. Asserts:
    - `estimateCostUsd("gpt-4o-mini", NaN, 1_000)` returns the
      finite output-only cost (input contribution dropped to 0).
    - `Infinity` is handled the same way.
    - Both sides bad → cost is exactly 0.
    - The matrix `[NaN, NaN]`, `[1_000, NaN]`,
      `[Infinity, -Infinity]` — every result is `Number.isFinite`.
      Pinning the *finiteness* property is the load-bearing
      invariant for any downstream that sums.

## Verify

- `@muse/cache` suite green (15 passed, +1 vs baseline 14, 0
  failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the
  finite-clamp back to the bare `Math.max(0, ...)` shape makes
  the new test fail with `expected NaN to be close to 0.0006` —
  exactly the symptom documented above (the NaN propagates
  through the multiplication and poisons the result).
- `pnpm check` EXIT=0 (apps/api 258 passed, apps/cli 1041
  passed, every workspace green); `pnpm lint` 0/0; `pnpm
  guard:core` clean; byte-scan clean on both touched files;
  `git status` shows only the two intended files plus this
  goal doc.
- No LLM request-response wire path touched; `smoke:live`
  does not apply. `estimateCostUsd` is a pure cost-arithmetic
  helper invoked by metrics/budget consumers, not the model
  loop itself.

## Status

Done. The cost-arithmetic helper's output is now provably
finite regardless of input:

| Inputs                              | Before                          | After                  |
| ----------------------------------- | ------------------------------- | ---------------------- |
| `(1_000, 1_000)`                    | finite cost                     | unchanged              |
| `(0, 0)`                            | 0                               | unchanged              |
| `(NaN, 1_000)`                      | **NaN** (poisons rollup)        | output-only cost       |
| `(Infinity, 1_000)`                 | **Infinity** (poisons rollup)   | output-only cost       |
| `(NaN, NaN)`                        | **NaN**                         | 0                      |
| `(-Infinity, +Infinity)`            | **NaN** (mixed sign × 0 etc.)   | 0                      |
| local provider (ollama/lmstudio)    | 0 (unchanged, early-return)     | unchanged              |

No CAPABILITIES line / no OUTWARD-TARGETS flip: a robustness /
input-validation `fix:` on the cost-arithmetic helper, recorded
honestly with this backlog row — not a false metric.

## Decisions

- **Clamp each side independently** rather than "if either is
  bad, return 0." A NaN input shouldn't erase a perfectly valid
  output cost — billing the output side is more accurate than
  silently dropping the call entirely.
- **`Number.isFinite`, not `!Number.isNaN`.** `isFinite` rejects
  both NaN and ±Infinity. `!isNaN(Infinity)` returns true,
  which would still let Infinity propagate. The threat model
  covers both — `isFinite` is the correct gate.
- **Pre-clamp, not post-clamp.** Returning
  `Number.isFinite(result) ? result : 0` after the multiplication
  would also work, but loses information about WHICH side was
  bad. With per-side clamping, an output-only finite cost
  survives a NaN input. Same compute cost, more useful
  semantics.
- **No new exported helper.** The two-line guard is local to
  the one call site. If a third consumer in the cost path
  needs the same clamp, extract `safeTokenCount(value)` then —
  premature here.
- **Test extends the existing `cache metrics` block.** That
  block already pins `estimateCostUsd`'s pricing math and
  local-provider short-circuit. The finite-clamp invariant is
  a natural extension of the same contract.
- **Mutation choice.** Reverted exactly the relevant lines
  back to the bare `Math.max(0, ...)` shape. The mutation
  reproduces the pre-fix shape — the realistic regression a
  maintainer might write while "simplifying back to the
  one-liner because the clamp seems redundant after Math.max."
- **Property assertion in the matrix.** The for-loop over
  `[[NaN, NaN], [1_000, NaN], [Infinity, -Infinity]]` pins the
  general invariant "the output is finite for any pathological
  numeric input." A future regression that handles SOME
  non-finite cases but not others would still fail this loop.

## Remaining risks

- **`inputRate` / `outputRate` themselves** could become
  non-finite if a future maintainer accidentally divides by a
  zero pricing parameter. The `defaultPricing` and
  `modelPricingEntries` constants are all hard-coded finite
  literals today; this would require active sabotage. Out of
  scope.
- **`Math.max(0, ...)`** only clamps negatives; it doesn't
  reject negative-zero (which is a finite, valid token count
  semantically). `-0 * rate === -0`, which serializes as `0`.
  Cosmetic only.
- **Aggregate rollup overflow** — summing many real finite
  costs could eventually exceed `Number.MAX_VALUE` and return
  `Infinity`. Realistic only for a multi-year-running process
  with very high token volume. Different defect class (sum
  bound vs single-call clamp); separate iteration if it
  becomes load-bearing.
- **Token-count Number vs BigInt** — providers that return
  integer counts > `2^53` (unlikely but possible for usage
  totals across long sessions) would lose precision in the
  Number type. Same family as goal 608; out of scope here.
