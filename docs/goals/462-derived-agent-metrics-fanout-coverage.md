# 462 — Direct coverage for the derived-agent-metrics fan-out (SLO + drift feed)

## Why

`createDerivedAgentMetrics` / `createSloFeedingAgentMetrics`
(`@muse/observability` `observability-agent-metrics.ts`) are the
wiring that makes the runtime's metrics actually *power*
observability: `recordAgentRun` is fanned out into an
`SloAlertEvaluator` (latency + success/failure → SLO alerts), and
`recordTokenUsage` into a `PromptDriftDetector` (input/output
token lengths → prompt-drift anomalies), **while still forwarding
every event to the inner metrics** so base dashboards/budget keep
working. It is a drop-in decorator the runtime assembly installs.

A survey of the fresh autoconfigure/observability modules
(`openai-compat-presets`, `response-filters`, `provider-paths`,
`observability-agent-metrics` itself) found them all mature — no
bug to manufacture. But a coverage check showed `grep
createDerivedAgentMetrics` / `createSloFeedingAgentMetrics` across
**every** test returns nothing: the `agent metrics` describe
covers only `NoOpAgentMetrics` / `InMemoryAgentMetrics`. The
fan-out decorator — the thing that makes SLO alerting and drift
detection receive any data at all — was **implicit-only**: a
regression that dropped the `inner.recordAgentRun(event)` forward
(silent base-metrics blackout), or stopped feeding `slo` / `drift`,
or removed the non-number token guard, would pass every existing
test while silently blinding alerting/drift in production.

This is the `.claude/rules/testing.md` "no implicit-only coverage
of a load-bearing mechanism" rule and the 458 / 460 precedent, on
a distinct mechanism (observability fan-out, not a guard/consent
gate). A `test:` — the disciplined fallback after the probed
modules read mature.

## Slice

- `packages/observability/test/observability.test.ts` — a new
  `describe("createDerivedAgentMetrics fan-out")` (4 cases,
  minimal slo/drift spies + real `InMemoryAgentMetrics` as
  `inner`):
  - **inner always forwarded**: all four metric methods reach
    `inner` (asserted via `recordedEvents()`) even with no
    slo/drift;
  - `slo` gets latency + result from `recordAgentRun`
    (`completed`→true, `failed`→false), `drift` gets
    input/output from `recordTokenUsage`, and `inner` still sees
    every event;
  - non-number token counts skip `drift` but **still** forward
    the `token_usage` event to `inner`;
  - `createSloFeedingAgentMetrics` is exactly the slo-only
    derived wrapper.
- No `src` change — the fan-out is already correct; this pins
  the contract so a refactor can't silently disconnect it.

## Verify

- New describe 4/4 green; full `@muse/observability` suite 66
  passed (1 file, +4 it); tsc strict (observability) EXIT=0.
- **Mutation-proven on the keystone**: deleting
  `inner.recordAgentRun(event)` from the derived `recordAgentRun`
  makes **3** of the new tests fail (`expected
  ['guard_rejection',…] to equal [Array(4)]` — the `agent_run`
  event silently lost from inner while slo/drift still appear to
  work, masking it); `src` then restored byte-identical (`git
  diff --stat` empty), suite back to 66 green.
- `pnpm check` EXIT=0, every workspace green (observability 66,
  cli 739, api …) — no regression; `pnpm lint` 0/0;
  `pnpm guard:core` clean; byte-scan clean; `git status` shows
  ONLY the test file (zero `src` delta).
- Test-only, deterministic (spies, no clock/network/LLM) — not a
  model request/response wire path; `smoke:live` does not apply
  (per `testing.md` / iteration-loop Step 9).

## Status

Done. The decorator that feeds SLO alerting and prompt-drift
detection from runtime metrics — and must never drop the inner
forward — now has direct, mutation-proven unit coverage of every
fan-out branch. A refactor that disconnects slo/drift, or stops
forwarding base metrics, now fails a fast test instead of
silently blinding observability.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]` and audited; test-coverage hardening of an existing
observability mechanism, recorded honestly as a
`test(observability):` change with this backlog row — not a
false metric (the 458/460 precedent).

## Decisions

- Spy-stubbed `slo`/`drift` to their used methods only and used
  a real `InMemoryAgentMetrics` as `inner`: the contract is
  "inner ALWAYS forwarded + derived sinks get their slice", and
  asserting `inner.recordedEvents()` against real recording is
  the honest proof of the forward, not a mock-call count.
- Mutated the inner-forward (not a derived sink): the most
  catastrophic, hardest-to-notice regression is base metrics
  going blank while SLO/drift still look alive — exactly the
  branch a coverage test must be shown to catch.
