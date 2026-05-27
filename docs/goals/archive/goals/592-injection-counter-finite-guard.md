# 592 — `InMemoryInjectionDetectionCounter.bumpFrom` rejects non-finite counts (NaN / Infinity) so a buggy detector can't poison the family bucket or the rollup `total`; also stops `lastFiredAt` from advancing when every finding in a batch is skipped

## Why

`packages/policy/src/injection-detection-counter.ts:bumpFrom` is the
single-source-of-truth aggregator for prompt-injection detection
counts. Every guard firing flows through it; operator dashboards
and structured logs read `snapshot().counts` and `snapshot().total`
to surface "history-poisoning fired 47× this week" instead of
zero-signal blocks.

The pre-fix guard:

```ts
for (const finding of findings) {
  if (!finding.name || finding.count <= 0) continue;
  const prev = this.counts.get(finding.name) ?? 0;
  this.counts.set(finding.name, prev + finding.count);
}
this.lastFiredAt = this.now().toISOString();
```

Two real defects in one pass:

1. **NaN / Infinity poisoning.** `finding.count <= 0` returns
   `false` for `Number.NaN` (any comparison with NaN is false)
   and `false` for `Number.POSITIVE_INFINITY`. So a buggy
   detector emitting a non-finite count slipped through:

   - `prev + Number.NaN === Number.NaN` → the family bucket
     becomes NaN permanently.
   - The rollup `total = sum(counts)` then becomes NaN too.
   - Every subsequent `snapshot()` returns `total: NaN`, and the
     dashboard renders `"NaN"` (or worse, crashes the JSON
     consumer on `JSON.stringify(NaN)` → `null`, hiding the
     compromise).

   Same defect class as the scheduler / token-cost finite-guards
   (goals 561 / 562 / 579) — `??` and `<=` don't catch non-finite,
   `Number.isFinite` does.

2. **`lastFiredAt` advances on all-skipped batches.** The clock
   bumped unconditionally whenever `findings.length > 0`, even
   if EVERY finding was rejected (empty name, zero / negative
   count, now NaN / Infinity). So a batch of all-invalid
   findings made the operator think "the counter just fired"
   when nothing actually moved.

Step-8 redirect: in `packages/policy` (last touched in goal 578
for the byGuard tiebreaker), distinct defect class from the
prior commits (NaN-poisoning on a numerical counter + truthful
"did anything actually happen" gate, neither boolean-spelling
nor tiebreaker nor strict-parse).

## Slice

- `packages/policy/src/injection-detection-counter.ts:bumpFrom`:
  - Add `!Number.isFinite(finding.count)` to the skip-guard
    expression alongside the existing `!finding.name` and
    `<= 0` checks.
  - Track `let appliedAny = false` and set it `true` only when
    a finding actually mutates the bucket. After the loop,
    `lastFiredAt` only updates when `appliedAny` is true — so
    an all-skipped batch is faithfully recorded as "no fire."
- `packages/policy/test/injection-detection-counter.test.ts`:
  - **Test 1 (NaN / Infinity rejection)** — bumps with NaN,
    POSITIVE_INFINITY, NEGATIVE_INFINITY, and a real finding;
    asserts only the real one shows in `counts`, `total` stays
    a finite number, and the rollup hasn't been poisoned.
    Pins the load-bearing dashboard contract: `total` is
    always a finite number, never NaN.
  - **Test 2 (`lastFiredAt` honesty)** — first bumps a real
    finding (clock advances), then moves the wall clock forward
    and bumps only-invalid findings, asserts `lastFiredAt`
    stays at the earlier timestamp. A subsequent real bump
    advances the clock as expected, proving the gate is
    correctly transient, not a permanent freeze.

## Verify

- `@muse/policy` suite green (70 passed, +2 vs baseline 68, 0
  failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the
  `!Number.isFinite(finding.count) ||` clause back to the
  pre-fix expression makes both new tests fail simultaneously
  — the NaN test fails because NaN gets added (`total: NaN`,
  `Number.isFinite(snap.total)` returns false), and the
  `lastFiredAt` test fails because the NaN-bearing finding
  slips through, flips `appliedAny` to true, and the clock
  advances to `"2026-05-22T10:00:00.000Z"` when it should have
  stayed at `"2026-05-21T08:00:00.000Z"`. Two-of-two
  mutation-down. Fix restored, suite back to all green.
- `pnpm check` EXIT=0 (apps/api 254 passed, apps/cli 1040
  passed, every workspace green); `pnpm lint` 0/0; `pnpm
  guard:core` clean; `git status` shows only the two intended
  files.
- No LLM request-response wire path touched; `smoke:live` does
  not apply (per `testing.md` / iteration-loop Step 9). The
  defended path is the policy guard-monitor aggregation, not
  the model loop.

## Status

Done. The injection counter now stays faithful under buggy
detector input:

| Input shape                              | Before                                | After                          |
| ---------------------------------------- | ------------------------------------- | ------------------------------ |
| `{ name: "x", count: 3 }`                | bucket += 3, lastFiredAt advances     | unchanged                      |
| `{ name: "", count: 5 }`                 | skipped                               | unchanged                      |
| `{ name: "x", count: 0 }`                | skipped                               | unchanged                      |
| `{ name: "x", count: -3 }`               | skipped                               | unchanged                      |
| `{ name: "x", count: Number.NaN }`       | **bucket → NaN; total → NaN**         | skipped (**fixed**)            |
| `{ name: "x", count: Infinity }`         | **bucket → Infinity; total → Inf.**   | skipped (**fixed**)            |
| All-skipped batch                        | lastFiredAt **advances incorrectly**  | lastFiredAt stays (**fixed**)  |

No CAPABILITIES line / no OUTWARD-TARGETS flip: a robustness /
safety `fix:` on an internal observability aggregator —
recorded honestly with this backlog row, not a false metric.

## Decisions

- **`!Number.isFinite` over `Number.isNaN`.** The finite check
  rejects NaN AND both Infinities in one predicate. Same
  posture as the scheduler validators (goal 562/563) and the
  token-cost helpers. `Number.isNaN` alone would miss
  `Infinity`, which would still pass `<= 0` (false) and add
  Infinity to the bucket.
- **`appliedAny` gate over a simpler "any finding present
  bumps the clock."** The cleaner contract is "the clock
  records WHEN the counter last moved," not "the clock records
  WHEN someone CALLED bumpFrom with a non-empty array." Two
  tests now pin both halves of this contract:
  (a) all-skipped batch leaves `lastFiredAt` alone,
  (b) the first subsequent valid bump still advances it (so
  the gate isn't a permanent freeze if the operator passes
  garbage by mistake).
- **Kept the order `!finding.name || !Number.isFinite || <= 0`
  in the skip guard.** Short-circuit evaluation puts the
  cheapest check first (string falsy check), then the type
  predicate, then the comparison. Mirrors the existing
  read-flow.
- **Did NOT change the `snapshot()` contract.** Continues to
  return all current counts with the rollup `total`. The new
  invariant — `Number.isFinite(snap.total) === true` whenever
  the constructor was passed valid inputs — is now testable
  and pinned by the NaN-rejection test.
- **Did NOT widen `finding.name` validation.** A whitespace-
  only name `"   "` still passes the `!finding.name` truthy
  check, because the source of these findings is in-process
  detector code that emits constants — not external input. If
  a future iteration wires user-controlled family names, that
  branch can tighten then.

## Remaining risks

- **`bumpFrom` total over-extension.** If a single family's
  cumulative count ever exceeds `Number.MAX_SAFE_INTEGER`,
  subsequent increments lose precision (drift +/-). Realistic
  only on a multi-year-uptime instance with millions of fires
  per family per day. Out of scope.
- **`snapshot()` iteration order.** The current implementation
  walks `Map` insertion order. Tests don't rely on this, but a
  dashboard rendering "top N families" should sort by count
  itself (already documented in the source comment). Not a
  defect, but worth noting if a future test pins ordering.
