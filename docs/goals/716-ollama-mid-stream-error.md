# 716 — fix: a mid-stream Ollama error surfaces instead of becoming a silently truncated answer

## Why

`OllamaProvider.stream` (the primary request/response path — Qwen via
local Ollama is the project's only provider) handled HTTP-status
failures (404 model-not-found, 5xx) and connection-level rejects, and a
200-but-non-JSON body. But once Ollama returns 200 and starts streaming
NDJSON, a mid-**generation** failure (out-of-memory, context overflow,
model eviction under load) arrives as an `{"error": "..."}` line — and
`handleLine` parsed it into a message-less `OllamaNativeChatResponse`,
so it was **silently dropped**. The user got a truncated/empty reply
with no error signal. On a local box running a 35B-class model under
memory pressure this is a real, reachable failure.

Picked as a rotated surface (PROCEDURE Step 8: recent iterations churned
actuator/channel/setup/vision; this is the model/provider layer).

## Slice

- `packages/model/src/adapter-ollama.ts`: add `error?: string` to
  `OllamaNativeChatResponse`; in the stream's `handleLine`, when a parsed
  line carries a non-empty `error`, yield a retryable `ModelProviderError`
  stream error event and stop (a `streamError` flag short-circuits both
  the reader loop and the final-drain loop, so no `done` event is emitted
  after the error).

## Verify

- `@muse/model` model.test.ts ("OllamaProvider mid-stream error line"):
  a 200 NDJSON stream whose middle line is `{"error":"…out of memory"}`
  yields an error event whose message contains the upstream error and
  `retryable === true`, and emits NO `done` event (the post-error
  `done:true` line is not processed).
- **Mutation-proven**: removing the error-detection block fails that test.
  Restored; green.
- `pnpm check`: EXIT=0. `pnpm lint`: 0/0. `pnpm check:capabilities`: ✓.
- **Live-verified** (request/response path): `pnpm smoke:live` EXIT=0 —
  the real tiered Qwen round-trip (qwen3.6:35b-a3b fast + qwen3:8b heavy)
  still works with the new branch in place.

## Decisions

- **Retryable = true** — a streamed error after a 200 (OOM / eviction /
  transient runtime) resembles the existing non-JSON-200 transport
  anomaly (also retryable), not a deterministic 4xx config error; the
  agent runtime's retry policy can then decide.
- **Stop the stream on the error** — emitting the error and continuing to
  process a trailing `done:true` would produce a contradictory
  done-after-error sequence; the stream terminates at the first error
  line, matching the HTTP-status error paths that `return` immediately.
- **Generate path left as-is** — the non-stream `/api/chat` call gets a
  proper HTTP status for these failures (handled by `buildNativeError`);
  the body-level `{error}` is specifically a *post-200 streaming*
  artifact.
