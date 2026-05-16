# 244 — OpenAI-compatible base: network fetch rejection wasn't retryable

## Why

Goal 243 fixed the native Ollama path; its doc explicitly flagged
`OpenAICompatibleProvider` as carrying the identical
unwrapped-`fetch` shape and reserved it for a follow-up. This is
that follow-up — finishing the sibling so retry classification is
consistent across **every** provider path.

`OpenAICompatibleProvider` backs OpenRouter, LM Studio, and any
custom OpenAI-compatible endpoint. Both `generate` and `stream`
did:

```ts
const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, …);
if (!response.ok) { /* classified via isRetryableHttpStatus */ }
```

When `fetch` itself **rejects** — no HTTP status:
`ECONNREFUSED` (endpoint down / LM Studio not serving),
`ECONNRESET`, `ETIMEDOUT`, `EAI_AGAIN` — the raw `TypeError`
escaped:

- `generate`: propagated as a bare `TypeError`, not a
  `ModelProviderError`, so `retryable` was never set — the runtime
  treats the unclassified throw as a hard failure and the agent
  loop dies on the most transient failure of all (a local compat
  server restarting / not yet up).
- `stream`: the rejection threw out of the async generator,
  inconsistent with the `!response.ok` branch which yields a
  structured `{ type: "error" }` event and returns.

`.claude/rules/architecture.md` makes `ModelProviderError.retryable`
the single source of truth and says unknown/transient errors MAY
retry — a connection refusal is exactly that.

## Scope

`packages/model/src/provider-base.ts` — mirrors goal 243's native
Ollama fix exactly:

- New private `fetchOrThrow(url, init)` — wraps `this.fetchImpl`
  and re-throws a connection-level rejection as
  `ModelProviderError(id, "OpenAI-compatible request … failed:
  <detail>", retryable=true)`. `isRetryableHttpStatus` keeps
  owning the HTTP-status path unchanged.
- `generate` calls it (a thrown retryable `ModelProviderError`,
  consistent with its existing `throw` on `!response.ok`).
- `stream` wraps it in try/catch and **yields** the error as a
  `{ type: "error" }` event then `return`s — now byte-consistent
  with its own `!response.ok` branch instead of throwing out of
  the generator.

`OllamaProvider` extends this base but overrides `generate` /
`stream` with its own `nativeFetch` (fixed in 243), so the two
fixes are independent and now symmetrical. Retry classification is
consistent across native-Ollama, OpenAI-compat, and (already)
Anthropic / Gemini.

## Verify

- `pnpm --filter @muse/model test` — 144 pass (was 143; +1). New
  test injects a `fetch` that rejects with an `ECONNREFUSED`-style
  `TypeError` into an `OpenAICompatibleProvider` (id `lmstudio`)
  and asserts `generate` rejects with
  `{ providerId: "lmstudio", retryable: true }` and `stream`
  yields exactly one `{ type: "error", error: { retryable: true }
  }` event (does not throw out of the generator).
- `pnpm check` — every workspace green (model 144, apps/cli 555,
  apps/api 153, all packages). `pnpm lint` — exit 0.
- No applicable real-LLM round-trip: the Qwen loop uses
  `ollama/qwen3:8b` via the **native** `OllamaProvider` override
  (goal 243), which does not exercise this compat base. The
  failure branch is covered deterministically by the new unit
  test; happy-path non-regression is covered by the existing
  OpenAI / OpenRouter contract suite (`generate` + `stream` +
  error mappings) which stays green under `pnpm check`. This is
  the same honest split goal 243 documented — routing Qwen through
  a synthetic compat endpoint purely to re-exercise a branch the
  unit + contract tests already pin would be over-engineering.

## Status

done — a transient connection failure to any OpenAI-compatible
backend (OpenRouter / LM Studio / custom endpoint down,
restarting, or reset) is now a retryable `ModelProviderError` on
both `generate` and `stream` instead of an unclassified hard
failure. With goal 243, every Muse provider path now classifies
network-level rejections consistently with its HTTP-status path
and the architecture's retry contract.
