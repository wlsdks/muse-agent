# 091 — `muse recall <query>` — semantic search across every store

## Why

JARVIS answers "remind me what I said about the Q3 budget" by
searching everything — notes, prior conversations, scheduled
followups. Today the user has to pick: `muse ask --notes-only`
hits notes; nothing hits episodes or followups. Add a single
`muse recall <query>` that cosine-searches the union of every
semantic index Muse has and returns top-K hits with attribution.

## Scope

- New `apps/cli/src/commands-recall.ts` with
  `muse recall <query> [--limit N] [--source notes|episodes|all]
  [--embed-model <tag>] [--json]`.
- Embeds the query once via the shared helper from goal 090,
  then cosine-searches:
  - notes via `~/.muse/notes-index.json` (existing)
  - episodes via `~/.muse/episodes-index.json` (goal 090)
- Merges hits, sorts by score, takes top-K (default 5).
- Each hit carries `{ source, ref, score, snippet }` so the user
  knows whether it's a note or an episode.
- `--source` filter lets the user narrow.
- Soft-fails per-index: a missing episodes-index logs a stderr
  hint but the recall still returns notes hits.

## Verify

- cli +1 unit test on the merge-and-rank step (stub indices in
  memory, query a fixed embedding, verify the result order).
- Dogfood:
  ```
  HOME_DIR=$(mktemp -d -t muse-recall-XXXX)
  mkdir -p "$HOME_DIR/.muse"
  # Plant a tiny notes-index without going through Ollama (use a
  # deterministic 4-d embedding so the search math runs).
  cat > "$HOME_DIR/.muse/notes-index.json" <<'EOF'
  {"version":1,"model":"diagnostic","builtAtIso":"2026-05-14T00:00:00Z","files":[
    {"path":"q3.md","mtimeMs":0,"chunks":[{"chunkIndex":0,"text":"Q3 budget memo notes","embedding":[1,0,0,0],"file":"q3.md"}]},
    {"path":"weather.md","mtimeMs":0,"chunks":[{"chunkIndex":0,"text":"weather forecast","embedding":[0,1,0,0],"file":"weather.md"}]}
  ]}
  EOF
  HOME="$HOME_DIR" MUSE_RECALL_TEST_QUERY_EMBEDDING="1,0,0,0" \
    node apps/cli/dist/index.js recall "budget memo" --json
  ```
  Pass if the top hit's `ref` mentions `q3.md`.

## Status

done — `muse recall <query> [--limit N] [--source
notes|episodes|all] [--embed-model <tag>] [--json]`
cosine-searches the union of the notes-index (existing) +
episodes-index (goal 090). One embedding call per invocation,
then a pure `rankRecallCandidates` merge + sort step that
drops zero-similarity rows. Each hit reports
`{ source, ref, score, snippet }`.

Per-source soft-fail: missing notes-index → stderr hint but
episode hits still surface (and vice versa). Test escape
hatch `MUSE_RECALL_TEST_QUERY_EMBEDDING` (CSV of numbers)
bypasses the live embed call so the dogfood asserts ranking
without needing Ollama.

cli +1 test exercises `rankRecallCandidates` across
all / notes-only / episodes-only / limit-clamp. Dogfood:
planted a 2-chunk notes-index with deterministic embeddings
+ ran `muse recall` with the test hook; top hit
`ref: "q3.md"` per pass criterion.
