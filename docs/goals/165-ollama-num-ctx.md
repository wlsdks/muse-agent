# 165 — Ollama adapter sets `num_ctx` (no silent context truncation)

## Why

`OllamaProvider` (native `/api/chat`, used for every
`ollama/<model>` chat) sent `think: false` but never set
`num_ctx`. Ollama defaults `num_ctx` low (2048–4096 depending
on version/model) and **silently truncates** any prompt over
it — no error, no warning.

Muse's prompt is large by design: persona preamble + user
memory + RAG note chunks + up to 20 open tasks + calendar
events + prior turns. On the user's qwen3:8b that prompt
routinely exceeds 4096 tokens, so the model was answering on a
truncated view of its own grounding — an invisible quality
regression that looks like "the model ignored my notes/tasks".

## Scope

- `packages/model/src/index.ts`: `OllamaProviderOptions.numCtx`.
- `packages/model/src/adapter-ollama.ts`:
  - `numCtx` resolved in the constructor (default 8192;
    non-finite / ≤0 → 8192).
  - `buildNativeChatBody` emits `options.num_ctx`.
- `packages/autoconfigure/src/autoconfigure-model-provider.ts`:
  - `ollama` case passes
    `numCtx: parseInteger(env.MUSE_OLLAMA_NUM_CTX, 8192)` —
    env-overridable (lower for constrained machines, much
    higher for big-context models like qwen3.6:35b-a3b's 256K).

8192 is a safe JARVIS floor: a few hundred MB more KV-cache vs
4096 on an 8B model — negligible on any machine that can run
the model, and the env knob covers the edges.

## Verify

- `pnpm --filter @muse/model test` — 124 pass (2 new:
  default-8192, explicit-numCtx + non-positive-falls-back).
- `pnpm --filter @muse/autoconfigure test` — 128 pass.
- `pnpm check` exit 0; `pnpm lint` exit 0.
- End-to-end (Ollama qwen3:8b API, reasoning off): chat
  round-trip succeeds with `num_ctx:8192` in the body, JARVIS
  persona applied, no thinking leakage — no regression.

## Status

done — Muse's rich context now actually reaches the Ollama
model instead of being silently clipped. Real-LLM request
path touched; verified via a live qwen3:8b round-trip
(Ollama, reasoning off) since smoke:live needs a provider key.
