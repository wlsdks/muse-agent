# 106 — Classify HTTP 429 as retryable across every provider adapter

## Why

`.claude/rules/architecture.md` already defines the contract:

> `ModelProviderError.retryable` is the source of truth.
> 4xx (model-not-found, bad key) MUST fail fast. 5xx and unknown
> errors MAY retry.

But every adapter (`provider-base.ts`, `adapter-openai.ts`,
`adapter-anthropic.ts`, `adapter-gemini.ts`, `adapter-ollama.ts`)
encoded the policy inline as `response.status >= 500`, which
quietly classifies **429 Too Many Requests** as fail-fast.
429 is the standard rate-limit response from OpenAI / Anthropic /
Gemini / OpenRouter / Ollama — exactly the case where retry-with-
backoff is the *only* sensible response. Falling through to a
hard fail meant the agent loop burned the user's budget on a
prompt that would have succeeded one second later.

## Scope

- New pure helper `isRetryableHttpStatus(status)` in
  `packages/model/src/provider-base.ts`:
  - `true` for 429 and 500–599.
  - `false` for everything else (including 2xx, 3xx, 4xx ≠ 429,
    NaN / Infinity / out-of-spec ≥ 600).
  - Documented inline with the architecture-rules contract.
- Every retryability decision in
  `provider-base.ts`, `adapter-openai.ts`, `adapter-anthropic.ts`,
  `adapter-gemini.ts`, `adapter-ollama.ts` now routes through the
  helper. Eight call sites collapsed to a single rule — drift
  across providers is no longer possible.
- Helper re-exported from `packages/model/src/index.ts` so the
  unit test loads via the entry point (the direct path through
  `provider-base.js` hits the documented runtime cycle).

## Verify

- New `packages/model/src/provider-base.test.ts` covers:
  - 429 → retryable.
  - 5xx → retryable.
  - 4xx (other) → fail-fast.
  - 2xx / 3xx → fail-fast.
  - status ≥ 600 / NaN / Infinity / negatives → fail-fast.
  - `ModelProviderError` default `retryable` stays `false`.
- `pnpm --filter @muse/model test` — 122 tests pass.
- `pnpm check` exit 0; `pnpm lint` exit 0.
- `pnpm smoke:live` — 13/0 (live LLM round-trip still works).

## Status

done — rate-limit responses across every provider family now
classify as retryable. No behavioural change for callers that
treat `retryable: true` the way the resilience layer already
expects.
