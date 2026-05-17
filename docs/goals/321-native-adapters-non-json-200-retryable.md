# 321 — Anthropic / Gemini / OpenAI-Responses adapters had the same unguarded 200-but-non-JSON gap

## Why

Goal 320 closed the 200-OK-but-non-JSON `response.json()` gap in
`OpenAICompatibleProvider.generate` (the Ollama / LM Studio /
OpenRouter / custom base — the Qwen runtime's path). The three
**native** adapters had the byte-for-byte identical gap on their
own `generate` happy paths:

- `adapter-anthropic.ts`: `return fromAnthropicResponse(this.id,
  request.model, await response.json());`
- `adapter-gemini.ts`: `return fromGeminiResponse(this.id, model,
  await response.json());`
- `adapter-openai.ts` (Responses API `/v1/responses`):
  `const payload = await response.json();`

Each correctly classifies its `!response.ok` path
(`isRetryableHttpStatus` + `truncateErrorBody`), but the 200-OK
happy path's `response.json()` is unguarded: a `200` whose body
is not JSON (captive-portal / SSO HTML, a reverse-proxy or
load-balancer error page served as 200, a truncated body) throws
a raw `SyntaxError` that escapes the provider **as a
non-`ModelProviderError`**, breaking the
`ModelProviderError.retryable` contract (architecture.md: "the
source of truth") — the resilience layer can't classify it and
the user sees a cryptic JSON-parser stack trace instead of a
clean retryable provider error.

Closing it in only one of four adapters would be exactly the
kind of cross-adapter inconsistency the codebase explicitly
sweeps (cf. the messaging bounded-error-body parity, goal 319).
This finishes the model-layer wrap-upstream-surprises class so
**all four** provider families behave identically.

## Scope

`packages/model/src/adapter-anthropic.ts`,
`adapter-gemini.ts`, `adapter-openai.ts` — each `generate`
happy path:

- Read the body as text, parse with the existing safe
  `parseJson` (`provider-shared.ts`, `undefined` on parse
  failure; a valid completion response is never the JSON value
  `undefined`, so `=== undefined` unambiguously means "not
  JSON").
- On non-JSON, throw a **retryable** `ModelProviderError`
  (`true`) with the body bounded by `truncateErrorBody` (already
  imported in all three) — the contract-correct classification
  for an unknown transport anomaly, identical to goal 320 and to
  this layer's existing connection-level-rejection posture.
- Add `import { parseJson } from "./provider-shared.js"` to each
  (no cycle — `provider-shared` imports only types from
  `index.ts`). One short WHY comment per file (the
  transport-anomaly / contract rationale is non-derivable).

Behaviour-preserving for every valid response —
`parseJson(rawBody)` yields the identical object
`response.json()` produced, so `fromAnthropicResponse` /
`fromGeminiResponse` / `fromOpenAIResponsesResponse` run exactly
as before (the existing anthropic/gemini contract tests, which
assert the full mapped happy-path response, stay green).

## Verify

- `pnpm --filter @muse/model test` — 149 pass (was 146; +3; 5
  pre-existing live-only skips). New regressions: a `200` with a
  `text/html` captive-portal body (+5000 padding) through
  `AnthropicProvider` / `GeminiProvider` / `OpenAIProvider`
  `generate` → rejects with `{ name: "ModelProviderError",
  providerId, retryable: true }`, message contains `"was not
  valid JSON"`, bounded `< 360` chars. The existing per-adapter
  metadata / generate / stream / tool-call / error-classification
  tests stay green (valid JSON is byte-identical).
- `pnpm check` — every workspace green (model 149, apps/cli
  563, apps/api 161, all packages). `pnpm lint` — exit 0.
- **No real-LLM round-trip**: this iteration changes only the
  native **paid** adapters (Anthropic / Gemini / OpenAI). The
  Qwen-only zero-cost constraint forbids calling any of them,
  and the Ollama/Qwen path (`OpenAICompatibleProvider`) is
  **untouched** here — it was already dog-fooded against real
  `qwen3:8b` in goal 320. The deterministic mock-fetch
  regression plus the still-green valid-response contract tests
  are the rigorous verification — same stance as the error-path
  siblings 319 / 320.

## Status

done — all four model-provider families (OpenAI-compatible/Ollama
via goal 320; Anthropic / Gemini / OpenAI-Responses here) now
convert a 200-but-non-JSON body into a retryable
`ModelProviderError` instead of leaking a raw `SyntaxError`, so
the `.retryable` contract holds across the entire request path —
success and failure — for every provider. The model-layer
wrap-upstream-surprises class is closed.
