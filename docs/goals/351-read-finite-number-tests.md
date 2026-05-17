# 351 — readFiniteNumber (provider usage-token boundary) had zero test coverage

## Why

This iteration **verified-and-rejected** two candidates before
landing here: `suggestPatternHints`'s `Math.max(n, opts.X ?? d)`
non-finite pattern is real but **unreachable** (its sole
production caller passes no options — low leverage), and the
goal-349 compat-reasoning follow-up is a documented deliberate
design, not a bug. No actionable deferred follow-up remained.

The clean, high-leverage, non-tautological gap is the
testing.md lane: `readFiniteNumber` (`@muse/model`
provider-shared) had **zero** test references. It is the
**token-usage extraction boundary** — every native adapter
parses provider response usage through it:

```ts
inputTokens:  readFiniteNumber(value, "input_tokens"),   // Anthropic
inputTokens:  readFiniteNumber(value, "prompt_tokens"),   // OpenAI
cachedInputTokens: readFiniteNumber(value.prompt_tokens_details, "cached_tokens"),
inputTokens:  readFiniteNumber(value, "promptTokenCount") // Gemini
```

Its job is to stop a malformed / hostile / non-finite provider
usage payload from poisoning the cost-rollup and
`MonthlyBudgetTracker` (the deterministic-budgets non-negotiable
and the ZERO-cost posture). Its contract has real, regressable
branches — `isRecord` guard (rejects arrays/null/primitives),
`typeof === "number"` (rejects stringified counts),
`Number.isFinite` (rejects NaN/±Infinity), and the
nested-undefined arg the OpenAI adapter relies on
(`value.prompt_tokens_details` is frequently absent). A
regression that, say, dropped the `Number.isFinite` check would
silently feed `NaN` token counts into spend reporting with
nothing to catch it.

## Scope

Test-only. `packages/model/test/model.test.ts` — new
`describe("readFiniteNumber …")` (imported directly from
`../src/provider-shared.js`; it is not barrel-exported, same
approach as goal 341):

- finite numbers incl. `0` and negatives → returned;
- `NaN` / `+Infinity` / `-Infinity` → `undefined` (the
  cost/budget-poisoning guard);
- stringified `"123"` / `null` / absent key → `undefined`
  (typeof + presence);
- non-record `value` — `undefined` / `null` / string / number
  / **array** (the `isRecord` `!Array.isArray` branch,
  verified against the impl before asserting) and the absent
  nested-usage object the OpenAI adapter passes → `undefined`.

No production code changed — this locks the existing contract.

## Verify

- `pnpm --filter @muse/model test` — 158 pass (was 154; +4; 5
  pre-existing live-only skips). Every adapter / wire /
  stripper suite stays green.
- `pnpm check` — every workspace green (model 158, apps/cli
  599, apps/api 161, all packages). `pnpm lint` — exit 0. The
  goal-227 enforcement test (328) stays green.
- No real-LLM request/response path *behaviour* touched (test
  only); a live run cannot deterministically force a provider
  to emit a NaN/stringified/array token field, which is exactly
  why the deterministic boundary test is the rigorous
  verification.

## Status

done — the provider usage-token extraction boundary now has
direct coverage of its finite/typeof/isRecord branches and the
nested-undefined arg the OpenAI adapter depends on, closing an
implicit-only-coverage gap on the path that protects cost/budget
telemetry from malformed provider payloads. No behaviour
changed; future regressions now fail `pnpm check`.
