# 114 — `muse recall` warns when the index model mismatches `--embed-model`

## Why

`notes-index.json` and `episodes-index.json` both record the
embedding model used to build them (see `commands-notes-rag.ts`
+ `episode-index.ts`). Cosine similarity between vectors from
*different* embedding models is mostly noise — the spaces don't
align, so a 1024-dim `mxbai-embed-large` query vector compared
against 768-dim `nomic-embed-text` chunks produces meaningless
ranks with high-confidence-looking scores.

Before this iteration, `muse recall` did the cosine math anyway
and printed the resulting "hits" with no hint that they were
garbage. JARVIS-class behaviour says "sir, those measurements
are from a different instrument" *before* presenting the data.

## Scope

- `apps/cli/src/commands-recall.ts`:
  - After loading both indices, compare each one's recorded
    `model` against the query's resolved `embedModel`.
  - On mismatch, stderr a warning that:
    - Names the offending index file + recorded model.
    - States that cross-model cosines are noise.
    - Offers both fix paths (reindex with the query's model OR
      rerun the query with the index's model).
  - The warning does NOT gate retrieval — the user may still
    want to see the (garbage) hits while they decide whether to
    reindex. The warning lands on stderr, hits still land on
    stdout.

## Verify

- New `apps/cli/test/program.test.ts` case (mismatch branch):
  - Seed both indices recorded with `nomic-embed-text`.
  - Run `muse recall <q> --embed-model mxbai-embed-large` against
    them (`MUSE_RECALL_TEST_QUERY_EMBEDDING` skips Ollama).
  - Assert both warnings name the offending index + recorded
    model + offer both fix-path commands. Assert the hit list
    still renders.
- Companion case (match branch):
  - Seed only the notes index with `nomic-embed-text`.
  - Run with the default `--embed-model nomic-embed-text`.
  - Assert no "but querying with" string ever appears.
- `pnpm --filter @muse/cli test` — 336 tests pass.
- `pnpm check` exit 0; `pnpm lint` exit 0.
- No real-LLM path touched (resolver + warning are pure;
  the test seam bypasses Ollama).

## Status

done — recall now flags cross-embedding-model queries so the
user doesn't trust noise as signal.
