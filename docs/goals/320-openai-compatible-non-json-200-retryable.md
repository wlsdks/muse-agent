# 320 — a 200-OK-but-non-JSON body escaped OpenAICompatibleProvider as a raw SyntaxError

## Why

`OpenAICompatibleProvider.generate` (the base every local/free
OpenAI-compatible path extends — **Ollama, LM Studio,
OpenRouter, custom** — i.e. the Qwen-only runtime's primary
surface) did:

```ts
const payload = await response.json();
return fromOpenAIChatResponse(this.id, request.model, payload);
```

Every *failure* path in this file is carefully classified
against the `ModelProviderError.retryable` contract
(architecture.md: "`ModelProviderError.retryable` is the source
of truth"): non-OK HTTP → `isRetryableHttpStatus`,
connection-level fetch rejection → retryable `ModelProviderError`,
stream non-OK → same. But the **200-OK happy path's
`response.json()`** was unguarded: a `200` whose body is **not
JSON** — a captive-portal / SSO login HTML page, a reverse-proxy
or load-balancer error page served with status 200, a
truncated/garbled body from a local Ollama under load or
mid-restart — makes `response.json()` throw a raw `SyntaxError`
(`Unexpected token '<' … is not valid JSON`). That escapes the
provider **as a non-`ModelProviderError`**, so:

- the resilience/retry layer cannot classify it via `.retryable`
  (the contract says that field is the source of truth) — a
  transient transport hiccup that *should* retry instead
  surfaces as an uncategorised hard crash;
- the user sees a cryptic JSON-parser stack trace with no
  provider context instead of a clean provider error.

This is the model-layer analog of the messaging
bounded-error-body / wrap-upstream-surprises class (goals 311 /
312 / 315 / 319).

## Scope

`packages/model/src/provider-base.ts` —
`OpenAICompatibleProvider.generate` happy path:

- Read the body as text, parse with the existing safe
  `parseJson` (`provider-shared.ts`, returns `undefined` on
  parse failure). A valid chat-completion response is never the
  JSON value `undefined`, so `payload === undefined`
  unambiguously means "body was not valid JSON".
- On non-JSON, throw a **retryable** `ModelProviderError`
  (`true`) with the body bounded by `truncateErrorBody` (240
  cap, already imported). Retryable is the contract-correct
  classification: a malformed 200 body is an unknown transport
  anomaly, exactly like the connection-level fetch rejection
  this file already treats as retryable — not a deterministic
  4xx client error.
- The stream path's `!response.body` fallback calls
  `this.generate`, so it inherits the fix transitively; no
  separate change needed.

Behaviour-preserving for every valid response —
`parseJson(rawBody)` yields the identical object
`response.json()` produced, so `fromOpenAIChatResponse` runs
exactly as before. One short WHY comment records the
transport-anomaly / contract rationale (non-derivable).

## Verify

- `pnpm --filter @muse/model test` — 146 pass (was 145; +1; 5
  pre-existing live-only skips). New regression: a `200` with a
  `text/html` captive-portal body (+ 5000 padding chars) →
  `generate` rejects with `{ name: "ModelProviderError",
  providerId: "lmstudio", retryable: true }`, message contains
  `"was not valid JSON"`, and is bounded `< 360` chars (raw body
  doesn't flow unbounded). The existing
  connection-level-retryable / non-OK-status / stream / contract
  tests stay green (valid JSON is byte-identical).
- `pnpm check` — every workspace green (model 146, apps/cli
  563, apps/api 161, all packages). `pnpm lint` — exit 0.
- **Real-LLM round-trip dog-food** (happy path was touched):
  built dist + a real **Ollama `qwen3:8b`** round-trip through
  the modified `generate`
  (`OLLAMA_BASE_URL=http://127.0.0.1:11434`,
  `OllamaProvider`, `think:false` / reasoning off) returned a
  clean `"PONG"` — the text+`parseJson` swap parses a real valid
  Qwen response identically to `response.json()`. No paid model,
  zero cost.

## Status

done — `OpenAICompatibleProvider.generate` now converts a
200-but-non-JSON body into a retryable `ModelProviderError`
instead of leaking a raw `SyntaxError`, so the `.retryable`
contract holds across the *entire* request path (success and
failure) for every Ollama / LM Studio / OpenRouter / custom
OpenAI-compatible provider — and the local Qwen happy path is
verified unchanged against a real round-trip.
