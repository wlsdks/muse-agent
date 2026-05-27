# 725 — fix: surface a mid-stream error from an OpenAI-compatible backend instead of silently truncating

## Why

`parseOpenAIStream` is the SSE delta parser shared by every
`OpenAICompatibleProvider` — OpenRouter, vLLM, SGLang, LM Studio, and a
Qwen model served over an OpenAI-compatible endpoint. After a 200, these
backends emit a mid-generation failure as an SSE `data: {"error":{...}}`
chunk (context-length exceeded, upstream rate-limit, model crash). The
parser read that chunk as a delta-less message (`choices`/`delta` absent
→ empty delta) and silently dropped it, then ended the stream with a
`done` event carrying the partial/empty `output` — a truncated answer
with no error. Same bug class the native-Ollama stream fix (716) closed,
on the compat path.

Rotated surface (PROCEDURE Step 8: recent iterations touched
messaging/channel, calendar, notes-rag, tools-time — this is the model /
provider-adapter surface).

## Slice

- `packages/model/src/provider-openai.ts`: in `parseOpenAIStream`, after
  parsing each chunk, check for an `error` field via a new
  `readOpenAIStreamError` (handles a string `error` or an object
  `{message}`); if present, yield a retryable `ModelProviderError` stream
  error event and `return` (so a post-error chunk + `[DONE]` can't still
  emit a `done`).

## Verify

- `@muse/model` model.test.ts (175 tests): a stream of `partial` delta →
  `{"error":{message,type}}` → ` more` delta → `[DONE]` yields an error
  event whose message contains the upstream text with `retryable === true`
  and emits NO `done` event.
- **Mutation-proven**: removing the error-detection branch fails that
  test. Restored; green.
- `pnpm check`: EXIT=0. `pnpm lint`: 0/0. `pnpm check:capabilities`: ✓.
- `pnpm smoke:live`: NOT the relevant gate here and not run to
  completion — it exercises the Ollama NATIVE `/api/chat` path, which
  overrides `stream` and never calls `parseOpenAIStream`, so it cannot
  hit this branch. (Attempted anyway as a build-sanity check; it timed
  out on the cold load of `qwen3.6:35b-a3b` rather than failing — an
  environment perf artifact, unrelated to this compat-stream change.)
  The deterministic, mutation-proven unit test + `pnpm check` are the
  verification for this change.

## Decisions

- **Retryable = true** — a streamed error after a 200 (context overflow,
  transient upstream) matches the native-Ollama mid-stream classification
  (716) and the non-JSON-200 transport-anomaly posture; the agent retry
  policy decides from there.
- **Handle both `error` shapes** — OpenAI/Azure send `{"error":{"message"
  …}}`; some compat servers send a bare string; cover both rather than
  assume one.
- **Stop at the first error** — continuing would let a trailing `[DONE]`
  emit a contradictory `done`-after-error; the stream terminates at the
  error, like the HTTP-status error paths.
