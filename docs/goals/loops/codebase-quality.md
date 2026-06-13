# Loop journal — `codebase-quality`

Theme: continuously raise Muse's internal code quality to top OSS standard —
decompose god-files, cohere scattered responsibility, recompose seams, remove
dead code, comment hygiene, and continue the in-flight `@muse/recall` extraction
(`commands-ask.ts` → `runGroundedRecall`). Tier1 (local commits on branch
`codebase-quality`, never push, never auto-merge to main). Worktree
`/tmp/muse-codebase-quality`. Cron `81ac643b` (every 15m, session-only).

## fire 1 · 2026-06-13 · loop-creator v1.14.0 · (this commit)
meta: value-class=refactor · pkg=@muse/recall · kind=cohere · verdict=PASS · firesSinceDrill=1
ratchet: testFiles 912 · fabrication 0 · groundedSurfaces 27 · recall tests 70/7 files
- **What:** moved the three PURE recall decision helpers — `shouldSuggestRepair`,
  `shouldWarnStrippedCitations`, `suggestOptInSource` (+ private GIT_INTENT_RE /
  SHELL_INTENT_RE) — out of `commands-ask.ts` into `@muse/recall/text.ts`; CLI
  imports + re-exports them (transitional). Added package tests for all three.
- **Why:** continues the @muse/recall extraction (project_recall_extraction
  "model-backed wrappers" cluster — the PURE subset; the truly model-backed
  `drawBestGroundedRedraft`/`groundingVerdictNotice` stay for a design slice).
  commands-ask.ts 2,994 → 2,940 LOC.
- **Review point:** behavior-preserving move; an independent Opus adversarial
  judge confirmed byte-identical bodies, intact call sites (lines 2481/2512/2694),
  no orphan const refs, slice touches exactly 3 files, grounding floor unchanged.
- **Risk:** none material — pure helpers, re-export keeps call sites/tests green.
  Remaining recall TODO: model-backed wrappers (design), weakness ledger, graph
  connections, then Phase 3 pipeline + API.

## fire 2 · 2026-06-13 · loop-creator v1.14.0 · (this commit)
meta: value-class=refactor · pkg=@muse/api · kind=dead-code · verdict=PASS · firesSinceDrill=2
ratchet: testFiles 913 · fabrication 0 · groundedSurfaces 27 · unused-exports 103→77
- **What:** removed 12 fully-dead functions from `apps/api/src/compat-parsers.ts`
  (stringArrayField/numberField/coerceNullableNumber/numberOrString/containsIgnoreCase/
  readQueryStringSet/readQueryInstantMillis/readNullableStringField/readOptionalStringField/
  nullableNumberResponse/dateOrUndefined/dateOrNull), dropped `isJsonValue` from the file's
  re-export (internal use kept via its import), removed those 13 names from the
  `compat-routes.ts` barrel re-export, and refreshed one stale comment. 250→189 LOC.
- **Why:** dead-code mandate; knip-confirmed unused (no importer incl. tests) and
  zero internal use. Diversity: fire 1 was @muse/recall/cohere; this is @muse/api/dead-code.
- **Review point:** independent Opus adversarial judge PASS — all 12 zero-ref, the six
  kept callees (coerceNumber/coerceStringArray/coerceStringSet/nullableStringResponse/
  epochMillisOrNull/readQueryString) still live, isJsonValue resolves from server-input-utils,
  api build 0 + compat targeted tests 40/40.
- **Risk:** none — pure removal, no live path touched. NOTE for a future fire: the rest of
  the `compat-routes.ts` barrel (chunkText/epochMillisOrNull/badRequest/… re-exports) is
  ALREADY largely unused (pre-existing) — a bigger barrel-cleanup ◦. `pnpm check` had 2
  unrelated CPU-contention flakes (@muse/messaging, @muse/model) that pass on re-run.
