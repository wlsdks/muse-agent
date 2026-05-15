# 167 — `muse setup local` flags the missing embedding model

## Why

`muse setup local` probes Ollama, picks a chat-model preset,
RAM-checks it, writes config — but never checks the **embedding
model**. Goal 164 showed the consequence: the user finished
setup with a working chat model but `muse ask` / `muse recall`
(notes RAG) silently broken because `nomic-embed-text` was
never pulled. 164 made `ask` degrade gracefully *reactively*;
this surfaces the gap *proactively* at setup so the user fixes
it before hitting it.

## Scope

- `commands-notes-rag.ts`: `DEFAULT_EMBED_MODEL` now exported
  (single-sourced; was a private const).
- `commands-setup-local.ts`:
  - New pure helper `isEmbedModelPulled(installedNames)` —
    treats `<model>` and `<model>:latest` as the same identity
    (Ollama's implicit default tag).
  - `setup local` emits, right after the RAM check (reached on
    every exit path — not-pulled, --check, write):
    `RAG note: notes/recall grounding needs an embedding model
    — not pulled. / ollama pull nomic-embed-text`
- `commands-setup-local.test.ts`: 3 cases on the helper
  (chat-only → false, bare/`:latest` → true, different embed
  model → false).

## Verify

- `pnpm --filter @muse/cli test` — 417 pass (3 new).
- `pnpm check` exit 0; `pnpm lint` exit 0.
- Dog-food on the real environment (`muse setup local --check`,
  Ollama has qwen3:8b + qwen3.6:35b-a3b, no embed model):
  the `RAG note: … ollama pull nomic-embed-text` line appears
  proactively before the chat-model pull guidance.

## Status

done — chat-model and embed-model setup gaps are now both
surfaced at setup time. Pairs with goal 164 (reactive
degradation) for full coverage. No real-LLM path touched
(CLI probe only; smoke:live not required).
