## 869 — fix: `muse recall` skips removed episodes (completes the 864 staleness fix)

## Why

864 stopped `muse recall` from surfacing deleted NOTES (file-existence
filter), but recall's OTHER source — episodes — was left exposed:
`muse episode remove <id>` drops the episode from the store but does NOT
reindex `episodes-index.json`, and recall built its episode candidates
straight from that index with no live-store cross-check. So a removed
episode's summary kept surfacing in `muse recall` until reindex — the
same "removed means removed" privacy/correctness gap 864 fixed for
notes, still open for episodes.

## Slice

`apps/cli` commands-recall.ts:
- `filterLiveEpisodeEntries(entries, liveIds)` — pure, injectable: keeps
  only index entries whose id is still in the live episode store.
- The recall action builds `liveIds` from `readEpisodes(
  resolveEpisodesFile(env))` and filters the episode candidates before
  ranking (only when there are episode entries to filter). Symmetric
  with the notes filter from 864.

## Verify

`apps/cli` commands-recall.test.ts (+3): `filterLiveEpisodeEntries`
keeps only live ids, drops everything when the store is empty (index
fully stale — consistent with 864's notes behaviour), keeps all when
all ids are live.
- **Mutation-proven**: making the filter ignore `liveIds` (return all)
  fails the keeps-only-live + drops-when-empty tests.
- `pnpm check` EXIT 0 (only the known voice flake), `pnpm lint` 0/0.
  The filter is deterministic; recall's query-embedding stays
  Ollama-gated — no smoke:live for this filter.

## Decisions

- **Cross-check the store, not a per-episode file** — episodes live as
  entries in one JSON store (no per-item file), so the live set is the
  store's ids; an empty store means the index is fully stale → drop all,
  matching 864's "notes dir gone → drop all".
- Read the canonical `resolveEpisodesFile` path (the same one
  `muse episode` + the REPL write to) so recall and the store agree.
- No new dependency (`readEpisodes` / `resolveEpisodesFile` already
  exported).
