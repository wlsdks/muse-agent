# 074 — Notes index rebuild on schema bump

## Why

notes-index.json carries a 'version: 1' field. If the schema changes,
the existing index is silently wrong. Detect mismatch + rebuild.

## Scope

- Read commands-notes-rag.ts.
- On schema mismatch, log + rebuild.

## Verify

- cli +1 test.

## Status

done — exported `NOTES_INDEX_SCHEMA_VERSION` constant + the
pure `isNotesIndexValid` predicate. `loadIndex` runs the
predicate after `JSON.parse`; on mismatch (wrong version,
non-numeric, garbage shape) it returns `undefined` — same code
path that fires for ENOENT / malformed JSON, so the existing
`isNotesIndexStale` reports stale and the next `reindexNotes`
rebuilds from scratch.

The literal `version: 1` write inside `reindexNotes` now
references the constant so a future bump only touches one
source of truth.

cli +1 test exercises the predicate matrix (valid / missing /
wrong-numeric / wrong-string-type) + the end-to-end stale flag
firing on a planted v0 index file.
