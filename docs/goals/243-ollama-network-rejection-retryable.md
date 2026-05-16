# 243 — Ollama network-level fetch rejection wasn't retryable

## Why

Goals 106 / 214 made HTTP status classification correct
(`isRetryableHttpStatus`: 408 / 429 / 5xx retryable, 4xx fail
fast) and `.claude/rules/architecture.md` makes
`ModelProviderError.retryable` the single source of truth. But
that classifier only runs when there *is* an HTTP response.

`OllamaProvider` (the path the Qwen-only loop actually uses —
`ollama/qwen3:8b` via the native `/api/chat` override, not the
compat base) did:

```ts
const resp = await this.nativeFetch(`${this.nativeBaseUrl}/api/chat`, …);
if (!resp.ok) { throw await this.buildNativeError(…); }   // status path: classified
```

When `fetch` itself **rejects** — no HTTP status at all:
`ECONNREFUSED` (Ollama not running / restarting), `ECONNRESET`
(connection dropped mid-handshake), `ETIMEDOUT`, `EAI_AGAIN` —
the raw `TypeError` ("fetch failed") escaped:

- `generate`: propagated as a bare `TypeError`, **not** a
  `ModelProviderError`, so `retryable` was never set — the runtime
  treats an unclassified throw as a hard failure and the agent
  loop dies on what is the most transient failure of all
  (a local model daemon cold-loading / evicting / restarting).
- `stream`: the rejection threw straight out of the async
  generator, inconsistent with the `!resp.ok` branch which yields
  a structured `{ type: "error" }` event and returns.

For a JARVIS pinned to a local Ollama that routinely loads and
unloads models under memory pressure, a momentary connection
refusal should be a retried transient, exactly like a 503 — not
an agent-killing error.

## Scope

`packages/model/src/adapter-ollama.ts`:

- New private `nativeFetchOrThrow(url, init)` — wraps
  `this.nativeFetch` and re-throws a connection-level rejection as
  `ModelProviderError(id, "Ollama request … failed: <detail> — is
  Ollama running?", retryable=true)`. Sibling of the existing
  `buildNativeError` (which keeps owning the HTTP-status path).
- `generate` calls it (a thrown retryable `ModelProviderError`,
  consistent with its existing `throw await buildNativeError` on
  `!resp.ok`).
- `stream` wraps it in try/catch and **yields** the error as a
  `{ type: "error" }` event then `return`s — now byte-consistent
  with its own `!resp.ok || !resp.body` branch instead of
  throwing out of the generator.

`OpenAICompatibleProvider` (OpenRouter / LM Studio / custom-compat)
has the same unwrapped-`fetch` shape and is a candidate sibling
for a future iteration; this iteration stays tightly scoped to the
native Ollama path that the Qwen loop exercises.

## Verify

- `pnpm --filter @muse/model test` — 143 pass (was 142; +1). New
  test injects a `fetch` that rejects with an `ECONNREFUSED`-style
  `TypeError` and asserts `generate` rejects with
  `{ providerId: "ollama", retryable: true }` and `stream` yields
  exactly one `{ type: "error", error: { retryable: true } }`
  event (does not throw out of the generator).
- `pnpm check` — every workspace green (model 143, apps/cli 555,
  apps/api 153, all packages). `pnpm lint` — exit 0.
- Real-LLM round-trip (native generate/stream path touched):
  `muse ask` on Ollama `qwen3:8b`, reasoning off
  (`OLLAMA_BASE_URL=127.0.0.1:11434 MUSE_MODEL=ollama/qwen3:8b
  GEMINI_API_KEY=""`) returned a correct, persona-correct streamed
  answer — confirming the `stream` try/catch + `let resp`
  restructure does not regress the success path. The failure path
  is covered deterministically by the unit test (tearing Ollama
  down mid-loop to dog-food the reject path would be flaky and
  disruptive — this is the correct split: failure = deterministic
  unit test, happy = live round-trip non-regression).

## Status

done — a transient local-Ollama connection failure
(daemon restart, model cold-load eviction, reset) is now a
retryable `ModelProviderError` on both `generate` and `stream`
instead of an unclassified hard failure that kills the agent loop.
The native Qwen path's network-error handling now matches its own
HTTP-status handling and the architecture's retry contract.
