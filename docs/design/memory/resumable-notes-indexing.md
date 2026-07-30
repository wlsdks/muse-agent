# Resumable notes indexing

Muse keeps query-time recall on the last complete notes index while automatic
refresh advances in bounded units. Explicit `muse notes reindex` remains the
owner-requested full build.

## Automatic budget

- `MUSE_AUTO_REINDEX_MAX_EMBEDDINGS`: attempted embedding fetches per automatic
  pass, default `1`, range `1..64`.
- `MUSE_AUTO_REINDEX_EMBED_TIMEOUT_MS`: per-fetch wall-clock limit, default
  `5000`, range `250..30000`.

Only exact unsigned decimal integers are accepted. Missing or invalid values
use the safe default; they never become unlimited. The budget applies to ask,
chat grounding, note capture, MCP best-effort recall refresh, and semantic note
search. It does not cap explicit reindex or query-time embeddings.

## Persistence and publication

The live JSON is the commit point. Embeddings are written first to an immutable,
content-addressed owner-only sidecar; JSON stores its basename and SHA-256.
Readers therefore keep using the generation they observed while a writer builds
the next one. Old immutable generations are intentionally retained in this
slice; safe garbage collection needs a separate reader-lifetime contract.

An owner-only `notes-index.json.reindex-checkpoint.json` stores progress for one
incomplete file and is bound to the canonical corpus, exact source identity,
model, chunker, annotation version, and current staging generation. A partial
file is never published. Model migrations build through a staging index and
replace the live generation only after every current file is complete.

The checkpoint is capped at 4,096 chunks and 64 MiB of actual serialized UTF-8.
Larger files receive a stable `requires-full` marker, so automatic turns do not
repeat expensive work and the owner is told to run `muse notes reindex`.

## Concurrency and cancellation

A heartbeat-backed required process lock admits one reindex writer. Contenders
perform zero fetches and use the last complete index. Readers never acquire the
writer lock. Caller abort wins over timeout, stops further publication, and is
reported separately from an embedding timeout.
