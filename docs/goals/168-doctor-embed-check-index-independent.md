# 168 — `muse doctor` flags the missing embed model even without an index

## Why

Goal 102 made `muse doctor`'s embed-model check fire **only
when a notes index already exists** ("users who never opted
into RAG aren't nagged"). But goals 164 (ask degrades) and 167
(setup proactively warns) established that a missing embed
model is a real health gap regardless of index state — RAG /
`muse ask` / `muse recall` are core JARVIS surfaces. A user
with no index yet + no embed model got a clean doctor report
that was misleading: setup warned them, `ask` would degrade,
but `doctor` (the canonical health command) stayed silent.

## Scope

- `commands-doctor.ts`:
  - Embed check now resolves
    `indexedModel ?? DEFAULT_EMBED_MODEL` and always runs when
    Ollama is reachable (not gated on index existence).
  - New pure exported helper `embedModelCheck(embedModel,
    hasIndex, pulledSizeBytes)` → `{ detail, status }`.
    `hasIndex` distinguishes the two messages: index present →
    "will degrade on next search"; no index → "notes RAG /
    `muse ask` unavailable until then" / "ready once you run
    `muse notes reindex`".
  - Imports the `DEFAULT_EMBED_MODEL` exported in goal 167.
- `commands-doctor.test.ts`: 4 cases on `embedModelCheck`
  (ok/index, ok/no-index, warn/index, warn/no-index).

## Verify

- `pnpm --filter @muse/cli test` — 425 pass (4 new).
- `pnpm check` exit 0; `pnpm lint` exit 0.
- Dog-food (`muse doctor --local`, real env): now emits
  `· ollama embed model: nomic-embed-text NOT pulled —
  \`ollama pull nomic-embed-text\` …` instead of staying
  silent.

## Status

done — the missing-embed-model signal is now consistent across
all three surfaces: `setup local` (167, proactive), `doctor`
(168, health), `ask` (164, reactive degrade). No real-LLM path
touched (doctor is a probe; smoke:live not required).
