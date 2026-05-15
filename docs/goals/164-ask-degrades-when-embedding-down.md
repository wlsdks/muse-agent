# 164 — `muse ask` degrades gracefully when embedding is down

## Why

Dog-food finding: `muse ask "..."` died with a bare
`muse: fetch failed` and exit 1 whenever the Ollama embedding
endpoint was unreachable or the embed model wasn't pulled. The
user's actual environment has `qwen3:8b` (chat) but **no**
`nomic-embed-text` (embed) pulled — so `muse ask` was fully
broken for them, with a cryptic error and no answer.

A personal assistant must not refuse to answer just because one
of three grounding sources (notes / tasks / calendar) is
unavailable. It should degrade: skip notes RAG, still answer
from tasks + calendar + memory + general knowledge, and tell
the user how to restore RAG.

## Scope

- `apps/cli/src/commands-ask.ts`:
  - `embed(query)` + cosine ranking wrapped in try/catch. On
    failure: `notesUnavailable = true`, `scored = []`, a clear
    stderr line, and the command **continues** (no exit).
  - Context block becomes
    `(notes search unavailable this turn — answer from the
    other grounding sources)` so the model knows not to claim
    it searched notes.
  - The hint names the exact fix: `ollama pull <embedModel>`.

## Verify

- `pnpm --filter @muse/cli test` — 411 pass (no regression;
  the existing happy-path tests still green).
- `pnpm check` exit 0; `pnpm lint` exit 0.
- End-to-end:
  - Embed down (dead port, Gemini chat): emits the graceful
    line, grounds on 20 open tasks, answers, **exit 0**
    (previously `muse: fetch failed`, exit 1).
  - Real env (qwen3:8b, no embed model pulled): same graceful
    path — `muse ask` now answers (JARVIS persona, task-
    grounded) instead of crashing. Hint shows
    `ollama pull nomic-embed-text`.

## Status

done — `muse ask` is resilient to a missing/unreachable
embedding backend. RAG grounding remains the happy path; its
absence no longer takes the whole command down. The change is
in the RAG pre-step only; the model request/response shaping is
unchanged (smoke:live not required).
