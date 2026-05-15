# 175 — CLI surfaces the Muse error envelope cleanly

## Why

`formatApiErrorResponse` dumped the raw response body
truncated at 240 chars. The Muse API error envelope is a JSON
object, so every CLI API error (chat / today / memory /
scheduler / mcp / …) showed the user a wall of JSON truncated
mid-object:

```
muse: Muse API 500: {"blockReason":null,"content":null,
"durationMs":null,"errorCode":"AGENT_RUN_FAILED",
"errorMessage":"Ollama /api/chat failed with 404: …",…
```

Goal 174 removed the misleading "Retry attempts exhausted"
wrapper from the *server* side; this fixes the *client*
rendering. Together: a model-name typo now reads as one clean
line instead of a confusing JSON dump claiming 3 retries.

## Scope

- `apps/cli/src/program-helpers.ts`:
  - New `extractApiErrorEnvelope(body)` — parses a JSON object
    body and returns `{ message, code? }` only when it carries
    a non-empty string `errorMessage` (the Muse envelope shape;
    already credential-scrubbed server-side per goal 145).
  - `formatApiErrorResponse` renders
    `Muse API <status>[ (<errorCode>)]: <errorMessage>`
    (errorMessage 240-capped) when the envelope is present;
    otherwise the existing raw-preview behaviour is unchanged.
  - HTML-body branch + empty-body branch untouched.
- `apps/cli/test/program.test.ts`: 2 new cases — envelope →
  clean `Muse API 500 (AGENT_RUN_FAILED): …` with no JSON
  leakage; JSON without `errorMessage` → unchanged raw preview.
  Existing 3 formatApiErrorResponse tests still green
  (envelope path only triggers on an `errorMessage` body).

## Verify

- `pnpm --filter @muse/cli test` — 436 pass (2 new).
- `pnpm check` exit 0; `pnpm lint` exit 0.
- Dog-food (Ollama qwen3:8b API): `muse chat --model
  ollama/nonexistent-model` →
  `muse: Muse API 500 (AGENT_RUN_FAILED): Ollama /api/chat
  failed with 404: model … not found` (clean; previously a
  truncated `{"blockReason":null,…}` dump).

## Status

done — every CLI API error now reads as one human line.
Pairs with goal 174 to make the common "bad model / bad key"
failure path clear end-to-end. No real-LLM request/response
shaping changed (error-presentation only); verified via a
live qwen3:8b round-trip.
