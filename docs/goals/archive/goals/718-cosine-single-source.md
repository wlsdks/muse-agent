# 718 — refactor: `muse ask` grounding reuses the single tested `cosine`, not a private untested duplicate

## Why

`apps/cli/src/commands-ask.ts` carried a private `cosine(a, b)` that was
byte-identical (modulo the `export` keyword) to the one exported from
`commands-notes-rag.ts` — both compute the similarity that ranks note
chunks for grounding. The exported copy is well-tested (degenerate
vectors, zero-norm, NaN, clean vectors); the `commands-ask` copy had no
tests. Two copies of a correctness-sensitive metric is a latent
divergence risk: a future fix to one (e.g. a different zero-norm or NaN
rule) would silently make `muse ask` grounding rank differently from
`muse notes search`. Consolidating to one tested source removes that
risk.

Rotated surface (PROCEDURE Step 8: recent iterations churned
actuator/channel/setup/vision/model/proactive). This iteration is a
small consistency/hardening pass after verifying — and finding already
robust — the relative-time resolver, all three cosine guards, the
embed-failure fail-soft path, `parseBoundedInt`, and create-time cron
validation.

## Slice

- `apps/cli/src/commands-ask.ts`: import `cosine` from
  `./commands-notes-rag.js` (alongside the already-imported
  `isNotesIndexStale`, `reindexNotes`) and delete the private duplicate.

## Verify

- `@muse/cli` 1249 tests green (commands-ask grounding tests exercise
  the path; commands-notes-rag.test.ts already covers `cosine`'s
  degenerate/zero-norm/NaN/clean cases).
- `pnpm check`: EXIT=0. `pnpm lint`: 0/0.
- Behavior-preserving — the function bodies were identical, so ranking
  output is unchanged; no LLM path or capability change (hence no
  CAPABILITIES line).

## Decisions

- **Import the existing export rather than extract a new shared util** —
  `commands-ask` already imports from `commands-notes-rag`, so reusing
  its exported `cosine` is the smallest change and keeps the grounding
  metric in one tested place; a third "shared math" module would be
  more churn for no benefit.
