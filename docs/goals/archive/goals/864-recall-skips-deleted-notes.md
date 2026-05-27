## 864 — fix: `muse recall` no longer surfaces a deleted note (stale-index correctness)

## Why

`muse recall` semantic-searches a pre-built `notes-index.json` (built by
`muse notes reindex`), distinct from the live `knowledge_search` corpus.
862 added `muse notes delete` — but a note deleted (or moved) since the
last reindex is STILL in that index, and recall flattened every indexed
file into candidates with no existence check. So `muse recall` would
surface a note the user just deleted, complete with its content, until
the next reindex — wrong, and a "deleted means deleted" privacy
surprise. (Live `knowledge_search` is unaffected — it re-reads the store
each query.)

## Slice — drop index entries whose note file is gone

`apps/cli` commands-recall.ts:
- `filterLiveNoteIndexFiles(files, exists)` — a pure, injectable-
  existence filter that keeps only indexed files still present on disk.
- The recall action runs it (`existsSync`, the index stores absolute
  paths) over `notesIndex.files` before flattening to candidates, so a
  deleted/moved note never reaches the ranker. Episodes are unaffected.

## Verify

- `apps/cli` commands-recall.test.ts (+3): `filterLiveNoteIndexFiles`
  drops the entry whose file is absent (injected predicate), keeps all
  when present, drops all when the notes dir is gone.
- **Mutation-proven**: making the filter ignore `exists` (return all)
  fails the "drops deleted / drops when gone" tests.
- `apps/cli` program.test.ts: the recall model-mismatch integration test
  now writes a REAL note file at the indexed path (its synthetic
  relative non-existent path was unrealistic) — exercising the full
  recall path against a present note, green.
- `pnpm check` EXIT 0, `pnpm lint` 0/0. (The filter is deterministic;
  recall's query embedding is Ollama-gated and unchanged — no smoke:live
  for this filter.)

## Decisions

- **Filter at load, don't auto-reindex on delete.** Coupling
  `muse notes delete` to the recall index (prune the entry) would couple
  two stores and the index format; an existence check at recall time is
  general (covers deletes, moves, external removal) and keeps delete
  simple. Content staleness (an edited note's old text) is still the
  index's documented "reindex to refresh" model — only *non-existent*
  notes are dropped, which is unambiguously correct.
- **Pure injectable helper.** The full recall command needs Ollama to
  embed the query, so the deterministic seam is the existence filter —
  exported + tested with an injected predicate + mutation-proven; the
  integration test exercises it against a real file.
- No new dependency.
