# 102 — `muse doctor` probes the notes-RAG embedding model when an index exists

## Why

Goal 101 caught the chat-model footgun. The notes-RAG path has the
same one: the user runs `muse notes reindex`, the index records
`model: "nomic-embed-text"`, they later wipe `~/.ollama` (or hop
machines), and the next `muse ask <question-about-notes>` blows up
on the embedding HTTP call with `embeddings 404`. Doctor knew
Ollama was up but didn't notice the missing embed model.

This iteration extends the goal-101 probe pattern to RAG.

## Scope

- `apps/cli/src/commands-doctor.ts` runLocalDoctor:
  - When `~/.muse/notes-index.json` exists, read its `model` field
    via the new pure helper `parseNotesIndexEmbedModel`. Missing
    field / malformed JSON falls back to the documented default
    `nomic-embed-text`; ENOENT means "the user never indexed" and
    the probe stays silent (no nag for users who don't use RAG).
  - When Ollama is reachable AND we have a recorded model, run
    `findOllamaModelTag` (goal 101). Emit a new `ollama embed model`
    check: `ok` with size, or `warn` with the exact
    `ollama pull <model>` command.
- Probe gated on (a) index file present AND (b) Ollama reachable,
  so users who never opted into RAG see nothing new.

## Verify

- New cases in `apps/cli/src/commands-doctor.test.ts` for
  `parseNotesIndexEmbedModel`: recorded model wins, missing field
  → default, malformed JSON → default, ENOENT → undefined, trims
  whitespace, treats whitespace-only model as missing.
- `pnpm --filter @muse/cli test` — 319 tests pass.
- `pnpm check` exit 0; `pnpm lint` exit 0.
- No real-LLM path touched (the new helper is a pure JSON parser;
  the probe reuses the goal-101 model-pulled lookup).

## Status

done — RAG users get the same JARVIS-style "pre-flight check"
the chat-model probe gives.
