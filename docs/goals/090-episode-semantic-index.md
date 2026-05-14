# 090 — Episode semantic index for cross-session recall

## Why

JARVIS remembers what Tony said three weeks ago. Muse captures
end-of-session summaries into `~/.muse/episodes.json` (goal 040
era) but those entries are only browsable by date — no semantic
"what did I say about X" recall. Mirror the
`notes-index.json` pipeline (Ollama nomic-embed-text via HTTP)
over `episodes.json` so each summary becomes a queryable vector.

## Scope

- New `~/.muse/episodes-index.json` shape mirroring `notes-index`:
  `{ version: 1, model, builtAtIso, entries: [{ id, summary,
  startedAtIso, embedding }] }`.
- New `muse episode reindex [--force] [--embed-model <tag>]`
  subcommand under existing `muse episode` group.
- Reuse the embedding HTTP call from `commands-notes-rag.ts` —
  extract the call into a shared helper module
  (`apps/cli/src/embed.ts`) so goals 090 + 091 use the same
  function.
- Skip entries already embedded with the same model + summary text
  (mtime-style incremental, like notes-index).
- `version` mismatch → full rebuild (mirrors goal 074).

## Verify

- cli +1 unit test on the dedupe + skip logic (mock embed
  function, feed a 3-entry episodes.json, verify second run
  embeds zero new entries).
- Dogfood (skip if Ollama embed model not available):
  ```
  HOME_DIR=$(mktemp -d -t muse-ep-XXXX)
  mkdir -p "$HOME_DIR/.muse"
  echo '{"version":1,"episodes":[{"id":"ep_1","userId":"dogfood","startedAt":"2026-05-12T10:00:00Z","endedAt":"2026-05-12T10:30:00Z","summary":"reviewed Q3 budget proposal"},{"id":"ep_2","userId":"dogfood","startedAt":"2026-05-13T14:00:00Z","endedAt":"2026-05-13T14:15:00Z","summary":"planned wedding venue tour"}]}' > "$HOME_DIR/.muse/episodes.json"
  HOME="$HOME_DIR" node apps/cli/dist/index.js episode reindex
  ls "$HOME_DIR/.muse/episodes-index.json" && echo "ok"
  ```
  Pass if the index file lands + has 2 entries (or cleanly reports
  "embedding model unavailable").

## Status

open
