# 176 — Ollama model-not-found error names the `ollama pull` fix

## Why

Goals 174 (fail fast) + 175 (clean envelope render) made the
"bad / unpulled model" error readable:
`Muse API 500 (AGENT_RUN_FAILED): Ollama /api/chat failed with
404: model 'X' not found`. It said *what* failed but not *how
to fix it*. The embed-model surfaces (goals 164 / 167 / 168)
already name the exact `ollama pull <model>` command — the
chat-model path should be consistent.

## Scope

- `packages/model/src/adapter-ollama.ts`:
  - New private `buildNativeError(request, resp, label)` —
    factors the two duplicated error constructions (generate +
    stream). Reads the body once; when `status === 404` and the
    body matches `/not found/i`, appends
    `` — run `ollama pull <model>` (or check the model name).``
    The model is `request.model ?? defaultModel` minus the
    `ollama/` prefix. Preserves the existing message prefixes
    (`Ollama /api/chat failed with …` / `Ollama stream failed
    with …`) and the goal-106 retryable classification.
  - `generate()` and `stream()` both delegate to it (dedupe).
- `packages/model/test/model.test.ts`: 3 new cases — generate
  404 → pull hint, stream 404 → pull hint, non-404 (503) →
  **no** pull hint (only the genuine first-run footgun gets it).

## Verify

- `pnpm --filter @muse/model test` — 138 pass (3 new).
- `pnpm check` exit 0; `pnpm lint` exit 0.
- Dog-food (Ollama qwen3:8b API): `muse chat --model
  ollama/totally-not-a-model` →
  `Muse API 500 (AGENT_RUN_FAILED): Ollama /api/chat failed
  with 404: {"error":"model 'totally-not-a-model' not found"}
  — run \`ollama pull totally-not-a-model\` (or check the
  model name).`

## Status

done — the bad/unpulled-model journey is now complete:
fail fast (174) → clean render (175) → actionable fix (176).
One line that says what's wrong and how to fix it, consistent
with the embed-model hints. Real-LLM error path; verified via
a live qwen3:8b round-trip.
