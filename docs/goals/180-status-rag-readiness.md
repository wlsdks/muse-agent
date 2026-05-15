# 180 — `muse status` surfaces RAG readiness

## Why

Goals 164 / 167 / 168 made the embed model a first-class
health concern across `ask` / `setup local` / `doctor`. But the
flagship at-a-glance dashboard, `muse status`, surfaced
model / persona / tasks / trust / followups / cost — and said
nothing about whether semantic recall over notes
(`muse ask` / `muse recall`) is actually wired. Dog-food
flagged the dashboard as the daily glance; RAG state belongs
on it.

## Scope

- `apps/cli/src/commands-status.ts`:
  - `defaultNotesIndexFile()` (env `MUSE_NOTES_INDEX_FILE` or
    `~/.muse/notes-index.json`, matching ask/recall).
  - New exported `readRagStatus(path)` →
    `{ indexed, embedModel?, files? }`. **Offline** — a pure
    file read via the existing `safeReadJson`, same cost
    profile as the daily-cost sidecar; no network probe, so
    `status` stays fast. `indexed` = the index has ≥1 file.
  - `rag` added to the status object (additive — no
    schemaVersion bump per the goal-064 contract).
  - Text render: `rag: ready — notes index (N file(s),
    <model>)` or `rag: not indexed — run \`muse notes
    reindex\` …`.
- `apps/cli/test/program.test.ts`: new case — missing →
  `{indexed:false}`; model-but-no-files → not indexed;
  populated → ready+model; and the rendered line.

## Separation from `doctor`

`status` reports the **index artifact** state (offline, "is
there an index?"); `doctor` (168) probes the **live Ollama
model** ("can it actually run?"). Complementary, not
duplicative — status is the fast glance, doctor the deep
health check.

## Verify

- `pnpm --filter @muse/cli test` — 463 pass (1 new; existing
  status tests unaffected — `rag` is additive, no exact-object
  assertion broke).
- `pnpm check` exit 0; `pnpm lint` exit 0.
- Dog-food (real env): `muse status` →
  `rag: ready — notes index (2 file(s), nomic-embed-text)`.

## Status

done — the dashboard glance now answers "is my memory
searchable?", closing the 164/167/168 visibility line on the
one surface that was missing it.
