# Goal 917 — `muse export` bundles the episode index (recall survives restore)

## Outward change

`muse export` now includes `episodes-index.json` in the backup, next
to its sibling `notes-index.json`. Before, the backup bundled the
notes embedding index but **not** the episodes embedding index — so a
laptop-migration restore left episodic recall ("what did we discuss
about X?") silently returning nothing until the user manually ran a
re-index, which itself needs Ollama up to recompute the embeddings.
The backup now restores recall immediately.

## Why this, now

The exhaustive-list / sibling-inconsistency seam (export 904,
open-jobs 903, corpus 916): the export catalog included one of a
matched pair and omitted the other. `episodes-index.json` is the
direct sibling of `notes-index.json` — the module header even says it
"mirrors the notes-index.json pipeline" — both carry per-entry
embeddings, both are expensive to recompute, and crucially the episode
index is NOT auto-rebuilt on read (a missing/corrupt index collapses
to empty and only repopulates on an explicit `reindex`). Backing up
one semantic index but not its twin is a real, asymmetric
backup-completeness gap, and the affected capability — episodic recall
— is a core JARVIS sense.

## How

One entry added to `DEFAULT_EXPORT_FILES`: `episodes-index.json`,
placed immediately after `notes-index.json` so the two semantic
indices sit together. `collectSources` already skips absent / empty
files, so a user who never built the episode index simply doesn't get
the entry — no behaviour change for them.

## Verification

`apps/cli` `commands-export.test.ts` (`npx vitest run --root apps/cli
commands-export.test.ts`, 5 passing): a behavioral test seeds a temp
`~/.muse` with both `notes-index.json` and `episodes-index.json`, runs
the real `buildMuseExport`, and asserts BOTH appear in `out.files`;
plus a catalog assertion that `DEFAULT_EXPORT_FILES` contains
`episodes-index.json`. Mutation-proven: removing the catalog entry
fails the behavioral test; restored green. `pnpm lint` 0/0; apps/cli
alone fully green (151 files / 1663 tests bar the known voice-playback
`/tmp` flake, which passes 12/12 in isolation); `pnpm check`
otherwise green (apps/api 323). Pure catalog change, no LLM path → no
smoke:live (Ollama down regardless).

## Decisions

- Backed up the index (a regenerable cache) rather than relying on
  re-index, because regeneration needs Ollama embeddings — exactly the
  dependency that's been unavailable all session — so a restore onto a
  machine without Ollama up would otherwise have no working recall and
  no signal why. The export already backs up `notes-index.json` on the
  same reasoning; this just makes the pair consistent.
