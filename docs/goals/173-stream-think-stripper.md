# 173 — strip a leaked `<think>` block from streaming output

## Why

Goal 172 stripped a leaked leading `<think>…</think>` from the
**non-stream** `generate()` path but explicitly deferred
streaming. The stream path (`muse chat --stream`, the REPL) is
the most interactive surface — if Qwen3 leaks reasoning there
(older Ollama / an OpenAI-compatible server that drops
`chat_template_kwargs`), the user watches the chain-of-thought
scroll by token-by-token. That was the last reasoning=false gap.

## Scope

- `provider-shared.ts`: new `createLeadingThinkStripper()` — a
  tiny 4-state machine (`scan → in → trim → pass`) fed each text
  delta, returning only the portion safe to emit. Handles:
  - open/close tags split across chunk boundaries (bounded
    buffering, ≤ tag length while deciding),
  - the post-close blank line arriving in a *later* chunk
    (`trim` mode swallows whitespace until the first real char),
  - an unterminated block (truncated stream → emit nothing),
  - non-think output and a later `<think>` in prose → verbatim
    passthrough (same contract as the non-stream helper).
- Wired into the streaming loop of `adapter-ollama.ts` (native
  NDJSON) and `provider-openai.ts` (SSE). The accumulated
  `output` in the terminal `done` event is run through the
  non-stream `stripLeadingThinkBlock` so the final response
  matches `generate()` exactly (single-sourced).
- Exported from the package index; 6 direct unit tests
  (one-chunk, split tags, verbatim + later `<think>`, leading
  whitespace, unterminated, no-whitespace close).

## Verify

- `pnpm --filter @muse/model test` — 135 pass (6 new).
- `pnpm check` exit 0; `pnpm lint` exit 0.
- Dog-food (Ollama qwen3:8b, reasoning off): `muse chat
  --stream "3 곱하기 3은?"` → `9입니다.`, no `<think>`, no
  regression (clean no-op when suppression already worked).

## Status

done — reasoning=false coverage is now complete: request-side
suppression (165/171), non-stream response strip (172), and
streaming response strip (173). A leaked think block can no
longer reach the user or persisted state on any path.
