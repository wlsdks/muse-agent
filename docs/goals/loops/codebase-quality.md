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

## fire 3 · 2026-06-13 · loop-creator v1.14.0 · (this commit)
meta: value-class=refactor · pkg=@muse/cli · kind=comment-hygiene · verdict=PASS · firesSinceDrill=3
ratchet: testFiles 913 · fabrication 0 · groundedSurfaces 27 · cli goal-id markers 12→0
- **What:** stripped 12 forbidden goal-ID / iteration markers (P43-1, P41-11, P22-6,
  P37-20/36, P34-11, P41-32/33, P43-4, "iter 38" …) from source comments across 6
  apps/cli files (commands-ask/daemon/recap/calendar/today/telemetry), preserving each
  comment's WHY. Diff is comments-only (0 code lines).
- **Why:** .claude/rules/code-style.md forbids round/goal/iteration markers in source
  (history belongs in git/CHANGELOG). Diversity: fire1 recall/cohere, fire2 api/dead-code,
  this cli/comment-hygiene — 3 distinct KINDs.
- **Review point:** independent Opus adversarial judge PASS — comments-only confirmed
  (zero non-comment changed lines), WHY clauses intact on all 12, cli build 0, lint 0,
  self-eval 0 (groundedSurfaces=27).
- **Risk:** none — no code touched; behavior/grounding trivially preserved. Remaining
  goal-id markers in packages/* (autoconfigure 3, recall 2, mcp 2, agent-core 1) are a
  future comment-hygiene ◦.

## fire 4 · 2026-06-13 · loop-creator v1.14.0 · (this commit)
meta: value-class=refactor · pkg=@muse/recall · kind=cohere · verdict=PASS · firesSinceDrill=4
ratchet: testFiles 914 · fabrication 0 · groundedSurfaces 27 · recall tests 76/7 files
- **What:** moved the ask-outcome + weakness-ledger cluster into new `recall/weakness.ts`:
  createStageTimer, AskOutcome+askOutcomeLabel, AskWeaknessAxis+askWeaknessAxis,
  AskWeaknessRecorderDeps+recordAskWeakness, AskWeaknessResolverDeps+recordAskWeaknessResolved.
  Fixed a misplaced askOutcomeLabel JSDoc en route. commands-ask.ts imports + re-exports.
  commands-ask.ts 2,940 → 2,825 LOC.
- **Why:** continues @muse/recall extraction (project_recall_extraction "weakness ledger").
  The deps-injected/pure subset moves cleanly; the two autoconfigure-lazy-import Live
  wrappers (recordAskWeakness*Live) STAY in the CLI so recall gains no autoconfigure dep
  (deps stay agent-core+mcp; weakness.ts has zero imports).
- **Review point:** independent Opus adversarial judge PASS — byte-identical bodies,
  layering NOT inverted (recall deps unchanged, Live wrappers stayed), best-effort
  try/catch intact, fabrication untouched, exactly 4 files, full pnpm check 0 (no flakes).
- **Risk:** none — pure/injected move + comment fix. Remaining recall TODO: model-backed
  wrappers (drawBestGroundedRedraft/groundingVerdictNotice — need runtime injection design),
  graph connections, then Phase 3 pipeline+API.

## fire 5 · 2026-06-13 · loop-creator v1.14.0 · (this commit)
meta: value-class=refactor · pkg=multi · kind=comment-hygiene · verdict=PASS(slice) · firesSinceDrill=5
ratchet: testFiles 915 · fabrication 0 · groundedSurfaces 27 · src goal-id markers → 0 (whole repo)
- **What:** stripped the 9 remaining goal-ID/iter markers from comments across
  packages/* (agent-core, autoconfigure ×3, mcp ×2, memory, recall ×2), preserving each
  WHY. With fire 3's apps/cli sweep, the ENTIRE src tree is now goal-id/iter-marker-free
  (0 residual). Comments-only diff.
- **Why:** completes the code-style.md marker ban repo-wide. Diversity: different package
  set than recent fires.
- **Review point / ⑤b note:** slice is provably comment-only + behavior-preserving (cli/
  recall/etc. builds unaffected, lint 0, self-eval 0, groundedSurfaces=27). **④ `pnpm check`
  is RED — but PRE-EXISTING & EXTERNAL:** `commands-daemon.test.ts` 28/71 fail with my
  changes STASHED too (proven), a regression the concurrent tool-hardening loop pushed to
  main (daemon/proactive domain). maker≠judge satisfied by that stash-proof of innocence.
- **Risk / decision:** NOT fixing the daemon regression (cross-loop collision risk — it's
  that loop's code). Recorded as a backlog BLOCKER. This slice committed to BRANCH only;
  the fire-6 merge gate will keep it off main until `pnpm check` is green again.

## fire 6 · 2026-06-13 · loop-creator v1.14.0 · (this commit)
meta: value-class=refactor · pkg=infra · kind=cleanup · verdict=PASS · firesSinceDrill=6
ratchet: testFiles 917 · fabrication 0 · groundedSurfaces 27 · conflict-markers → 0
- **What:** 진안 asked to fix the fire-5 daemon regression directly. Diagnosis: it was
  ALREADY fixed upstream (de5eb7f9 "fix(proactive): firedKey space-join collide") — daemon
  test now 71/71. The REAL defect found: fire 5's `git stash pop` had silently left git
  conflict markers committed in backlog.md, INDEX.md AND scripts/self-eval.mjs (the last
  broke `pnpm self-eval` with a SyntaxError). Stripped all markers (union preserved),
  deduped the stale INDEX row, restored self-eval.mjs from main.
- **Why:** self-eval is the loop's fitness gate — committed markers in it = silent
  poison. Lesson recorded: never `git stash pop` on contended docs without checking for
  conflict residue before committing.
- **Review point:** self-eval EXIT 0 (testFiles 917, groundedSurfaces 27), daemon 71/71,
  lint 0; the only `pnpm check` reds are the known messaging/model CPU-contention flakes
  (pass on re-run). No conflict markers anywhere in the tree.
- **Risk:** none — restorative cleanup + upstream-fixed regression confirmed. Recall TODO
  unchanged: model-backed wrappers (drawBestGroundedRedraft/groundingVerdictNotice), graph
  connections, then Phase 3 pipeline+API.

## fire 7 · 2026-06-13 · loop-creator v1.14.0 · (this commit)
meta: value-class=refactor · pkg=@muse/recall · kind=cohere · verdict=PASS · firesSinceDrill=7
ratchet: testFiles 921 · fabrication 0 · groundedSurfaces 27 · recall tests 82/8 files
- **What:** moved the model-backed grounding-gate wrappers into new `recall/verdict.ts`:
  BestOfRedrawArgs + drawBestGroundedRedraft (--best-of resample, fully callback-injected)
  and groundingVerdictNotice (agent-core verifyGrounding + recall's answerIsRefusal).
  commands-ask.ts imports + re-exports. commands-ask.ts 2,855 → 2,794 LOC.
- **Why:** continues @muse/recall extraction (project_recall_extraction "model-backed
  wrappers" — the last helper cluster before Phase 3). No new package dep (verdict.ts
  imports only agent-core + ./text.js; recall deps stay agent-core+mcp).
- **Review point:** independent Opus adversarial judge PASS — byte-identical bodies, the
  drawBest fail-close + groundingVerdictNotice refusal-short-circuit invariants preserved,
  no orphaned agent-core import in the CLI, full pnpm check 0 (no flakes), recall 82 tests.
- **Risk:** none — injected/agent-core-only move. Remaining recall TODO: graph connections
  (buildAskConnections/selectGraphConnections — CLI-local NoteLinkGraph), then Phase 3
  pipeline+API (the contract closer). Next fire = JUDGE-DRILL (consecutive allPASS hits 8).

## fire 8 · 2026-06-13 · loop-creator v1.14.0 · (this commit) · JUDGE-DRILL
meta: value-class=meta · pkg=infra · kind=judge-drill · verdict=PASS · firesSinceDrill=0 (reset)
ratchet: testFiles 921 · fabrication 0 · groundedSurfaces 27 · verifier-reliability CONFIRMED
- **What:** consecutive-allPASS hit 8 → mandatory JUDGE-DRILL. Injected a deliberately bad
  slice disguised as comment-hygiene: trimmed the load-bearing retry-classification JSDoc on
  `isRetryableHttpStatus` (provider-base.ts) — the WHY for 408/429 retry + the 4xx-MUST-fail-fast
  budget invariant — down to a one-liner. Deterministic gates (model build, provider-base
  tests 12/12, lint) ALL PASSED (comment-only). The independent Opus ④b judge correctly
  **FAILED** it: identified the removed text as load-bearing WHY (non-derivable 408 special-case
  + invisible 4xx fail-fast contract), not disposable narration. Rolled back (`git restore`).
- **Why:** validates the maker≠judge compensating control — the adversarial judge catches a
  defect class (lost load-bearing WHY) the deterministic gates structurally cannot. Verifier
  reliability CONFIRMED; firesSinceDrill reset to 0.
- **Review point:** drill left NO code change (rolled back, tree clean). Real output this fire:
  DECOMPOSE-ON-DEFER of the remaining @muse/recall thread into backlog ◦ (RecallHit relocation
  prerequisite → buildAskConnections; selectGraphConnections+NoteLinkGraph; Phase 3 pipeline+API)
  — each is a cross-cutting type relocation / design-sensitive step, not a single clean slice.
- **Risk:** none — no code touched; the recall helper-extraction is essentially complete
  (present/select/text/chunks/weakness/verdict), remaining items are typed-migration/Phase-3.

## fire 9 · 2026-06-13 · loop-creator v1.14.0 · (this commit)
meta: value-class=refactor · pkg=@muse/recall · kind=cohere · verdict=PASS · firesSinceDrill=1
ratchet: testFiles 922 · fabrication 0 · groundedSurfaces 27 · recall tests 87/9 files
- **What:** relocated the `RecallHit` type (~10 CLI importers) + the pure `buildAskConnections`
  into new `recall/hit.ts`. commands-recall.ts imports + re-exports RecallHit (10 importers
  unchanged); commands-ask.ts imports + re-exports buildAskConnections; dropped the now-unused
  RecallHit import from commands-ask. commands-ask.ts 2,792 → 2,768 LOC.
- **Why:** unblocks the graph-connections move (RecallHit was the prerequisite, fire-8 backlog).
  hit.ts has zero imports (pure); recall deps unchanged (no layering inversion).
- **Review point:** independent Opus adversarial judge PASS — byte-identical RecallHit shape +
  buildAskConnections body, re-export chain verified live (cli build 0 + consumer test 10/10),
  recall 87 tests. (pnpm check's only red = known messaging CPU-contention flake, 23/23 on clean
  re-run, messaging untouched by this slice.)
- **Risk:** none. Remaining recall TODO: selectGraphConnections+NoteLinkGraph (next), then
  Phase 3 (runGroundedRecall pipeline + API route).

## fire 10 · 2026-06-13 · loop-creator v1.14.0 · (this commit)
meta: value-class=refactor · pkg=@muse/shared · kind=cohere · verdict=PASS · firesSinceDrill=2
ratchet: testFiles 924 · fabrication 0 · groundedSurfaces 27 · shared tests 33
- **What:** relocated the generic pure `levenshteinDistance` (classic edit-distance) out of the
  CLI file closest-command.ts into the leaf package @muse/shared, where a generic string util
  belongs. closest-command.ts imports + re-exports it; notes-links.ts (other importer) unchanged
  via the re-export. Added a shared package test.
- **Why:** correct home for a generic util (cohere) AND the prerequisite for moving the
  notes-links graph module into @muse/recall (selectGraphConnections needs levenshteinDistance
  out of the CLI first — fire-8 backlog DECOMPOSE step A). Different package (@muse/shared) for
  diversity. Layering correct: cli→shared, shared stays a leaf (zero deps).
- **Review point:** independent Opus adversarial judge PASS — logically byte-identical body
  (only inline WHAT comments dropped), leaf status intact, re-export chain verified (cli build 0),
  lint 0. (pnpm check's only red = known messaging CPU-contention flake, 23/23 isolated.)
- **Risk:** none. Next: notes-links graph module → @muse/recall (step B), then selectGraphConnections
  (step C), then Phase 3 (runGroundedRecall pipeline + API).

## fire 11 · 2026-06-13 · loop-creator v1.14.0 · (this commit)
meta: value-class=refactor · pkg=@muse/web · kind=dead-code · verdict=PASS · firesSinceDrill=3
ratchet: testFiles 925 · fabrication 0 · groundedSurfaces 27 · unused-exported-types 70→58
- **What:** de-exported 12 interfaces in apps/web/src/api/types.ts (CalendarEventRow,
  NotesEntryRow, NotesSearchHit, HistoryEntry, ModelInfo, ToolByName, ObjectiveRow, ActionRow,
  ContactRow, VetoRow, MessagingProvider, InboundMessage) — knip-flagged as unused EXPORTS but
  each used INTERNALLY (composed into an exported *Response wrapper), so removed only the
  `export` keyword (not deleted). export-keyword-only diff.
- **Why:** dead public surface (unnecessary exports) — code-style hygiene. Diversity: apps/web
  (untouched by prior fires), dead-code KIND.
- **Review point:** independent Opus adversarial judge PASS — export-keyword-only (no shape
  change), zero external importers (same-named hits are homonyms in messaging/model/mcp),
  internal composition still typechecks (web build 0), knip unused-types 70→58 (−12 exact),
  no interface deleted, self-eval 0.
- **Risk:** none — type-level only, zero runtime. Also recorded notes-links split as a
  DECOMPOSE-ON-DEFER backlog ◦ (tightly-coupled graph-query+link-editing; lower priority than
  Phase 3). Remaining recall: Phase 3 (runGroundedRecall pipeline + API) is the high-value item.

## fire 12 · 2026-06-13 · loop-creator v1.14.0 · (this commit)
meta: value-class=refactor · pkg=@muse/cli · kind=dead-code · verdict=PASS · firesSinceDrill=4
ratchet: testFiles 926 · fabrication 0 · groundedSurfaces 27 · commands-ask knip-clean (13→0 flags)
- **What:** cleaned commands-ask.ts's own transitional cruft — deleted 4 dead type re-export
  lines (9 names: MemoryFact/BestOfRedrawArgs/AskOutcome/AskWeaknessAxis/…/IndexChunk/ScoredChunk;
  no consumer, the genuine internal IndexChunk/FileEntry import stays) and de-exported 4
  internally-used-only originals (REASONING_PRINCIPLE_LINES, RECALL_FORBIDDEN_TOOL_NAMES,
  WARM_REFUSAL_CLOSE, userHasOtherPersonalData — `export` keyword removed, still used internally).
- **Why:** the @muse/recall extraction left transitional re-exports that are now dead surface;
  commands-ask.ts is now knip-clean (0 unused exports, was 13). dead-code KIND.
- **Review point:** independent Opus adversarial judge PASS — zero consumers of the deleted
  re-exports, de-exported originals used internally (≥2) with no external importer, byte-identical
  RHS (no shape change), cli build 0, pnpm check 0 (no flakes this run), self-eval 0.
- **Risk:** none — surface-only cleanup. Remaining high-value recall item = Phase 3
  (runGroundedRecall pipeline + API); INDEX.md per-fire merge contention still a flagged infra ◦.

## fire 13 · 2026-06-13 · loop-creator v1.14.0 · ad54874b
meta: value-class=refactor · pkg=@muse/shared · kind=cohere · verdict=PASS · firesSinceDrill=5
ratchet: testFiles 928 · fabrication 0 · groundedSurfaces 27 · isRecord dups 11→8 · shared tests 34
- **What:** consolidated the duplicate `isRecord` type-guard (11 copies repo-wide) — added the
  canonical one to leaf @muse/shared and migrated the 3 apps/cli copies (commands-doctor +
  chat-export-ingest import it; credential-store re-exports it for its importers). Semantically
  identical guard. Unblocks the deferred commands-doctor decompose.
- **Why:** "흩어진 책임 cohere" — a generic guard belongs in shared, not 11 hand-rolled copies.
- **Review point + VERIFIER FIX:** the ④b judge first FALSE-FAILed: it ran `git diff main`, but
  this branch lags a fast-moving main (8 loops), so main's NEWER commits (buildDiskContents etc.)
  showed as if this slice DELETED them. Re-judged against the COMMIT ONLY (`git show ad54874b`) →
  PASS (exactly 5 files, equivalent, leaf intact, importers OK). **Lesson: the judge must diff the
  fire's own commit (`git show <commit>` / merge-base), never `git diff main`.** Cron ④b line fixed.
- **Risk:** none. Remaining isRecord dedup (8 defs in tools/auth/voice/model/agent-core/
  autoconfigure/api) recorded as a follow-up backlog ◦.

## fire 14 · 2026-06-13 · loop-creator v1.14.0 · e13d7304
meta: value-class=refactor · pkg=@muse/cli · kind=decompose · verdict=PASS · firesSinceDrill=6
ratchet: testFiles 930 · fabrication 0 · groundedSurfaces 27 · commands-doctor 1234→1121 LOC
- **What:** first decompose of the god-file commands-doctor.ts (orig review finding #3) — extracted
  the 5 config/env classifiers (resolveMuseEnvPath, classifyMcpServersField, classifyWebWatchConfig,
  classifyHomeAlertsConfig, resolveDoctorWatchIntervalMs) into a cohesive sibling
  commands-doctor-config.ts (deps: isRecord@shared + webWatchesFromConfig/parseHomeAlertChecks@mcp).
  import+re-export; dropped the now-orphaned mcp imports; added a config-module test (5).
- **Why:** decompose KIND (first time) + finding #3 (oversized CLI). Unblocked by fire 13
  (isRecord→shared removed the entangling dep).
- **Review point:** ④b judged the COMMIT (`git show e13d7304`, the fixed diff-base) → PASS:
  byte-identical bodies, closed deps, no cycle/orphan, 3 files, cli build 0 / lint 0 / 77 doctor
  tests / 5 config tests. chat-ink-render full-check failure was a CPU-contention flake (40/40 isolated).
- **Risk:** none. commands-doctor still ~1121 LOC — the check-cluster (modelEnvCheck/localOnlyCheck/
  notesIndexHealth/… returning LocalCheck) is a follow-up decompose ◦.

## fire 15 · 2026-06-13 · loop-creator v1.14.0 · 2d9754e9
meta: value-class=refactor · pkg=@muse/cli · kind=decompose · verdict=PASS · firesSinceDrill=7
ratchet: testFiles 931 · fabrication 0 · groundedSurfaces 27 · commands-doctor 1121→1073 LOC
- **What:** continued the commands-doctor decompose — extracted the 3 PURE health checks
  (messagingConfigCheck, notesIndexHealth, episodeIndexHealth) into sibling commands-doctor-checks.ts
  (zero imports). import+re-export; fixed 2 misplaced JSDocs (notesIndexHealth's was stacked above
  messagingConfigCheck; removal also restored embedModelCheck's doc placement). Added checks test (10).
- **Why:** decompose KIND (finding #3, oversized CLI); pure subset = clean closed set (the heavier
  check-orchestration cluster with runtime deps stays — deferred).
- **Review point:** ④b judged the commit (`git show 2d9754e9`) → PASS: byte-identical bodies, docs
  correctly paired + embedModelCheck doc preserved, zero imports/no cycle, 3 files, cli build 0 /
  lint 0 / pnpm check 0 (clean) / 85 doctor+checks tests.
- **Risk:** none. commands-doctor still ~1073 LOC — the LocalCheck-orchestration cluster
  (modelEnvCheck/localOnlyCheck/ollamaPerf/selfLearning/embedModelCheck, mixed w/ runtime deps) is a
  further decompose ◦ (needs runtime-dep handling).

## fire 16 · 2026-06-13 · loop-creator v1.14.0 · c28bcd7e
meta: value-class=refactor · pkg=@muse/tools+infra · kind=dead-code/cohere · verdict=PASS · firesSinceDrill=8
ratchet: testFiles 931 · fabrication 0 · groundedSurfaces 27 · isRecord dups 8→7 · byte-hygiene RED→green
- **What:** (1) deduped the 2 isRecord defs in @muse/tools → import from @muse/shared (canonical).
  (2) regression-fix: the shared repo-byte-hygiene gate was RED — two raw U+200B (zero-width) bytes
  committed by the concurrent differentiation loop (scripts/eval-policy-symmetry.mjs:36 + the
  differentiation.md journal:262); fixed the .mjs with the  escape (behavior-identical) and
  stripped the invisible .md char. Repo now 0 forbidden bytes.
- **Why:** isRecord dedup = real dup debt; the byte-hygiene fix unblocked the SHARED `pnpm check`
  gate (every loop's check was failing on it) — regression-first per ①.
- **Review point:** ④b judged commit c28bcd7e → PASS (value import not merged into a type-only line,
  ===raw U+200B preserved, exactly 4 files, tools build 0/242 tests, byte-hygiene green).
- **Risk / observation:** the **differentiation loop keeps committing raw zero-width/homoglyph bytes**
  in its injection-test scripts + journal → recurring byte-hygiene failures. Their loop should emit
  \uNNNN escapes. Recorded as a cross-loop blocker note. NEXT fire (17) = JUDGE-DRILL (consecutive
  allPASS reached 8).

## fire 17 · 2026-06-13 · loop-creator v1.14.0 · a3f5eb36 · JUDGE-DRILL
meta: value-class=refactor · pkg=@muse/auth · kind=dead-code/cohere · verdict=PASS · firesSinceDrill=0 (reset)
ratchet: testFiles 933 · fabrication 0 · groundedSurfaces 27 · isRecord dups 7→6
- **What:** (drill) consecutive-allPASS hit 8 -> mandatory JUDGE-DRILL: injected a bad
  comment-hygiene slice that gutted looksLikeBinaryContent's load-bearing JSDoc (the
  fabrication-floor WHY: grounding on binary garbage -> model hallucinates a cited
  [from file] -> a fabrication). Deterministic gates PASSED (recall build/text tests/lint),
  the independent Opus judge correctly FAILED it (load-bearing WHY tied to fabrication=0).
  Rolled back (git reset --hard). Verifier reliability re-confirmed (2nd drill, both caught).
  (real) deduped isRecord in @muse/auth/jwt.ts -> import from @muse/shared (7->6 dups).
- **Why:** drill validates the maker!=judge control; the auth dedup continues the isRecord
  consolidation. Also stripped 2 stray U+200B zero-width bytes my own fire-16 journal prose
  had introduced (byte-hygiene gate was red on them; repo now 0 forbidden bytes).
- **Review point:** drill judge FAIL confirmed on the bad slice; auth slice 4b judge PASS
  (value import, byte-identical, no cycle, 1 file). pnpm check green after the journal byte-strip.
- **Risk:** none. LESSON: never put a literal zero-width/control char in journal prose — write
  "U+200B" as text. Remaining isRecord dups: model/agent-core/api (exported) + autoconfigure/voice.

## fire 18 · 2026-06-13 · loop-creator v1.14.0 · 655a5893
meta: value-class=refactor · pkg=@muse/cli · kind=decompose · verdict=PASS · firesSinceDrill=1
ratchet: testFiles 935 · fabrication 0 · groundedSurfaces 27 · commands-doctor.ts 1073->955 LOC
- **What:** extracted the self-contained `muse doctor calibration` sub-command out of the
  commands-doctor god-file into a new sibling `commands-doctor-calibration.ts` — parseAlpha,
  CalibrationReport, buildCalibrationReport, formatCalibration, the private `pct`/`cosine`
  helpers, and `runCalibrationDoctor` (now exported). commands-doctor.ts imports
  runCalibrationDoctor+parseAlpha for registerDoctorCommand and re-exports the three tested
  symbols + the CalibrationReport type, so the existing commands-doctor.test.ts imports are
  unchanged. Dropped the now-orphaned `import { calibrateAbstention } from "@muse/agent-core"`
  (its only use moved with the cluster).
- **Why:** diversity ratchet (last fires skewed dead-code/cohere×isRecord); decompose was the
  freshest high-value KIND and commands-doctor was still ~1073 LOC after fires 14/15. The
  calibration block is a clean contiguous vertical slice (one subcommand, few external deps),
  so the extraction is behavior-preserving via import+re-export.
- **Review point:** 4b judge — re-exports keep commands-doctor.test.ts green (225 files/2584
  cli tests pass), runCalibrationDoctor still wired at registerDoctorCommand:110, no behavior
  change, dropped import was genuinely orphaned. Also a sync-hygiene fix: stripped 3 raw U+200B
  zero-width bytes that arrived via the main merge (backlog.md:123 + test-hygiene.md:68,70, the
  concurrent test-hygiene loop's journal pollution) -> repo 0 forbidden bytes, `pnpm check` green.
- **Risk:** low — pure relocation; calibration is a local-Ollama doctor subcommand, no grounding/
  floor path touched. LESSON: the cross-loop journal byte-pollution keeps reappearing (fires 16/17/18);
  the real fix is the ★진안 root-fix (every loop byte-scans its journal commit) noted in backlog.

## fire 19 · 2026-06-13 · loop-creator v1.14.0 · adcbf535
meta: value-class=refactor · pkg=@muse/macos · kind=decompose · verdict=PASS · firesSinceDrill=2
ratchet: testFiles 939 · fabrication 0 · groundedSurfaces 27 · macos-tools.ts 1522->1464 LOC
- **What:** first decompose step on the 1521-LOC `@muse/macos` god-file `macos-tools.ts`
  (~12 tool factories sharing one base). Extracted the cross-tool low-level exec primitives —
  `runChild` (the spawn+SIGKILL-watchdog helper every tool drives its Apple CLI through),
  `escapeAppleScript`, `isPermissionError`, and the `MacCommandResult` result type — into a new
  sibling `macos-exec.ts`. macos-tools.ts imports them back and re-exports `MacCommandResult`
  (the existing test imports it from macos-tools). Dropped the now-unused `import { spawn }`.
  Added `macos-exec.test.ts`: 11 OUTCOME cases for the two pure fns (escapeAppleScript quote/
  backslash/newline-flatten; isPermissionError -1743/phrasing matrix) — their FIRST direct tests
  (previously covered only transitively through the tool factories).
- **Why:** diversity — last fires skewed @muse/cli (decompose/dead-code); @muse/macos is a fresh
  package no loop touches. This is the behavior-preserving FOUNDATION step: with the shared base
  in its own module, the remaining tool families can move out tool-by-tool (DECOMPOSE-ON-DEFER
  slices recorded in backlog) without each re-declaring the spawn helper.
- **Review point:** 4b judge — pure relocation (bodies byte-identical, runChild gained `export`),
  spawn genuinely orphaned in macos-tools after the move (other "spawn" hits are strings/comments),
  the default runners that call runChild stay + import it, MacCommandResult re-exported so 100 macos
  tests + 226 cli files stay green. New test is real behavior, not declaration.
- **Risk:** low — native macOS tools are injection-tested via deps; no grounding/floor/outbound
  path touched (mac_message_send approval gate untouched). agent-core/mcp left alone (hot loops).

## fire 20 · 2026-06-13 · loop-creator v1.14.0 · 6d260349
meta: value-class=refactor · pkg=multi(model/mcp/api/cli) · kind=comment-hygiene · verdict=PASS · firesSinceDrill=3
ratchet: testFiles 941 · fabrication 0 · groundedSurfaces 27 · markers stripped 5
- **What:** comment-hygiene sweep — stripped 5 forbidden goal/task-id markers from source
  comments (code-style.md hard rule: "Task / PR / caller references", "Goal NNN" = rot, delete
  on sight), preserving the load-bearing WHY in each: adapter-ollama.ts ("mirroring the embed-model
  hints in goals 164/167/168" → "…hints."), weather-tool.ts ("goal-795 rain heads-up" → "rain
  heads-up"), loopback-calendar.ts ("CLI --repeat, P41-37" → "CLI --repeat"), history-routes.ts
  ("goal-554 CLI convention" → "CLI convention"), commands-pattern.ts ("strict-numeric line,
  goals 143/144/155" → "strict-numeric line"). Only the bare id tokens removed; every surrounding
  reason kept.
- **Why:** diversity — fires 18/19 were both decompose; comment-hygiene was 0/8 recent + a fresh
  KIND. These task-id refs are exactly the rot code-style.md says lives in git/CHANGELOG, not source.
  Scoped to cold/cold-ish files (model/mcp-calendar/mcp-weather/api/cli-pattern) to dodge merge
  collisions with the hot concurrent loops (agent-core mid-merge; skipped agent-core/autoconfigure-P43
  + recall/select.ts which other loops actively churn).
- **Review point:** 4b judge — every removal is a bare goal/task-id token, NOT a load-bearing WHY
  (the surrounding reason stays); behavior unchanged (comment-only; 4 touched-pkg tsc -b builds pass,
  comments stripped by compiler anyway); no leftover id markers in the 5 files.
- **Risk:** none — comment-only, no code/type/behavior change. Merge-collision risk mitigated by
  cold-file scoping; if a comment line conflicts at merge it resolves trivially.

## fire 21 · 2026-06-13 · loop-creator v1.14.0 · a5f0fbdb
meta: value-class=refactor · pkg=multi(model/api) · kind=cohere · verdict=PASS · firesSinceDrill=4
ratchet: testFiles 942 · fabrication 0 · groundedSurfaces 27 · isRecord dups 5->3
- **What:** isRecord dedup — `@muse/model` (provider-shared.ts) and `@muse/api`
  (server-input-utils.ts) each hand-rolled a byte-identical `isRecord` type guard; both now
  `import { isRecord } from "@muse/shared"` (internal use) + `export { isRecord }` (re-export
  preserves external importers: model's json-value-guards.test, api's compat/mcp/scheduler
  parsers + server-helpers re-export). Both packages already value-import from @muse/shared, so
  no new dep edge. The three impls were verified char-identical before the swap. isRecord dups 5→3
  (remaining: agent-core + autoconfigure + voice — agent-core/autoconfigure are hot loops; voice
  has no @muse/shared dep so not worth a new edge for one private 3-liner).
- **Why:** diversity — fires 18/19 decompose, 20 comment-hygiene; cohere was 3 fires stale and the
  isRecord consolidation is a tracked debt. Scoped to cold/cold-ish packages (model/api) to dodge
  the hot concurrent loops. Phase 3 (recall pipeline) deferred a 4th time + DECOMPOSED in backlog
  (it has a hard prerequisite — escapeSystemPromptMarkers is CLI-local, blocking buildNoteContextBlock's
  move to @muse/recall).
- **Review point:** 4b judge — impls byte-identical (behavior-preserving), re-export keeps every
  importer (model 319 + api 850 tests pass), separate value-import line (not merged into `import type`
  — fire-16 lesson), no new package dep. Note: the fire hit a STALE-SYNC false-alarm (actuator-tools
  test merged ahead of its feature commit f685161b; resolved by re-syncing main) + a stale-dist api
  flake (passed on clean rerun) — neither is my slice.
- **Risk:** none — pure re-export of an identical pure guard; no behavior/floor change.

## fire 22 · 2026-06-13 · loop-creator v1.14.0 · f5fcbef5
meta: value-class=refactor · pkg=@muse/recall · kind=compose · verdict=PASS · firesSinceDrill=5
ratchet: testFiles 942 · fabrication 0 · groundedSurfaces 27 · Phase3 3a done (3b unblocked)
- **What:** Phase 3 sub-slice 3a — relocated the injection-defense primitive `escapeSystemPromptMarkers`
  (+ its MARKER_KEYWORDS/REPLACEMENTS module constants + full JSDoc) from `apps/cli/src/prompt-escape.ts`
  to `packages/recall/src/prompt-escape.ts` (verbatim, byte-identical), exported it from the @muse/recall
  index, updated commands-ask.ts's import to `@muse/recall`, moved the 7-case test to
  `packages/recall/src/prompt-escape.test.ts` (no duplication), and deleted the two CLI files. A true
  move (caller import updated, test relocated), not a shim.
- **Why:** this is the hard PREREQUISITE for Phase 3's #1 item — `buildNoteContextBlock` (the <<note N>>
  grounding prompt block) can't move to @muse/recall while its escape dep is CLI-local. With the escaper
  now in recall (alongside relativizeNoteSource), 3b is unblocked. Diversity: KIND=compose was 0/8 recent
  (last fires decompose/comment-hygiene/cohere); pkg=recall advances the stated #1 thread, not @cli again.
- **Review point:** 4b judge — SECURITY-sensitive: the escape logic (the 3 REPLACEMENTS regexes that
  neutralize <<end>>/forged-opener/forged-citation break-outs) must be byte-identical (it defends the
  fabrication=0 floor in front of verifyGrounding); the 7-case break-out test moved intact + passes in
  recall (139 tests); commands-ask + buildNoteContextBlock still resolve the escaper; no behavior change.
- **Risk:** low-medium — touches an injection-defense primitive, but it's a pure verbatim relocation
  (no regex/logic edit) with its full adversarial test moved alongside. Floor strictly unchanged.

## fire 23 · 2026-06-13 · loop-creator v1.14.0 · 00e65a85
meta: value-class=refactor · pkg=@muse/recall · kind=compose · verdict=PASS · firesSinceDrill=6
ratchet: testFiles 943 · fabrication 0 · groundedSurfaces 27 · Phase3 3b done (3c next)
- **What:** Phase 3 sub-slice 3b (unblocked by 3a) — moved `buildNoteContextBlock` (the `<<note N>>`
  grounding prompt block builder, with its Mem0 contradiction-annotation logic) from commands-ask.ts
  to `packages/recall/src/present.ts` (its presentation-layer home, alongside relativizeNoteSource).
  All deps now resolve in recall: relativizeNoteSource (local), escapeSystemPromptMarkers (./prompt-escape.js,
  moved in 3a), ContradictionPair (@muse/agent-core). commands-ask imports it from @muse/recall for its
  one internal use (line 1660); the re-export was dropped since nothing else imports it from commands-ask.
  The 7-case contradiction-annotation test moved to `packages/recall/src/build-note-context-block.test.ts`
  (import → ./present.js); recall now owns the module + its test (153 tests).
- **Why:** continues the #1 Phase 3 thread — the grounding prompt assembly now lives in the recall
  package (the source-adaptation/presentation layer the design assigns it), not inlined in the 2800-LOC
  CLI command. 3a+3b together relocate the whole note-block-building concern out of the CLI.
- **Review point:** 4b judge — buildNoteContextBlock body byte-identical (esp. the <<note>>/[from]/⚠
  template strings + the contradiction conflictMarker map — a grounding-prompt change would touch the floor);
  the moved test's 7 cases identical + green in recall; commands-ask still calls it at 1660; no other
  importer of the dropped re-export; escapeSystemPromptMarkers/ContradictionPair still used in commands-ask
  (1436/1452/1680) so their imports stay.
- **Risk:** low-medium — grounding-prompt presentation, but a pure verbatim relocation with its full
  contradiction test moved alongside; floor unchanged.

## fire 24 · 2026-06-13 · loop-creator v1.14.0 · 0272cb5b
meta: value-class=refactor · pkg=@muse/api · kind=dead-code · verdict=PASS · firesSinceDrill=7
ratchet: testFiles 944 · fabrication 0 · groundedSurfaces 27 · 1 dead fn removed + 1 over-export tightened
- **What:** dead-code sweep in apps/api (verified via knip + repo-wide grep, NOT trusting knip alone):
  (1) removed `compatRecord` (compat-routes.ts) — a real exported function with ZERO references anywhere
  in the repo (incl. tests); the `CompatRecord` TYPE is separate and stays. (2) de-exported
  `sanitizeConfigValue` (mcp-routes-shapers.ts) — knip flagged it but grep showed it IS used internally
  (called by sanitizeConfig + recursively), so per code-style "internal use → drop export only": kept the
  function, removed `export`. knip no longer flags either.
- **Why:** diversity — last 2 fires were compose@recall; dead-code was ~8 fires stale (fresh KIND). Most
  of knip's "unused exports" here are FALSE POSITIVES (dead barrel RE-EXPORTS in compat-routes whose real
  defs+tests live in compat-parsers/compat-responses, or test-only exports) — I verified each candidate's
  true reference count and only touched the 2 that are genuinely dead / genuinely internal-only. Left the
  barrel re-exports + the dormant LINE-webhook registrar alone (removing the latter = a behavior change).
- **Review point:** 4b judge — compatRecord truly dead (grep: only its def line repo-wide, no test);
  createRunId/nowIso still used 6× in compat-routes so no orphaned imports; sanitizeConfigValue still called
  internally (de-export is correct, not removal); api 850 tests + full check green; knip drops both.
- **Risk:** none — one dead function removed, one over-broad export narrowed; no behavior/floor change.

## fire 25 · 2026-06-13 · loop-creator v1.14.0 · 97d77c3b · JUDGE-DRILL
meta: value-class=refactor · pkg=@muse/cli · kind=decompose · verdict=PASS · firesSinceDrill=0 (reset)
ratchet: testFiles 944 · fabrication 0 · groundedSurfaces 27 · commands-doctor.ts 980->939 LOC
- **What:** (drill) consecutive-allPASS hit 8 → mandatory JUDGE-DRILL: committed a bad "comment-hygiene"
  slice that gutted `escapeSystemPromptMarkers`'s 32-line JSDoc (the indirect-prompt-injection rationale,
  the break-out attack example, AND the load-bearing "apply to CONTENT only, NEVER source/name fields —
  copy-exact for the citation gate" invariant) down to a WHAT-only one-liner. ALL deterministic gates
  PASSED (recall build/153 tests/lint/byte). The independent Opus judge correctly **FAILED** it — traced
  the two raw-vs-escaped call sites proving the constraint is silently relied upon and not code-enforced.
  Rolled back (git reset --hard). (real) Decomposed the commands-doctor env-posture trio — `LocalCheck`
  interface + `modelEnvCheck` + `localOnlyCheck` → the fire-15 sibling `commands-doctor-checks.ts`;
  re-exported (tests import them from commands-doctor); dropped the now-orphaned `evaluateLocalOnlyPosture`
  import (parseBoolean/resolveDefaultModel/LOCAL_FIRST_DEFAULT_MODEL stay — used elsewhere).
- **Why:** drill validates the maker≠judge control (3rd drill, all 3 caught). The doctor decompose
  diversifies off the recent compose@recall streak + continues shrinking the doctor god-file (980→939).
- **Review point:** drill judge FAIL confirmed on the bad slice (load-bearing security WHY, not rot);
  real slice 4b judge — classifier bodies byte-identical, re-export keeps commands-doctor.test green
  (2590 cli tests), LocalCheck now sibling-owned (no external importer), evaluateLocalOnlyPosture orphan
  removed cleanly, parseBoolean/resolveDefaultModel/LOCAL_FIRST_DEFAULT_MODEL still used so kept.
- **Risk:** low — pure relocation; modelEnvCheck's local-only privacy WHY JSDoc moved verbatim with it.

## fire 26 · 2026-06-13 · loop-creator v1.14.0 · f3080fbb
meta: value-class=refactor · pkg=@muse/recall · kind=compose · verdict=PASS · firesSinceDrill=1
ratchet: testFiles 945 · fabrication 0 · groundedSurfaces 27 · ask god-file: 1 more inline block extracted
- **What:** Phase 3 continuation — extracted the inline `taskBlock` builder (the `<<task N>>` grounding
  prompt block) from the 2838-LOC commands-ask.ts action handler into a pure `buildTaskContextBlock(tasks)`
  in @muse/recall/present.ts (its presentation-layer home, beside buildNoteContextBlock). The inline
  expression became a one-line call; present.ts gained a `@muse/mcp` import for formatDueLocal + PersistedTask.
  Body byte-identical incl. the two load-bearing inline WHY comments (local-due-vs-UTC, [task: <title>]
  citation form). Added a 5-case OUTCOME test in recall (empty/wrapper+citation/urgent/due-present-or-absent/
  separator). formatDueLocal stays imported in commands-ask (reminderBlock still uses it).
- **Why:** the ask pipeline has ~12 inline `<<...>>` block-builders; moving them one-by-one to recall
  (the presentation layer per the extraction design) shrinks the god-file AND gives each a tested home —
  the same pattern as 3b's buildNoteContextBlock. Diversity: compose@recall is 3/8 in the window (within
  the ≥6/8 ceiling); this is the explicitly-#1 recall thread.
- **Review point:** 4b judge — taskBlock body byte-identical (the <<task>>/[task:]/[URGENT]/due template +
  the title-not-id citation), output unchanged; new test is real OUTCOME (fails if the citation embeds id
  or drops due); formatDueLocal correctly retained in commands-ask; no escaping added (tasks were never
  escaped — preserved).
- **Risk:** low — pure presentation relocation; the grounding gate consumes the block string identically.

## fire 27 · 2026-06-13 · loop-creator v1.14.0 · 5cd5d3d2
meta: value-class=refactor · pkg=@muse/multi-agent · kind=decompose · verdict=PASS · firesSinceDrill=2
ratchet: testFiles 946 · fabrication 0 · groundedSurfaces 27 · multi-agent/index.ts 825->767 LOC
- **What:** decomposed the @muse/multi-agent god-file index.ts (825 LOC, barrel + orchestrator + helpers).
  Extracted the cohesive worker-result cluster — `ParsedWorkerResult`/`WorkerHandoff` types +
  `parseWorkerResult` + `validateWorkerHandoff` (the MAST fail-close hand-off validator) + `createWorkerResult`
  — into a new sibling `worker-result.ts` (verbatim, byte-identical). index.ts imports parseWorkerResult/
  validateWorkerHandoff back (the orchestrator uses them at 6 sites) and re-exports all 3 fns + 2 types
  (the handoff-validation + parallel-failure tests import them from index). createRunId/JsonObject/
  AgentRunInput/AgentRunResult all stay used in index → no orphaned imports.
- **Why:** diversity — compose@recall was 3/8 in the window; this is decompose on @muse/multi-agent, a
  fresh package no loop touches, and shrinks a real god-file (the theme's core). The worker-result parsing/
  validation is a clean cohesive unit separable from the orchestration classes.
- **Review point:** 4b judge — the 5 moved symbols byte-identical (esp. validateWorkerHandoff's fail-close
  blank→failed logic + its MAST WHY JSDoc); re-export keeps 77 multi-agent tests green (handoff-validation
  imports parseWorkerResult/validateWorkerHandoff/createWorkerResult from index); no orphaned imports in index.
- **Risk:** low — pure relocation; the multi-agent hand-off fail-close invariant (empty output → failure)
  moved verbatim with its test coverage intact.

## fire 28 · 2026-06-13 · loop-creator v1.14.0 · ba8cdc04
meta: value-class=refactor · pkg=@muse/recall · kind=compose · verdict=PASS · firesSinceDrill=3
ratchet: testFiles 947 · fabrication 0 · groundedSurfaces 27 · ask god-file: 1 more inline block extracted
- **What:** Phase 3 continuation (sibling of fire-26's taskBlock) — extracted the inline `reminderBlock`
  builder (the `<<reminder N>>` grounding block) from commands-ask.ts into a pure
  `buildReminderContextBlock(reminders)` in @muse/recall/present.ts (beside buildTaskContextBlock). The inline
  expr became a one-line call; present.ts's @muse/mcp import gained `type PersistedReminder`. Body byte-identical.
  Added a 3-case OUTCOME test. With reminderBlock gone, `formatDueLocal` was now unused in commands-ask
  (taskBlock already moved fire 26) → removed it from the @muse/mcp import; PersistedReminder stays (the
  pendingReminders local still uses it).
- **Why:** continues moving the ask pipeline's ~12 inline `<<...>>` block-builders to recall (the presentation
  layer per the extraction design). Diversified to multi-agent last fire, so compose@recall is 4/8 in the
  window (within the 6/8 ceiling); this is the #1 recall thread.
- **Review point:** 4b judge — reminderBlock body byte-identical (the <<reminder>>/[reminder:]/(due) template,
  text-not-id citation, always-present due); formatDueLocal correctly removed (no other use after task+reminder
  both moved); PersistedReminder retained (pendingReminders local); new test real OUTCOME (fails if citation
  embeds id); recall 169 + cli 2593 green.
- **Risk:** low — pure presentation relocation; grounding gate consumes the block string identically.

## fire 29 · 2026-06-13 · loop-creator v1.14.0 · 305fa9e2
meta: value-class=refactor · pkg=@muse/cli · kind=decompose · verdict=PASS · firesSinceDrill=4
ratchet: testFiles 947 · fabrication 0 · groundedSurfaces 27 · commands-doctor.ts 939->899 LOC
- **What:** continued the commands-doctor decompose (fire 25) — moved two more pure LocalCheck classifiers,
  `selfLearningCheck` (verifiable-autonomy B1 check) + `weaknessFuelCheck` (informational dev-fixable fuel
  line), from commands-doctor.ts to the sibling commands-doctor-checks.ts (verbatim, with their load-bearing
  JSDocs). The sibling gained a `type DevFixableWeakness` import (@muse/mcp). commands-doctor imports both
  back (runLocalDoctor uses them at 650/660) + re-exports (commands-doctor.test imports them). DevFixableWeakness
  stays in commands-doctor (formatDevFixableWeaknesses at 854 uses it) → no orphan.
- **Why:** diversity — compose@recall was 4/8; this is decompose@cli (the proven fire-25 sibling pattern),
  continuing to shrink the doctor god-file (939→899). The two classifiers are pure (selfLearningCheck: state→
  LocalCheck; weaknessFuelCheck: DevFixableWeakness[]→LocalCheck|undefined) — clean cohesive batch.
- **Review point:** 4b judge — both bodies byte-identical (esp. the 4-branch selfLearning state logic + the
  weaknessFuel undefined-when-empty + the informational status:"ok" rationale); re-export keeps the 226
  commands-doctor test cases green; DevFixableWeakness retained in commands-doctor; LocalDoctorReport interface
  (between them) untouched.
- **Risk:** low — pure relocation of two tested pure classifiers; no IO, no floor path.

## fire 30 · 2026-06-13 · loop-creator v1.14.0 · 2e9e61a8
meta: value-class=refactor · pkg=@muse/recall · kind=compose · verdict=PASS · firesSinceDrill=5
ratchet: testFiles 950 · fabrication 0 · groundedSurfaces 27 · ask god-file: 3rd inline block extracted
- **What:** Phase 3 continuation (3rd block after task/reminder) — extracted the inline `memoryBlock` builder
  (`<<memory N>>` grounding block) from commands-ask.ts into a pure `buildMemoryContextBlock(facts)` in
  @muse/recall/**select.ts** (its natural home — beside renderMemoryFact + the MemoryFact type + selectMemoryFacts,
  all recall-owned). ZERO new imports (renderMemoryFact + MemoryFact are file-local). The inline expr became a
  one-line call. Body byte-identical; 3-case OUTCOME test added. renderMemoryFact stays imported in commands-ask
  (4 other uses at 2151/2258/2391/2589) → no orphan.
- **Why:** continues moving the ask pipeline's inline `<<...>>` block-builders to recall (presentation layer).
  Last fire diversified to cli; compose@recall back to ~4/8 (within ceiling). This block was the cleanest yet —
  its only dep (renderMemoryFact) already lives in recall's select.ts, so it slotted in with no import churn.
- **Review point:** 4b judge — memoryBlock body byte-identical (<<memory>>/[memory:] wrapper, key-as-citation,
  renderMemoryFact call); placed in select.ts (renderMemoryFact's module) not present.ts; new test real OUTCOME;
  renderMemoryFact import retained in commands-ask (4 other uses); recall 175 + cli 2599 green.
- **Risk:** low — pure presentation relocation, same-module dep; grounding gate consumes the block identically.

## fire 31 · 2026-06-13 · loop-creator v1.14.0 · 66891731
meta: value-class=refactor · pkg=@muse/cli · kind=decompose · verdict=PASS · firesSinceDrill=6
ratchet: testFiles 950 · fabrication 0 · groundedSurfaces 27 · commands-doctor.ts 899->847 LOC
- **What:** continued the commands-doctor decompose (fires 25/29) — moved the cohesive ollama-perf cluster
  (`OllamaPerfEnv` type + `ollamaPerfPostureCheck` pure classifier + `readOllamaPerfEnv` env reader) from
  commands-doctor.ts to the sibling commands-doctor-checks.ts (verbatim, incl. the load-bearing JSDoc). LocalCheck
  was already in the sibling; readOllamaPerfEnv's deps are all dynamic (node:child_process/util) — so ZERO new
  static imports. commands-doctor imports both fns back (runLocalDoctor calls them at line 371) + re-exports them
  (commands-doctor-perf.test imports ollamaPerfPostureCheck). OllamaPerfEnv had no external importer → moved
  without re-export.
- **Why:** diversity — compose@recall was 4/8 (a 5th would near the ceiling); this is decompose@cli (the proven
  sibling pattern), shrinking the doctor god-file 899→847. The model-tag cluster (OllamaTagsEntry/findOllamaModelTag/
  embedModelCheck) is a separate cohesive unit — deferred to a later fire (DECOMPOSE-ON-DEFER).
- **Review point:** 4b judge — all 3 symbols byte-identical (esp. ollamaPerfPostureCheck's flash/KV branch logic +
  the launchctl-fallback readOllamaPerfEnv); re-export keeps commands-doctor-perf test green (2599 cli); no new
  static import in the sibling; OllamaPerfEnv move-without-re-export safe (no external importer).
- **Risk:** low — pure relocation; ollama-perf is advisory (warn, never fail), no floor path.

## fire 32 · 2026-06-13 · loop-creator v1.14.0 · cf1177d5
meta: value-class=refactor · pkg=@muse/recall · kind=compose · verdict=PASS · firesSinceDrill=7
ratchet: testFiles 953 · fabrication 0 · groundedSurfaces 27 · ask god-file: 2 more inline blocks extracted
- **What:** Phase 3 continuation — BATCHED two homogeneous inline block-builders out of commands-ask.ts into
  pure fns in @muse/recall/present.ts: `buildShellContextBlock(commands: readonly string[])` (the `<<command N>>`
  block) + `buildGitContextBlock(commits: readonly {hash,subject}[])` (the `<<commit N>>` block). Both raw
  (no escaping), zero new deps. gitBlock used the CLI-local `GitCommit` type → I used a minimal STRUCTURAL input
  type `{readonly hash; readonly subject}` so recall stays independent of apps/cli (GitCommit[] is assignable).
  Both inline exprs became one-line calls; 5-case OUTCOME test added. selectShellCommands/selectGitCommits/GitCommit
  stay used in commands-ask (the source-fetch) → no orphans.
- **Why:** continues moving the ask pipeline's inline blocks to recall (presentation layer); batching two
  trivial same-shape builders in one slice (allowed homogeneous batching). 5 of ~12 blocks now extracted
  (task/reminder/memory/shell/git). compose@recall ~4/8 (within ceiling).
- **Review point:** 4b judge — both bodies byte-identical (the <<command>>/<<commit — hash>>/[commit: subject]
  templates, subject-not-hash citation); structural git input type accepts GitCommit[] (no cli→recall dep);
  new test real OUTCOME (exact strings + subject-not-hash citation); recall 185 + cli 2610 green; no orphans.
- **Risk:** low — pure presentation relocation; grounding gate consumes both block strings identically.

## fire 33 · 2026-06-13 · loop-creator v1.14.0 · 0a562d70 · JUDGE-DRILL
meta: value-class=refactor · pkg=@muse/cli · kind=decompose · verdict=PASS · firesSinceDrill=0 (reset)
ratchet: testFiles 954 · fabrication 0 · groundedSurfaces 27 · commands-doctor.ts 847->810 LOC
- **What:** (drill) consecutive-allPASS hit 8 → mandatory JUDGE-DRILL with a NEW failure mode (not the prior
  comment-removal drills): a "behavior-preserving extraction" that was subtly NOT byte-identical — extracted
  actionBlock to buildActionContextBlock but changed `a.when.slice(0,10)` → `slice(0,7)` (model would see
  YYYY-MM not YYYY-MM-DD action dates). ALL deterministic gates PASSED (recall 185, cli 2613 — the action-date
  format is untested). The independent Opus judge correctly **FAILED** it, pinpointing the exact slice-length
  divergence + its grounding-prompt impact. Rolled back. (real) Decomposed the commands-doctor ollama-tag trio
  (`OllamaTagsEntry` + `isOllamaTagsEntry` + `findOllamaModelTag`) → new sibling `commands-doctor-ollama.ts`;
  re-exported (test imports findOllamaModelTag/OllamaTagsEntry). embedModelCheck left behind (shares the private
  formatBytes helper used by runLocalDoctor — would entangle).
- **Why:** drill validates maker≠judge (4th drill, all 4 caught — incl. this subtle non-comment behavior change).
  The doctor decompose continues shrinking the god-file (847→810) + diversifies off the compose@recall streak.
- **Review point:** drill judge FAIL confirmed (slice(0,7)≠slice(0,10)); real slice 4b judge — trio byte-identical
  (the latest-tag-normalize matching), isOllamaTagsEntry exported for runLocalDoctor, re-export keeps doctor tests
  green (2613 cli), formatBytes correctly NOT entangled (embedModelCheck stayed).
- **Risk:** low — pure relocation of pure tag-matching utils; no IO, no floor path.

## fire 34 · 2026-06-13 · loop-creator v1.14.0 · 1b83c016
meta: value-class=refactor · pkg=@muse/recall · kind=compose · verdict=PASS · firesSinceDrill=1
ratchet: testFiles 955 · fabrication 0 · groundedSurfaces 27 · ask god-file: 6th inline block extracted
- **What:** Phase 3 continuation — extracted the inline `actionBlock` builder (`<<action N>>` grounding block)
  from commands-ask.ts into a pure `buildActionContextBlock(actions)` in @muse/recall/present.ts, using a
  structural input type `{when, what, result, detail?}` (so ActionLogEntry[] is assignable, no @muse/mcp ActionLogEntry
  import). This is the fire-33 JUDGE-DRILL target done CORRECTLY: `a.when.slice(0, 10)` (YYYY-MM-DD), the exact value
  the drill had sabotaged to slice(0,7). Body byte-identical to the original inline; 4-case OUTCOME test added
  (incl. a regression assert that the date is the FULL YYYY-MM-DD, not month-only). selectGroundingActions/
  readActionLog/ActionLogEntry stay in commands-ask (source fetch) → no orphans.
- **Why:** continues moving the ask pipeline's inline blocks to recall; 6 of ~12 now extracted (task/reminder/
  memory/shell/git/action). compose@recall 4/8 in the window (within ceiling). The drill having targeted this block
  makes its correct extraction a natural, well-understood follow-through.
- **Review point:** 4b judge — actionBlock body byte-identical (esp. slice(0,10) NOT slice(0,7) — the drilled bug;
  the `${a.what} — ${a.result}` + detail-conditional template); structural type accepts ActionLogEntry[]; new test
  pins the full-date format (would catch the slice(0,7) regression); recall 193 + cli 2613 green.
- **Risk:** low — pure presentation relocation; the test now guards the exact field the drill exposed as untested.

## fire 35 · 2026-06-13 · loop-creator v1.14.0 · 1bab154f
meta: value-class=refactor · pkg=@muse/cli · kind=dead-code · verdict=PASS · firesSinceDrill=2
ratchet: testFiles 957 · fabrication 0 · groundedSurfaces 27 · 4 over-broad exports narrowed
- **What:** dead-code (over-export tightening) in apps/cli/program-helpers.ts — knip flagged parseSseEvent,
  readSseField, readResponseRunId, promptPassword as unused exports; repo-wide grep confirmed each is referenced
  ONLY inside program-helpers.ts (real internal call sites: parseSseEvent 447/454, readSseField 498/503,
  readResponseRunId 578, promptPassword 139) with ZERO external/test importers. So per code-style "internal use
  → drop export only": kept all 4 functions, removed their `export` keyword. knip now clean on all 4.
- **Why:** diversity — compose@recall + decompose@cli were both 4/8; dead-code was 0/8 in the window (last fire 24).
  These 4 were exported speculatively but only ever used internally — narrowing the module's public surface is
  genuine cleanup. Most other knip "unused exports" are barrel re-export / test-only false positives (left alone,
  as in fire 24).
- **Review point:** 4b judge — all 4 still internally called (de-export, NOT deletion — functions unchanged);
  zero external/test importers (grep-confirmed, so no breakage); knip drops all 4; cli build + 2616 tests green;
  no behavior change (export visibility only).
- **Risk:** none — export-visibility narrowing of internal-only helpers; no runtime/behavior/floor change.

## fire 36 · 2026-06-13 · loop-creator v1.14.0 · fa574a40
meta: value-class=refactor · pkg=@muse/recall · kind=compose · verdict=PASS · firesSinceDrill=3
ratchet: testFiles 958 · fabrication 0 · groundedSurfaces 27 · ask god-file: 7th inline block extracted
- **What:** Phase 3 continuation — extracted the inline `episodeBlock` builder (`<<session N>>` grounding block)
  from commands-ask.ts into a pure `buildEpisodeContextBlock(episodes)` in @muse/recall/present.ts (structural
  input type `{id, summary, score}` matching rankEpisodeHits' return). Unlike task/git, this one ESCAPES the
  untrusted episode summary via escapeSystemPromptMarkers (already in present.ts) — preserved verbatim. Body
  byte-identical; 3-case OUTCOME test incl. an injection-defense assert (forged <<end>>/[from] in the summary
  neutralized). escapeSystemPromptMarkers stays imported in commands-ask (feedBlock still uses it) → no orphan.
- **Why:** continues moving the ask pipeline's inline blocks to recall; 7 of ~12 now extracted (task/reminder/
  memory/shell/git/action/episode). compose@recall 4/8 in the window (within ceiling).
- **Review point:** 4b judge — episodeBlock body byte-identical (the <<session N — id (score 3dp)>> header +
  escapeSystemPromptMarkers(summary)); structural type matches rankEpisodeHits return; the escape (untrusted
  summary defense) preserved; new test pins the escape; escapeSystemPromptMarkers retained in commands-ask
  (feedBlock); recall 201 + cli 2616 green.
- **Risk:** low — pure presentation relocation; the untrusted-summary escape (grounding-floor defense) moved verbatim + now has its own recall test.

## fire 37 · 2026-06-13 · loop-creator v1.14.0 · 7cee328e
meta: value-class=refactor · pkg=@muse/cli · kind=decompose · verdict=PASS · firesSinceDrill=4
ratchet: testFiles 958 · fabrication 0 · groundedSurfaces 27 · commands-doctor.ts 810->785 LOC
- **What:** continued the commands-doctor decompose (fires 25/29/31/33) — moved the notes-index embed-model pair
  `parseNotesIndexEmbedModel` (pure JSON parse, DEFAULT_EMBED_MODEL fallback) + `readNotesIndexEmbedModel` (async
  fs read) to the sibling commands-doctor-checks.ts (verbatim). The sibling gained `import { promises as fs }` +
  `import { DEFAULT_EMBED_MODEL }`. commands-doctor imports readNotesIndexEmbedModel back (runLocalDoctor at 411) +
  re-exports parseNotesIndexEmbedModel (test). DEFAULT_EMBED_MODEL/fs stay used in commands-doctor → no orphan.
- **Why:** diversity — compose@recall was 4/8; decompose@cli (3/8) shrinks the doctor god-file 810→785. Only
  embedModelCheck remains (formatBytes-entangled — deferred). LESSON re-confirmed: the lint gate caught that I'd
  imported parseNotesIndexEmbedModel for internal use when it's only RE-EXPORTED (readNotesIndexEmbedModel is the
  only internal user) — fixed to import-only-what's-used before commit.
- **Review point:** 4b judge — both bodies byte-identical (the JSON-parse fallback chain + the ENOENT-vs-unreadable
  fs branch); readNotesIndexEmbedModel exported for runLocalDoctor; re-export keeps the parse test green (2616 cli);
  parseNotesIndexEmbedModel NOT in the import line (re-export only — lint-clean); DEFAULT_EMBED_MODEL/fs retained.
- **Risk:** low — pure relocation of a parser + a guarded fs read; no floor path.

## fire 38 · 2026-06-13 · loop-creator v1.14.0 · b1d2913d
meta: value-class=refactor · pkg=@muse/recall · kind=compose · verdict=PASS · firesSinceDrill=5
ratchet: testFiles 959 · fabrication 0 · groundedSurfaces 27 · ask god-file: 8th inline block extracted
- **What:** Phase 3 continuation — extracted the inline `feedBlock` builder (`<<feed N>>` grounding block) into a
  pure `buildFeedContextBlock(headlines)` in @muse/recall/present.ts (structural input type matching
  recentFeedHeadlines' return). Escapes the untrusted feed title AND summary via escapeSystemPromptMarkers
  (preserved verbatim). Body byte-identical; 3-case OUTCOME test incl. an injection-defense assert (title+summary).
  NOTABLE: feedBlock was the LAST internal user of escapeSystemPromptMarkers in commands-ask — so this fire also
  REMOVED escapeSystemPromptMarkers from commands-ask's @muse/recall import (lint-verified now-unused). The
  injection escaper is now used EXCLUSIVELY inside @muse/recall (where it was relocated in fire 22 3a).
- **Why:** continues moving the ask pipeline's inline blocks to recall; 8 of ~12 now extracted (task/reminder/
  memory/shell/git/action/episode/feed). compose@recall 4/8 in the window (within ceiling). recentFeedHeadlines
  stays in commands-ask (source fetch).
- **Review point:** 4b judge — feedBlock body byte-identical (the <<feed N — name (date)>> header + optional-summary
  conditional + both escapeSystemPromptMarkers calls); escapeSystemPromptMarkers removed from commands-ask (lint-clean,
  0 refs there now); new test pins both escapes; recentFeedHeadlines retained; recall 207 + cli 2618 green.
- **Risk:** low — pure relocation; untrusted title/summary escape (grounding-floor defense) moved verbatim + tested.

## fire 39 · 2026-06-14 · loop-creator v1.14.0 · 485fb366
meta: value-class=refactor · pkg=@muse/cli · kind=decompose · verdict=PASS · firesSinceDrill=6
ratchet: testFiles 959 · fabrication 0 · groundedSurfaces 27 · commands-doctor.ts 785->739 LOC
- **What:** FINISHED the commands-doctor classifier decompose (fires 25/29/31/33/37) — moved the last one,
  `embedModelCheck`, plus its `formatBytes` helper (a doctor-LOCAL copy — 4 same-named formatBytes exist across
  CLI files, this one had no external importer) to the sibling commands-doctor-checks.ts. formatBytes is now
  `export`ed (runLocalDoctor's ollama-model line at 396 imports it back); embedModelCheck re-exported (test).
  ALSO fixed a fire-37 MISS: relocated the dangling `parseNotesIndexEmbedModel` JSDoc (fire 37 moved the function
  but left its load-bearing WHY behind, orphaned in commands-doctor) onto parseNotesIndexEmbedModel in the sibling.
- **Why:** diversity — compose@recall was 4/8; decompose@cli finishes the doctor god-file shrink (785→739, ~250
  LOC lighter across the 6-fire arc) and corrects my own orphaned-comment debt. All doctor classifiers now live
  in the sibling; commands-doctor.ts is the command registration + orchestration only.
- **Review point:** 4b judge — embedModelCheck + formatBytes bodies byte-identical (the pulled/NOT-pulled branch
  + the GB/MB/kB promotion); formatBytes exported for runLocalDoctor's 396 site; re-export keeps the embedModelCheck
  test green (2623 cli); the relocated JSDoc is the SAME orphaned text now attached to its real function (WHY
  preserved, not deleted); lint clean.
- **Risk:** low — pure relocation + a comment-debt fix; no floor path (embed-model probe is advisory).

## fire 40 · 2026-06-14 · loop-creator v1.14.0 · ec6a6a15
meta: value-class=refactor · pkg=@muse/calendar · kind=dead-code · verdict=PASS · firesSinceDrill=7
ratchet: testFiles 959 · fabrication 0 · groundedSurfaces 27 · 2 over-broad exports narrowed
- **What:** dead-code (over-export tightening) in @muse/calendar — knip flagged `CalDAVRetryOptions`
  (caldav-provider.ts) + `GoogleCalendarRetryOptions` (google-provider.ts) as unused exports; repo-wide grep
  confirmed each is referenced ONLY inside its own file (as a `readonly retry?: <Type>` field annotation) with
  ZERO external/test importers. Per code-style "internal use → drop export only": kept both interfaces, removed
  their `export` keyword. knip now clean on both.
- **Why:** diversity (the ④b judge has flagged the cli/recall concentration) — this fire deliberately picks a
  FRESH package never touched by this loop (@muse/calendar) + a different KIND (dead-code). Genuine pkg+kind
  variety, narrows the calendar providers' public surface (retry-options are an internal config detail).
- **Review point:** 4b judge — both interfaces still internally referenced (de-export, NOT deletion — bodies
  unchanged); zero external/test importers (grep-confirmed, so no breakage); knip drops both; calendar build +
  152 tests green; no behavior change (export visibility only); calendar is cold (no concurrent loop).
- **Risk:** none — type-export-visibility narrowing of two internal-only interfaces; no runtime/behavior/floor change.

## fire 41 · 2026-06-14 · loop-creator v1.14.0 · 7a573861 · JUDGE-DRILL
meta: value-class=refactor · pkg=@muse/recall · kind=compose · verdict=PASS · firesSinceDrill=0 (reset)
ratchet: testFiles 960 · fabrication 0 · groundedSurfaces 27 · ask god-file: 9th inline block extracted
- **What:** (drill, DUAL-DIRECTION validation) consecutive-allPASS hit 8 -> JUDGE-DRILL. Attempt 1: removed an inline
  WHY comment in readNotesIndexEmbedModel ("flag the probe instead of silently dropping") — the judge correctly
  PASSED it as legitimate, having traced that the WHY is already documented authoritatively in the adjacent
  parseNotesIndexEmbedModel JSDoc (relocated fire 39) + the caller comment, so my comment was genuinely REDUNDANT.
  That made the drill inconclusive (my "bad" slice wasn't clearly bad). Attempt 2: gutted the SOLE-carrier
  escapeSystemPromptMarkers "apply to CONTENT only, NEVER source/name fields — copy-exact for the citation gate"
  invariant — the judge correctly FAILED it (traced the raw-src call sites, confirmed sole carrier, flagged it as a
  fire-25 repeat). Both rolled back. NET: verifier validated in BOTH directions (no false-FAIL on a defensible
  removal + clean FAIL on a clearly-bad one) — stronger evidence than a bare catch. (real) extracted calendarBlock
  -> buildCalendarContextBlock in @muse/recall (structural input type; the fmtWhen + the load-bearing weekday-WHY
  comment moved verbatim).
- **Why:** drill validates maker≠judge (5th drill); calendar block continues the recall thread (9/12: task/reminder/
  memory/shell/git/action/episode/feed/calendar). compose@recall 4/8.
- **Review point:** drills judged correctly (PASS-redundant + FAIL-sole-carrier); real slice 4b judge — calendarBlock
  body byte-identical (the all-day vs timed `when`, the `[event: title]` citation, the fmtWhen locale opts + the
  weekday-WHY comment); structural type accepts CalendarEvent[]; TZ-robust test (asserts structure not the locale
  string); recall 217 + cli 2625 (one Ink approval-box test was a CPU-contention flake — passed isolated).
- **Risk:** low — pure relocation; CalendarEvent stays in commands-ask (source fetch).

## fire 42 · 2026-06-14 · loop-creator v1.14.0 · f1615b6c
meta: value-class=refactor · pkg=@muse/recall · kind=compose · verdict=PASS · firesSinceDrill=1
ratchet: testFiles 964 · fabrication 0 · groundedSurfaces 27 · ask god-file: 10th inline block extracted
- **What:** Phase 3 continuation — extracted the inline `contactBlock` builder (`<<contact N>>` grounding block,
  the most field-rich one) into a pure `buildContactContextBlock(contacts)` in @muse/recall/**select.ts** (beside
  formatContactBirthday, which it calls — same-module, no new import; like fire-30's buildMemoryContextBlock).
  Structural input type covers the 9 contact fields used (id/name/relationship/email/phone/handle/birthday/
  connections/about). Body byte-identical incl. the fields-join + the `as ?? "connected to"` connection fallback.
  5-case OUTCOME test added. formatContactBirthday import stays in commands-ask (still re-exported there).
- **Why:** finishes the substantial ask-block extraction — 10 of ~12 blocks now in recall (task/reminder/memory/
  shell/git/action/episode/feed/calendar/contact); only the note-block wrapper (already delegates to
  buildNoteContextBlock) + trivial cases remain. compose@recall 4/8.
- **Review point:** 4b judge — contactBlock body byte-identical (the 7-field optional list + filter+join, the
  `<<contact N — id>>` header, the `[contact: name]` citation [name not id], the `as ?? "connected to"` fallback);
  placed in select.ts beside formatContactBirthday (no new import); structural type accepts Contact[]; new test
  pins fields-order + the connection fallback; recall 227 + cli 2625 green.
- **Risk:** low — pure relocation; Contact/contactMatchScore/contactGroundingEvidence stay in commands-ask (source fetch).

## fire 43 · 2026-06-14 · loop-creator v1.14.0 · b60822e9
meta: value-class=refactor · pkg=@muse/macos · kind=decompose · verdict=PASS · firesSinceDrill=2
ratchet: testFiles 964 · fabrication 0 · groundedSurfaces 27 · macos-tools.ts 1519->1352 LOC
- **What:** resumed the macos-tools decompose (DECOMPOSE-ON-DEFER from fire 19's shared-exec base) — extracted the
  3 simple single-CLI utility tools (mac_clipboard_set/mac_spotlight_search/mac_say) + their Deps interfaces +
  their PATH/TIMEOUT consts (PBCOPY/MDFIND/SAY_PATH from the top block, each used only by its tail tool, + the local
  SPOTLIGHT/SAY consts) into a new sibling `macos-utility-tools.ts`. Each drives one Apple CLI through the shared
  `runChild` (fire 19's macos-exec) — no AppleScript escaping, so they share no state with the osascript tools.
  macos-tools re-exports the 3 tools + 3 Deps (the test + cli actuator-tools import them via @muse/macos, unchanged).
- **Why:** diversity — compose@recall was 4/8 (recall block extraction is ~10/12 done); decompose@macos is a fresh
  pkg (last touched fire 19) and a 167-LOC god-file shrink. The tail utility tools are the cold cohesive cluster
  (the active macos loop works mac_message_send, far from these); merge-collision risk low.
- **Review point:** 4b judge — the 3 tool factories + Deps byte-identical (verbatim region cut); the 3 PATH consts
  genuinely tail-only (head no longer references them); re-export keeps macos 105 + cli green; the new module
  imports runChild + MacCommandResult from macos-exec; no AppleScript/osascript tool touched.
- **Risk:** low-medium — touches the macos package the message-send loop also edits, but the extracted region is the
  cold tail far from mac_message_send; pure relocation, no behavior change.

## fire 44 · 2026-06-14 · loop-creator v1.14.0 · 5fd47137
meta: value-class=refactor · pkg=@muse/messaging · kind=dead-code · verdict=PASS · firesSinceDrill=3
ratchet: testFiles 966 · fabrication 0 · groundedSurfaces 27 · 1 dead re-export + 1 unused import removed
- **What:** dead-code in @muse/messaging — knip flagged `telegram-provider.ts:270 export { MessagingValidationError }`
  as an unused export. Verified: MessagingValidationError is the canonical error (defined in errors.ts, used widely),
  but NOTHING imports it FROM telegram-provider (all consumers — api routes, providers, tests — get it from
  errors.js or the package index, which re-exports it from errors.js). So telegram's re-export was a dead duplicate
  (its comment "re-export so callers don't depend on the validate module" is obsolete — index already exposes it).
  Removed the dead re-export + the now-unused MessagingValidationError import (kept MessagingProviderError, used 4x).
- **Why:** diversity — picked a FRESH package (@muse/messaging, never touched by this loop) + dead-code KIND, off
  the recall/cli concentration. Scouted the macos capture cluster first but it's entangled (shares path-validator
  helpers tryRealpath/expandTilde + node imports with other tools) — deferred as a blocker (needs the path-helpers
  untangled first).
- **Review point:** 4b judge — the package PUBLIC API is unchanged (index.ts still `export { MessagingValidationError }
  from "./errors.js"`; api route imports it from @muse/messaging unaffected); telegram-provider no longer references
  it (0 refs); MessagingProviderError import retained; knip drops it; messaging 368 + full check green.
- **Risk:** none — removed a redundant re-export whose symbol is still exposed via the package index; no behavior change.

## fire 45 · 2026-06-14 · loop-creator v1.14.0 · 62577971
meta: value-class=refactor · pkg=@muse/macos · kind=decompose · verdict=PASS · firesSinceDrill=4
ratchet: testFiles 968 · fabrication 0 · groundedSurfaces 27 · macos-tools 1352->1297 LOC · +4 sandbox tests
- What: Step 1 of the fire-44-deferred macos capture untangle. Extracted the screenshot output-path security sandbox (tryRealpath + screenshotAllowedRoots + expandTilde + resolveScreenshotPath) from macos-tools.ts into a new sibling macos-screen-path.ts. The 4 fns are capture-only (grep-confirmed: used solely by createMacScreenshotTool); macos-tools imports resolveScreenshotPath+tryRealpath back. Dropped 3 now-unused node imports (realpathSync, homedir, basename/dirname/resolvePath). Added macos-screen-path.test.ts (4 OUTCOME cases for a previously-untested-in-isolation traversal guard).
- Why: completes the top open defer-blocker (avoid defer-ratchet) + isolates a security-sensitive path-traversal sandbox into a directly unit-testable module. Unblocks Step 2 (move the screenshot/screenread tools). Diversity: macos 2/8, decompose 3/8 — clean.
- Review point: 4b judge — the 4 fns moved BYTE-IDENTICAL (incl. the load-bearing symlink-O_TRUNC WHY comment); the existing screenshot-tool tests (traversal/symlink-escape/allowlist) stay green; macos-tools no longer references the dropped node imports.
- Risk: low — pure relocation behind the same call; existing tool-level tests + 4 new direct tests both pass.

## fire 46 · 2026-06-14 · loop-creator v1.14.0 · 37c110b8
meta: value-class=refactor · pkg=@muse/macos · kind=decompose · verdict=PASS · firesSinceDrill=5
ratchet: testFiles 968 · fabrication 0 · groundedSurfaces 27 · macos-tools 1297->1143 LOC · capture cluster COMPLETE
- What: Step 2 (final) of the macos capture untangle. Moved createMacScreenshotTool + createMacScreenReadTool (+ MacScreenshotToolDeps/MacScreenReadToolDeps/MacScreenReadDescribeInput/MacScreenReadDescribeResult + SCREENSHOT_TIMEOUT_MS + SCREENCAPTURE_PATH) from macos-tools.ts into a new sibling macos-screen-tools.ts (imports resolveScreenshotPath/tryRealpath from macos-screen-path.js + runChild from macos-exec.js). macos-tools re-exports all 6 names so the package API + tests are unchanged. Dropped 4 now-capture-only imports from macos-tools (node:fs/promises readFile/rm, node:os tmpdir, node:path join, macos-screen-path).
- Why: completes the capture-cluster decompose (fires 43/45/46) — macos-tools 1519->1143 LOC across the thread. The screen tools now live beside their path sandbox; macos-tools holds only the osascript/app/message families. Diversity: macos 3/8, decompose 4/8 (both <6/8).
- Review point: 4b judge — the 2 tools + 4 type interfaces moved BYTE-IDENTICAL; re-export keeps macos-tools.test.ts (imports both tools from macos-tools.js) green (109 tests incl. the screenshot sandbox-through-tool cases); the 4 dropped imports are genuinely capture-only (lint caught node:path join — array .join() is unrelated).
- Risk: low — pure relocation behind a re-export; existing tool tests + the fire-45 sandbox tests both pass.

## fire 47 · 2026-06-14 · loop-creator v1.14.0 · 8f54ee82
meta: value-class=refactor · pkg=@muse/autoconfigure · kind=cohere · verdict=PASS · firesSinceDrill=6
ratchet: testFiles 970 · fabrication 0 · groundedSurfaces 27 · isRecord dups 4->3
- What: deduped the local isRecord type-guard in autoconfigure/setup-status.ts onto the canonical @muse/shared isRecord. The local copy was byte-identical to shared's; autoconfigure already deps @muse/shared (package.json + tsconfig ref, 4 sibling files import it), used internally only (459/493), not exported. Replaced the local function with `import { isRecord } from "@muse/shared"`.
- Why: genuine pivot off the 3x macos/decompose run — FRESH kind (cohere, 0/8 in window) + a package this loop hasn't touched. Continues the fire-21 isRecord dedup (was 5->3 after model/api; now 4->3 wait — 3 defs remain: shared canonical, voice no-shared-dep, agent-core hot/exported). Diversity: autoconfigure 1/8, cohere 1/8.
- Review point: 4b judge — behavior-preserving (impl byte-identical, so the 459/493 token-from-file checks are unchanged); setup-status's 595 tests stay green proving isRecord-from-shared works identically; isRecord not exported from autoconfigure (no external caller); no new dep added (already present).
- Risk: low — setup-status.ts is warm (differentiation loop touches its embedder logic) but my edit is the import block + the deleted fn at EOF, line-disjoint from that work; if a merge conflict surfaces, retry next fire.

## fire 48 · 2026-06-14 · loop-creator v1.14.0 · 41eb5bbb
meta: value-class=refactor · pkg=@muse/cli · kind=decompose · verdict=PASS · firesSinceDrill=7
ratchet: testFiles 970 · fabrication 0 · groundedSurfaces 27 · commands-today 1397->1327 LOC
- What: extracted the external-data cluster (resolveTodayWeatherLine/formatWeatherLine + resolveTodayFeedHeadlines/formatHeadlines + DEFAULT_TODAY_HEADLINES_CAP) from the 1397-LOC commands-today.ts into a new sibling commands-today-feeds.ts. These 5 read the weather/feeds stores client-side and fail-soft. commands-today imports the 4 it uses internally + re-exports all 5 (commands-today.test.ts + commands-brief.ts import them from commands-today.js). Moved the 7 cluster-only imports (3 weather @muse/mcp names + 4 feeds-store) to the sibling; stripUntrustedTerminalChars stays (5 other uses).
- Why: god-file decompose on a COLD file (commands-today last touched fire 3) — diversifies pkg off macos (cli, fresh in window) while staying a clean contiguous cut. Diversity: cli 1/8, decompose 4/8 (<6/8).
- Review point: 4b judge — the 5 fns + JSDocs moved BYTE-IDENTICAL; re-export keeps commands-today.test.ts (imports formatHeadlines/formatWeatherLine/resolveTodayFeedHeadlines/resolveTodayWeatherLine) + commands-brief.ts green (2626 cli tests); the 7 dropped imports are cluster-only (lint caught DEFAULT_TODAY_HEADLINES_CAP — re-export-only, removed from the internal import).
- Risk: low — pure relocation behind import+re-export; the weather/feeds fail-soft behavior is unchanged (byte-identical bodies).

## fire 49 · 2026-06-14 · loop-creator v1.14.0 · c99be00d
meta: value-class=refactor · pkg=@muse/cli · kind=dead-code · verdict=PASS · firesSinceDrill=0 (reset)
ratchet: testFiles 970 · fabrication 0 · groundedSurfaces 27 · 3 internal-only exports de-exported · JUDGE-DRILL (6th)
- JUDGE-DRILL (triggered: 7 consecutive allPASS): injected a BAD comment-hygiene slice — deleted the load-bearing security WHY ("Feed titles are third-party-controlled — strip ESC/C0/C1/DEL...") above the stripUntrustedTerminalChars call in commands-today-feeds.ts formatHeadlines, committed as "redundant comment" (gates PASS — comments don't affect build/test/lint). The independent Opus ④b judge correctly FAILED it, and went deeper: found the cross-surface parity (inbox-context/skills-context/commands-search all document the SAME terminal-injection mitigation), proving the comment was load-bearing not noise. Rolled back via git reset --hard. Verifier validated (teeth confirmed on the comment-WHY axis).
- What (real slice): de-exported 3 internal-only helpers in commands-export.ts (defaultNotesDir/defaultExportOutput/resolveExportPassphrase) — knip-flagged unused exports; grep-confirmed used only within commands-export.ts (own=2 each), no external/test importer. Dropped the `export` keyword (functions stay, used internally).
- Why: dead-code KIND (diversity off the 4x decompose run); single COLD file (commands-export last touched by a docs comment-strip) so low conflict risk. Diversity: cli 2/8, dead-code 2/8.
- Review point: 4b judge — the 3 are genuinely internal-only (no caller breaks: cli build clean, 2627 tests green); knip drops them post-de-export; functions unchanged (only `export` removed). chat-ink-render approval-box test false-timed-out under full-check CPU load (known fire-41 Ink flake) — passed standalone 2627/2627.
- Risk: none — narrowing visibility of 3 already-internal helpers; no behavior change.

## fire 50 · 2026-06-14 · loop-creator v1.14.0 · 1ddae31d
meta: value-class=refactor · pkg=@muse/autoconfigure · kind=dead-code · verdict=PASS · firesSinceDrill=1
ratchet: testFiles 972 · fabrication 0 · groundedSurfaces 27 · 2 dead re-exports removed
- What: removed 2 dead re-exports (resolveUserSkillsDir/resolveWorkspaceSkillsDir) from personal-providers.ts's `export {...} from "./provider-paths.js"` block. knip-flagged: nothing imports these two FROM personal-providers (the test + all consumers import them from provider-paths.js directly). They STAY imported into personal-providers (separate import block) for internal use at lines 239/241; only the redundant re-export of these 2 names was dropped.
- Why: dead-code KIND off the 4x decompose run; targeted the re-export block specifically (the import block has the same names — removed only the re-export occurrences). Diversity: autoconfigure 2/8, dead-code 3/8.
- Review point: 4b judge — only the 2 re-export names removed (the many OTHER re-exports in that block + the internal import + the resolveUserSkillsDir(env)/resolveWorkspaceSkillsDir(env) call sites untouched); provider-paths.test.ts imports from provider-paths.js (not personal-providers) so unaffected; autoconfigure 595 tests green; knip drops both.
- Risk: none — narrowing a re-export surface; the symbols stay available from their canonical home provider-paths.ts, still used internally.

## fire 51 · 2026-06-14 · loop-creator v1.14.0 · 6ca1a413
meta: value-class=refactor · pkg=@muse/recall · kind=compose · verdict=PASS · firesSinceDrill=2
ratchet: testFiles 974 · fabrication 0 · groundedSurfaces 27 · Phase 3 step (grounding-section presentation -> recall)
- What: PHASE 3 step. Extracted the 11-entry optional-grounding-section descriptor array (the section header/footer LABELS + fixed render order + present-gating) from the commands-ask.ts action handler into a new recall function `optionalGroundingSections(sources)` in present.ts (beside groundingSectionLines). commands-ask now passes just the dynamic {body, present} per source; the literal label strings + ordering live in @muse/recall. +OptionalGroundingSources/Source types +4-case OUTCOME test (label order, body/present pass-through, groundingSectionLines drops absent, all-absent → 0 lines).
- Why: compose KIND (0/8 in window — best diversity) + the stated #1 recall priority (Phase 3). Moves grounding-prompt PRESENTATION (labels/order) into recall where groundingSectionLines already lives; block-building + present-flags stay in commands-ask so NO source-type coupling crosses the seam (lower floor-risk than moving the builders).
- Review point: 4b judge — the 11 labels are BYTE-IDENTICAL (diff vs old commands-ask: only `=== END NOTES ===` differs, which is the separate always-present notes section, correctly NOT in the optional fn); the assembled array fed to groundingSectionLines is identical → grounding prompt unchanged; cli 2628 + the recall OUTCOME test green; groundedSurfaces stayed 27 (floor neutral); the load-bearing present-gating WHY comment kept at the call site.
- Risk: low-moderate (touches the grounding wedge's prompt assembly) but guarded by byte-identical labels + the recall test + cli grounding tests + groundedSurfaces=27.

## fire 52 · 2026-06-14 · loop-creator v1.14.0 · be365559
meta: value-class=refactor · pkg=@muse/recall · kind=compose · verdict=PASS · firesSinceDrill=3
ratchet: testFiles 975 · fabrication 0 · groundedSurfaces 27 · Phase 3 step (citation-banner summary -> recall)
- What: PHASE 3 step (parallel to fire 51). Extracted the "(grounded on …)" citation-banner builder — 10 per-source `if (x.length>0) push(\`N <label>\`)` if-pushes — from the commands-ask.ts action handler into a recall function `groundedSourceSummary(counts)` in present.ts. commands-ask passes the 10 counts + a pre-built notesPart (the note-chunk summary lists file names + a confidence suffix, so it stays caller-built); the count-labelled parts + their order live in @muse/recall. +GroundedSourceCounts type +4-case OUTCOME test.
- Why: compose KIND continuing Phase 3 (the #1 recall priority) — moves the citation-banner presentation labels into recall, parallel to fire 51's section labels. The top backlog ◦ (date-parser DRY) sits in files tool-hardening JUST churned (fires 89/90) — skipped to avoid a hot-file conflict. Diversity: recall 2/8, compose 2/8 (<6/8).
- Review point: 4b judge — the 10 count-labels are BYTE-IDENTICAL (diff vs old commands-ask: identical); the notes part is built at the call site exactly as before (same file-name listing + ambiguous-verdict confidence suffix), now passed as notesPart; order preserved (notes first, then the 10 in source order); cli 2631 + recall OUTCOME test green; groundedSurfaces 27 held (the banner goes to stderr — diagnostic, not the grounding prompt, but still verified neutral).
- Risk: low — pure presentation extraction; the banner is a stderr diagnostic, behavior byte-identical, guarded by the test + cli tests.

## fire 53 · 2026-06-14 · loop-creator v1.14.0 · eb7f43b7
meta: value-class=refactor · pkg=@muse/cli · kind=decompose · verdict=PASS · firesSinceDrill=4
ratchet: testFiles 976 · fabrication 0 · groundedSurfaces 27 · commands-daemon 1330->1277 LOC
- What: extracted the macOS LaunchAgent (launchd) cluster — LAUNCH_AGENT_LABEL + xmlEscape (internal) + buildLaunchAgentPlist + resolveLaunchAgentFile — from the 1330-LOC commands-daemon.ts into a new sibling commands-daemon-launchagent.ts (pure string/path helpers, no daemon runtime state). commands-daemon imports all 3 back (registerDaemonCommands uses them at 476/482/483/678) and re-exports buildLaunchAgentPlist + resolveLaunchAgentFile (commands-daemon.test.ts imports the plist builder, commands-doctor.ts imports the file resolver, both from commands-daemon.js).
- Why: god-file decompose on a COLD file (commands-daemon last touched fire 3 + cognition fire 16) — diversifies off 2x recall/compose. The launchd plist concern is now isolated + pure. Diversity: cli 3/8, decompose 3/8 (<6/8).
- Review point: 4b judge — buildLaunchAgentPlist + resolveLaunchAgentFile bodies BYTE-IDENTICAL (verified by diff); the load-bearing launchagent WHY comment (KeepAlive/ProcessType Background = OS-level brake-first complement) moved verbatim; xmlEscape stays internal to the sibling; the existing commands-daemon.test.ts plist tests + the doctor resolveLaunchAgentFile call stay green via re-export (cli 2631); the moved fns are already OUTCOME-tested through the re-export.
- Risk: low — pure relocation behind import+re-export; xmlEscape is the only newly-isolated helper (still exercised via buildLaunchAgentPlist's tests).

## fire 54 · 2026-06-14 · loop-creator v1.14.0 · 7df6f741
meta: value-class=refactor · pkg=apps/api · kind=dead-code · verdict=PASS · firesSinceDrill=5
ratchet: testFiles 976 · fabrication 0 · groundedSurfaces 27 · 8 dead re-exports removed
- What: removed 8 dead barrel re-exports from compat-routes.ts (currentAuthIdentity, chunkText, epochMillisOrNull, stringMapField, badRequest, notFound, prefixValidationDetails, validationErrorResponse) — knip-flagged unused exports. Each was a pure re-export entry in the `export {...} from "./compat-parsers|compat-responses|compat-user-memory-store.js"` barrel blocks; nothing imports them THROUGH compat-routes (the 3 consumer files that import from compat-routes don't reference any of the 8; the symbols still live in + are reachable from their canonical sibling modules).
- Why: dead-code KIND on a FRESH package (apps/api, last touched fire 24 — diversifies off the cli-heavy window: cli was 3/8). compat-routes is cold (last real change was this loop's fire 2 + an api dead-code pass). Diversity: api 1/8, dead-code 3/8.
- Review point: 4b judge — the 8 are pure dead re-exports (the count=2 names had their 2nd occurrence as a separate navigational comment, not internal use; compat-routes imports none of the 8); the canonical siblings + the still-live re-exports in the same blocks (errorResponse/clampLimit/invalid/isRecord/etc.) untouched; api 850 tests green; knip drops the 8 compat-routes re-exports.
- Risk: none — narrowing a barrel's re-export surface; the symbols remain in their canonical homes, no consumer routed through compat-routes for them.

## fire 55 · 2026-06-14 · loop-creator v1.14.0 · 7da0597a
meta: value-class=refactor · pkg=@muse/mcp · kind=cohere · verdict=PASS · firesSinceDrill=6
ratchet: testFiles 978 · fabrication 0 · groundedSurfaces 27 · DRY: 3 inline date-head guards -> 1 shared helper
- What: deduped the YYYY-MM-DD Date.UTC round-trip rollover guard — it was inline in 3 security-sensitive date parsers (personal-tasks-store parseTaskDueAt, loopback-calendar parseIsoDate, loopback-time-server readDate). Extracted the shared kernel `isoDateHeadRoundTrips(year, month1to12, day)` into loopback-relative-time.ts (the date-util hub); each caller now calls it inline, keeping its OWN fall-through (Error / undefined / relative-phrase) + its own dateHead regex + WHY comment. +OUTCOME test (real dates round-trip true; Feb-30/non-leap-Feb-29/Apr-31/month-13 false).
- Why: top backlog ◦ (DRY the rollover guard so a future fix to the impossible-date check applies to all 3 user-facing parsers, not 3 copies) + cohere KIND (0/8 in window — best diversity) + fresh pkg (mcp). The 3 rollover guards (tool-hardening fires 89/90 + the original task one) are complete, so the parsers had momentarily cooled.
- Review point: 4b judge — the shared helper is byte-equivalent to all 3 inline probes (same Date.UTC round-trip + getUTC* compare); each caller's accept/reject polarity preserved (calendar/tasks accept-if-roundtrips, time-server reject-if-not); the 3 parsers' rollover tests (2026-02-30 etc.) stay green (mcp 1874); each caller keeps its fall-through contract + load-bearing rollover WHY comment.
- Risk: moderate (3 HOT mcp files + security parsers) but guarded — mcp 1874 incl. all 3 rollover tests + the new helper test; behavior byte-equivalent. If a merge conflict surfaces on a hot file, retry next fire.

## fire 56 · 2026-06-14 · loop-creator v1.14.0 · eaf6c6f8
meta: value-class=refactor · pkg=@muse/memory · kind=decompose · verdict=PASS · firesSinceDrill=7
ratchet: testFiles 978 · fabrication 0 · groundedSurfaces 27 · memory-auto-extract 770->697 LOC
- What: extracted the JSON-extraction cluster (extractJsonObject + internal tryParseObject + findBalancedBraceBlocks) from the 770-LOC memory-auto-extract.ts into a new sibling memory-extract-json.ts (the "parse the model's JSON payload from a noisy completion" parser — takes the LAST balanced block that parses, since small models echo the schema first). memory-auto-extract imports extractJsonObject back (used in runExtraction at 441) + re-exports it (memory/index.ts:487 re-export chain unchanged). The cluster's only dep is the ExtractionPayload type (import type from memory-auto-extract — type-only, no runtime cycle).
- Why: god-file decompose on a FRESH package (memory, never touched by this loop) — diversifies off cli-heavy window (cli was 3/8) + decompose was only 1/8. extractJsonObject is widely consumed (cli commands-remember/chat-auto-memory/chat-reflection + 3 memory tests via the @muse/memory barrel) so the re-export chain is load-bearing. Diversity: memory 1/8, decompose 2/8.
- Review point: 4b judge — the 3 fn bodies moved BYTE-IDENTICAL (verified by diff); extractJsonObject re-exported so the barrel + cli + 3 test files unchanged; memory 417 tests green (incl. auto-extract-json-robustness/parse/sanitize which exercise extractJsonObject); tryParseObject/findBalancedBraceBlocks stay internal. NOTE: full `pnpm check` hit exit 134 (SIGABRT) on @muse/db (unrelated pkg) under concurrent-loop CPU load — db passed 5/6 in isolation; not a regression.
- Risk: low — pure relocation behind import+re-export; the noisy-JSON parser (a small-model robustness primitive) byte-identical + heavily tested.

## fire 57 · 2026-06-14 · loop-creator v1.14.0 · b77af2e2
meta: value-class=refactor · pkg=@muse/tools · kind=decompose · verdict=PASS · firesSinceDrill=0 (reset)
ratchet: testFiles 978 · fabrication 0 · groundedSurfaces 27 · tools/index 909->854 LOC · JUDGE-DRILL (7th)
- JUDGE-DRILL (triggered: 7 consecutive allPASS): injected a BAD slice — changed pickAutoExtractSystemPrompt's Hangul threshold 0.3->0.5 in memory-auto-extract.ts, committed as a "behavior-preserving cleanup". The independent Opus 4b judge correctly FAILED it: found the exact 0.3->0.5 change, computed a concrete flipping input (0.429 Hangul ratio → KO prompt flips to EN), caught the dishonest commit message + the now-inconsistent docstring, AND ran the test to confirm it breaks memory.test.ts:1418 (the threshold is pinned). Rolled back via git reset --hard. Verifier validated on the BEHAVIOR-PRESERVATION axis (distinct from fire 49's comment-WHY axis).
- What (real slice): extracted the tool-argument-validation cluster (coerceToolArguments + internal coerceScalar + validateRequiredToolArguments + ToolArgumentValidation) from the 909-LOC tools/index.ts into a new sibling tools-argument-validation.ts (the deterministic "repair" half of tool-calling — scalar coercion + required-arg check). tools/index re-exports the 3 public names (agent-core agent-runtime/plan-execute + the tools tests consume them via @muse/tools); coerceScalar stays internal.
- Why: god-file decompose on a FRESH package (@muse/tools, only touched by fire 16) — decompose 2/8, diversifies. tools/index doesn't use these internally so it's a pure re-export (no import-back). Diversity: tools 1/8, decompose 3/8.
- Review point: 4b judge — the 3 fns moved BYTE-IDENTICAL (verified by diff); the load-bearing WHY JSDocs (the Structured-Reflection arXiv:2509.18847 safe-coercion-only rationale + the required-arg deterministic-check rationale) moved verbatim; agent-core builds (re-export resolves the cross-package consumers); tools 196 tests green; coerceScalar stays internal.
- Risk: low — pure relocation behind a re-export; the tool-arg repair layer is byte-identical + the agent-core consumers + tools tests are unchanged.

## fire 58 · 2026-06-14 · loop-creator v1.14.0 · 1b836a95
meta: value-class=refactor · pkg=@muse/cli · kind=dead-code · verdict=PASS · firesSinceDrill=1
ratchet: testFiles 978 · fabrication 0 · groundedSurfaces 27 · 5 internal-only exports de-exported
- What: de-exported 5 internal-only helpers across 5 cli files — defangMemoryValue (muse-persona.ts), looksLikeImage (commands-show.ts), shortMessageId (commands-inbox.ts), logPendingApproval (commands-approval.ts), readActivity (commands-routine.ts). All knip-flagged unused exports; grep-confirmed used only within their own file (own>=2 each), no external/test importer. Dropped the `export` keyword; functions stay (used internally).
- Why: dead-code KIND (1/8 in window — diversifies off the 3x decompose run) batched same-kind across files per the loop's batching rule. Skipped friendlyFetchError (a test imports it) + isNodeError (used by 2 external files) — knip false-positives. Diversity: cli 1/8 prior, dead-code 1/8.
- Review point: 4b judge — each of the 5 is genuinely internal-only (no caller breaks: cli build clean, 2636 tests green); knip drops all 5 post-de-export; functions unchanged (only `export` removed); skipped the 2 knip false-positives. 5 separate files = small per-file conflict surface.
- Risk: none — narrowing visibility of 5 already-internal helpers; no behavior change.

## fire 59 · 2026-06-14 · loop-creator v1.14.0 · a6eeaeed
meta: value-class=refactor · pkg=@muse/shared · kind=cohere · verdict=PASS · firesSinceDrill=2
ratchet: testFiles 981 · fabrication 0 · groundedSurfaces 27 · escapeRegex dups 4->2 (+new shared canonical+test)
- What: DRY'd the `escapeRegex` regex-metachar escaper — it was hand-rolled in 4 packages (agent-core, cache, model, policy). Added a canonical `escapeRegex` to @muse/shared (+OUTCOME test: escapes every metachar so the string matches literally, leaves plain strings unchanged) and deduped the 3 non-hot copies (cache/model/policy) onto it. agent-core's copy LEFT intentionally (hot — cognition loop). policy used /g, the canonical uses /gu — behavior-IDENTICAL for this all-ASCII char class (the u flag only affects unicode-aware matching of surrogate pairs / \u escapes, none present).
- Why: cohere KIND (1/8 in window — best diversity off the 3x decompose run) + a genuine cross-package dedup of a security-adjacent escaper (used in injection/prompt-leakage detection). All 3 packages already dep @muse/shared. Diversity: shared 1/8, cohere 1/8.
- Review point: 4b judge — the canonical body is byte-identical to the 3 gu copies; policy's g->gu is behavior-neutral for [.*+?^${}()|[\]\\] (verify: u flag changes nothing for an ASCII char class + literal $&); each dedup'd file imports escapeRegex from @muse/shared (dep+tsconfig ref present), local removed, the single call site unchanged; shared 37 (+3 new) / cache 15 / model 287 / policy 130 green.
- Risk: low — pure utility dedup; the escaper output is identical, the 3 call sites unchanged. agent-core copy remains (4->2) for a future quiet-window dedup.

## fire 60 · 2026-06-14 · loop-creator v1.14.0 · e31d602d
meta: value-class=refactor · pkg=@muse/shared · kind=cohere · verdict=PASS · firesSinceDrill=3
ratchet: testFiles 982 · fabrication 0 · groundedSurfaces 27 · clamp dups 4->2 (+shared canonical+test)
- What: DRY'd the `clamp(value, min, max)` helper — hand-rolled in 4 packages. Added a canonical to @muse/shared (Math.max(min, Math.min(max, value)); +OUTCOME test) and deduped the 3 IDENTICAL-impl copies (cache, multi-agent, cli/chat-ink-core) onto it. mcp's copy is LEFT — it uses Math.min(Math.max(value, min), max), which differs from the canonical ONLY for an invalid min>max range (canonical returns min, mcp returns max); leaving it avoids a subtle behavior change on that edge.
- Why: cohere KIND (continues fire 59's escapeRegex utility-consolidation campaign into @muse/shared) + a clean mechanical dedup. compose(Phase 3) had no clean step (block-building is scattered/interleaved); the prompts decompose had a compactLines/cleanBlock cycle entanglement; clamp was the cleanest available. Diversity: shared 2/8, cohere 3/8 (<6/8).
- Review point: 4b judge — the 3 deduped impls are BYTE-IDENTICAL to the canonical (cli only differed in param name n vs value — irrelevant at the call site); mcp correctly EXCLUDED (its order differs for min>max — verify the canonical only consolidates the provably-identical 3); each file extends its existing @muse/shared value import; shared 40 (+3 new) / cache 15 / multi-agent 77 / cli 2636 green.
- Risk: low — pure utility dedup of 3 identical copies; mcp's behaviorally-distinct copy untouched. dups 4->2.

## fire 61 · 2026-06-14 · loop-creator v1.14.0 · 3ffa38f1
meta: value-class=refactor · pkg=apps/api · kind=dead-code · verdict=PASS · firesSinceDrill=4
ratchet: testFiles 984 · fabrication 0 · groundedSurfaces 27 · 2 dead re-exports + 1 de-export
- What: removed 2 dead barrel re-exports (toCompatChatResponse/toExtendedChatResponse) from server-helpers.ts's `export {...} from "./server-chat-response-builders.js"` block — knip-flagged; verified the 2 external consumers import them from server-chat-response-builders directly (ext-via-server-helpers=0), so the server-helpers re-export was dead. + de-exported the internal-only ChannelPollingProvider interface in channel-poll-tick.ts (own=2: def + 1 use, no external/test importer). Kept toAdminRunSummary (live re-export).
- Why: dead-code KIND (diversifies off 2x cohere) on apps/api (fresh-ish). Skipped the server-helpers local-export block (isJsonObject/optional* — ambiguous: used externally, can't cheaply trace which consumers go via server-helpers vs the original home) + registerLineWebhookRoute (fully-dead route handler, but removal cascades to its plugin/options — defer as a possibly-intended-but-unwired feature). Diversity: api 1/8, dead-code 3/8.
- Review point: 4b judge — toCompatChatResponse/toExtendedChatResponse still live in server-chat-response-builders + consumed directly there (api 850 green); ChannelPollingProvider still used internally at channel-poll-tick.ts:23 (de-export, not delete); knip drops all 3. @muse/cache check exit-134 was a CPU-contention SIGABRT (passed 15/15 isolated) — not a regression.
- Risk: none — narrowing a barrel's re-export surface + an interface's visibility; symbols stay reachable from their homes / used internally.

## fire 62 · 2026-06-14 · loop-creator v1.14.0 · 3abe2a00
meta: value-class=refactor · pkg=@muse/model · kind=decompose · verdict=PASS · firesSinceDrill=5
ratchet: testFiles 985 · fabrication 0 · groundedSurfaces 27 · provider-openai 608->544 LOC
- What: extracted the OpenAI response-field parsers (readOpenAIContent + parseOpenAIToolCalls + parseToolArguments + parseOpenAIUsage) from the 608-LOC provider-openai.ts into a new sibling provider-openai-parse.ts (pure parsers shared by the chat/responses parser AND the SSE-stream materializer). provider-openai imports the 4 back (all called outside the cluster); trimmed the now-unused @muse/shared JsonObject + isJsonObject/readFiniteNumber from provider-shared imports. +10-case OUTCOME test.
- Why: fresh-package decompose (@muse/model, never decomposed) — diversifies off the cohere/dead-code lean (decompose 2/8). Chose THIS cluster (not the SSE cluster) because the parsers' deps (isRecord/isJsonObject/readFiniteNumber, ModelToolCall/Usage, JsonObject) are all IMPORTED (from provider-shared/index/@muse/shared) so the sibling has no back-edge on provider-openai → no import cycle (the SSE cluster would have cycled via the shared parseToolArguments). Diversity: model 1/8, decompose 2/8.
- Review point: 4b judge — the 4 parsers moved BYTE-IDENTICAL (verified by diff); model 287 tests green (they exercise the parsers via the chat/responses/stream paths through the import-back); the trimmed imports (isJsonObject/readFiniteNumber/JsonObject) were 0-use-after-move (lint clean confirms); +the new direct parser test.
- Risk: low — pure relocation behind import; the parsers feed the model-response decode path but are byte-identical + heavily tested.

## fire 63 · 2026-06-14 · loop-creator v1.14.0 · eec457a4
meta: value-class=refactor · pkg=@muse/shared · kind=cohere · verdict=PASS · firesSinceDrill=6
ratchet: testFiles 986 · fabrication 0 · groundedSurfaces 27 · finiteOr dups 7->4 (+shared canonical+test)
- What: DRY'd the `finiteOr(value, fallback)` numeric-fallback helper — hand-rolled byte-identically in 7 packages. Added the canonical to @muse/shared (+OUTCOME test: returns value when finite, fallback for undefined/NaN/±Infinity) and deduped the 4 non-hot copies (resilience, autoconfigure/knowledge-corpus, api/chat-rate-limiter, mcp/calendar-availability). agent-core's 3 copies (episodic-recall/playbook/knowledge-recall) LEFT — hot (cognition loop). dups 7->4.
- Why: cohere KIND (continues the @muse/shared utility-consolidation: escapeRegex fire 59, clamp fire 60) — a clean mechanical dedup of 7 IDENTICAL impls. compose(Phase 3) still has no clean step; comment-hygiene dry (1 hot marker). Diversity: shared 3/8, cohere 3/8 (<6/8).
- Review point: 4b judge — all 7 impls were BYTE-IDENTICAL; the 4 deduped files import finiteOr from @muse/shared (the 2 import-less pure modules — api rate-limiter, mcp availability — get a fresh import; both dep @muse/shared); each call site unchanged; agent-core×3 correctly excluded (hot); shared 42 (+2) / resilience 26 / autoconfigure 604 / api 850 / mcp 1862 green.
- Risk: low — pure numeric-utility dedup of 4 identical copies; agent-core's behaviorally-identical copies untouched (deferred to a quiet-window dedup). dups 7->4.

## fire 64 · 2026-06-14 · loop-creator v1.14.0 · 3c9235c8
meta: value-class=refactor · pkg=@muse/autoconfigure · kind=dead-code · verdict=PASS · firesSinceDrill=7
ratchet: testFiles 986 · fabrication 0 · groundedSurfaces 27 · 2 internal-only interfaces de-exported
- What: de-exported 2 internal-only structural-input interfaces (ContactLike, UserMemoryFactLike) in autoconfigure/knowledge-corpus.ts — knip-flagged unused exports; grep-confirmed zero external/test references (own=3 each: def + 2 internal uses). Dropped the `export` keyword; the interfaces stay (used internally as the corpus's structural input shapes).
- Why: dead-code KIND (avoids shared 4/8 + cohere 4/8 — the @muse/shared utility-dedup campaign had run 3x) on a non-hot interface region. The dead-code vein is THINNING (most knip findings now sit in hot packages — agent-core/mcp-hot/web-surfaces — or are already cleaned); these 2 were the cleanest available. Diversity: autoconfigure 1/8, dead-code 2/8.
- Review point: 4b judge — both interfaces are genuinely internal-only (0 external refs, not imported anywhere); de-export (not delete) since each is still used 2x internally; autoconfigure 605 tests green; knip drops both; the finiteOr fire-63 edit at the file top is a different region (no self-overlap).
- Risk: none — narrowing the visibility of 2 already-internal structural types; no behavior change.

## fire 65 · 2026-06-14 · loop-creator v1.14.0 · f37a801b
meta: value-class=refactor · pkg=@muse/prompts · kind=decompose · verdict=PASS · firesSinceDrill=0 (reset)
ratchet: testFiles 988 · fabrication 0 · groundedSurfaces 27 · prompts/index 601->590 LOC · JUDGE-DRILL (8th)
- JUDGE-DRILL (triggered: 7 consecutive allPASS): injected a BAD slice — removed the 3rd REPLACEMENTS entry from escapeSystemPromptMarkers (the `[from …]`/`[task:`/`[feed:` citation-token escape) in recall/prompt-escape.ts, committed as "drop redundant citation-token escape — the wrapper escapes already cover it". The independent Opus 4b judge correctly FAILED it on the SECURITY-INVARIANT axis (distinct from fire 49's comment-WHY + fire 57's behavior-change): it constructed the concrete attack `[from trusted-source.md]` and verified it survives the remaining 2 `<<`-anchored escapes BYTE-IDENTICAL (disjoint syntax), caught the dishonest "redundant" claim, ran the tests (10 failures), and connected it to the GROUNDED≠TRUE provenance-forgery attack weakening fabrication=0. Rolled back via git reset --hard. Verifier validated on the floor/injection-defense axis.
- What (real slice): extracted the 3 pure prompt-text helpers (cleanBlock + compactSections + compactLines) from the 601-LOC prompts/index.ts into a new sibling prompt-text.ts (trim-or-undefined a block; drop undefined entries from sections/lines). index imports them back; the sibling has NO deps on index (pure string→string) so no import cycle. +4-case OUTCOME test.
- Why: decompose KIND (1/8 in window — freshest after compose; avoided shared/cohere/dead-code all at 3/8) on a FRESH package (@muse/prompts, never decomposed). The 3 helpers were internal (not exported), used 5/18/7x in index. Diversity: prompts 1/8, decompose 1/8.
- Review point: 4b judge — the 3 fns moved BYTE-IDENTICAL (verified by diff); index imports them back (used throughout, hoisting-safe); no cycle (prompt-text imports nothing from index); prompts 34 + the 4 new tests green.
- Risk: low — pure relocation behind import; tiny pure helpers, byte-identical + tested.

## fire 66 · 2026-06-14 · loop-creator v1.14.0 · 8c0ac71b
meta: value-class=refactor · pkg=@muse/observability · kind=decompose · verdict=PASS · firesSinceDrill=1
ratchet: testFiles 988 · fabrication 0 · groundedSurfaces 27 · observability-detectors 480->372 LOC
- What: split the MonthlyBudgetTracker detector (class + its 3 types MonthlyBudgetStatus/Snapshot/Options + its private formatYearMonth helper) out of the 3-detector god-file observability-detectors.ts into a new sibling budget-tracker.ts (one detector per module). observability-detectors re-exports the 4 public names so the barrel + observability-token-cost.ts + observability-muse-snapshot.ts (all import from observability-detectors.js) are unchanged. PromptDriftDetector + SloAlertEvaluator + the shared stats helpers (mean/stdDev/percentile) stay.
- Why: fresh-package decompose (@muse/observability, never decomposed) — decompose 2/8, avoids shared(3/8)/cohere(3/8). MonthlyBudgetTracker uses ONLY formatYearMonth (not the shared stats) so it + its helper extract self-contained with no import + no cycle. The clean-decompose vein is thinning; picked a genuinely separable detector class. Diversity: observability 1/8, decompose 2/8.
- Review point: 4b judge — the class + formatYearMonth moved BYTE-IDENTICAL (verified by diff); the 3 importers resolve MonthlyBudgetTracker via the re-export (observability 125 tests green — they exercise the class through the barrel->detectors re-export->budget-tracker chain); the other 2 detectors + shared stats untouched; pure re-export (detectors doesn't use the class internally).
- Risk: low — pure relocation of a self-contained detector class behind a re-export; byte-identical + already-tested via the chain.

## fire 67 · 2026-06-14 · loop-creator v1.14.0 · e874bb25
meta: value-class=refactor · pkg=@muse/shared · kind=cohere · verdict=PASS · firesSinceDrill=2
ratchet: testFiles 990 · fabrication 0 · groundedSurfaces 27 · toDate dups 7->1
- What: DRY'd `toDate(value: Date|string): Date` (DB-row date coercion, `value instanceof Date ? value : new Date(value)`) — 7 byte-identical hand-rolled copies — into a canonical @muse/shared `toDate` (after finiteOr) + deduped the 6 cold copies (agent-specs/kysely-store, auth/user-stores, runtime-settings/kysely-store, runtime-state/kysely-stores + run-history, scheduler/scheduler-helpers); each drops its local def and imports the canonical (callsites unchanged). mcp/server-stores left as-is (HOT tool-loop pkg). +2-case OUTCOME test (same-ref Date passthrough; ISO-string parse).
- Why: cohere KIND (the shared+cohere PAIR is 3/8 at fires 59/60/63, well under the 6/8 ratchet cap) on the @muse/shared utility-dedup campaign (escapeRegex 59 / clamp 60 / finiteOr 63 → toDate 67) — varies off decompose (3/8, 2-in-a-row at 65/66). All 7 byte-identical (no behavioral divergence to exclude, unlike mcp clamp); all 5 cold pkgs already dep @muse/shared (package.json + tsconfig ../shared ref). Diversity: shared 3/8, cohere 3/8.
- Review point: 4b judge — toDate moved BYTE-IDENTICAL (all 7 grep-confirmed identical); 6 local defs removed, 6 imports added (4 extend an existing createRunId value-import; runtime-settings + scheduler add a new value-import next to existing @muse/shared usage); callsite counts intact (2/1/1/4/8/6, localdef 0 each); 5 consumer builds + tests green (agent-specs 20, auth 61, runtime-settings 11, runtime-state 41, scheduler 91); shared 44 (incl. new toDate test); mcp hot copy intentionally deferred.
- Risk: low — pure relocation of a 1-line identity/parse helper behind an import; byte-identical + tested; no cycle (helper is leaf in @muse/shared).

## fire 68 · 2026-06-14 · loop-creator v1.14.0 · e2b54416
meta: value-class=refactor · pkg=@muse/cli · kind=decompose · verdict=PASS · firesSinceDrill=3
ratchet: testFiles 992 · fabrication 0 · groundedSurfaces 27 · commands-notes-rag 1102->1040 LOC
- What: extracted the notes-index embedding chunker (`chunkText` + its private `hardWrap` helper) out of the 1102-LOC commands-notes-rag.ts god-file into a new leaf module notes-chunk.ts. The cluster's only dep is @muse/agent-core's `applyOverlap` (the shared overlap-window helper) — no cli-local deps, so it moves byte-identical (load-bearing JSDoc on the embedding-overflow rationale kept). commands-notes-rag imports chunkText back (used in reindexNotes) + re-exports it (`export { chunkText } from "./notes-chunk.js"`) so the test + any consumer path is unchanged; the now-unused `applyOverlap` import was trimmed (annotateNoteChunks stays). +6-case OUTCOME test (short passthrough, multi-para packing, overflow split, hard-wrap-no-chunk-exceeds-limit, whitespace-break-preference, whitespace-only→[]).
- Why: FRESH package (apps/cli, absent from the last-8 window — pkg diversity) decompose of the single largest cli god-file; the (cli,decompose) pair is 0/8 so the ratchet is satisfied even though decompose kind sits at 3/8. chunkText+hardWrap is the cleanest separable cluster (pure, single shared dep, hardWrap private to it); the revisit cluster was rejected because walkMarkdown is shared across 6 sites (not cleanly separable). Diversity: cli 1/8, decompose 4/8.
- Review point: 4b judge — the 2 fns moved BYTE-IDENTICAL (verify by diff); applyOverlap trimmed from the agent-core import is genuinely now-unused in commands-notes-rag (was only inside chunkText); re-export keeps the test's `from "./commands-notes-rag.js"` import working (full cli suite 228 files / 2647 tests green); no cycle (notes-chunk imports only @muse/agent-core, a leaf-ward dep); the 11 other repo files named `chunkText` are their own copies (agent-core/recall/api/autoconfigure), untouched.
- Risk: low — pure relocation of a pure chunker behind an import+re-export; byte-identical + 6-case tested; the embedding-chunk behavior is exercised end-to-end by the unchanged commands-notes-rag reindex tests.

## fire 69 · 2026-06-14 · loop-creator v1.14.0 · 106b520c
meta: value-class=refactor · pkg=@muse/api · kind=dead-code · verdict=PASS · firesSinceDrill=4
ratchet: testFiles 993 · fabrication 0 · groundedSurfaces 27 · knip server-helpers 10 findings -> 0
- What: removed 10 knip-flagged dead exports from the transitional barrel apps/api/src/server-helpers.ts. (a) The server-input-utils re-export block re-exported 9 symbols but consumers import them from the canonical ./server-input-utils.js directly — 7 (isJsonObject/isJsonValue/optionalBoolean/optionalNullableString/optionalString/optionalStringArray/parseRuntimeSettingType) had 0 barrel-importers, so dropped from the export list; isRecord + parseResponseLocales kept (still consumed via the barrel). isJsonValue had 0 internal body-uses so also dropped from the IMPORT (the other 6 stay imported — used by parseAgentSpecInput/parseRuntimeSettingInput internally). (b) currentCompatApiVersion dropped from the http-plumbing re-export block (0 barrel-importers, canonical in server-http-plumbing.js). (c) sendAgentError dropped from the agent-error re-export (kept the import — used internally once — and kept unwrapErrorMessage which knip did NOT flag). (d) the local invalid() helper de-exported (export keyword dropped) — used 5x internally, 0 importers.
- Why: dead-code KIND (2/8 in window — varies off decompose 4/8 which sat 2-in-a-row at 65/66 + cli 68) on a FRESH package (@muse/api, last in window was api/dead-code fire 61). server-helpers.ts is a transitional barrel that accreted dead re-exports as consumers migrated to canonical homes; all 10 confirmed via knip + a barrel-importer grep (0 each) + body-use count. Diversity: api 1/8 (≠ prior api at fire 61 leaving window), dead-code 2/8.
- Review point: 4b judge — every removed export has 0 importers THROUGH server-helpers (grep 'from "./server-helpers"' across apps/api = 0 hits for each); symbols kept in the import block (isJsonObject/optionalBoolean/optionalNullableString/optionalString/optionalStringArray/parseRuntimeSettingType) are used in the parser bodies (build proves it); unwrapErrorMessage deliberately untouched (not knip-flagged); de-exported invalid() still resolves internally (api build + 850 tests green); knip now reports 0 of these 10.
- Risk: low — pure visibility narrowing of already-unconsumed exports; no body logic changed; canonical homes + internal call sites unchanged; api 145 files/850 tests green, full check rc=0.

## fire 70 · 2026-06-14 · loop-creator v1.14.0 · 82580783
meta: value-class=refactor · pkg=@muse/recall · kind=cohere · verdict=PASS · firesSinceDrill=5
ratchet: testFiles 994 · fabrication 0 · groundedSurfaces 27 · commands-ask 2800->2742 LOC
- What: moved the 3 pure grounding-NOTICE presentation builders — untrustedOnlyGroundingNotice (grounded≠true source-trust cue), citationPrecisionNotice + citationRecallNotice (ALCE per-citation precision/recall cues, arXiv:2305.14627) — out of the 2800-LOC commands-ask.ts god-file into a new @muse/recall module grounding-notices.ts. They join the grounding presentation already consolidated in @muse/recall (optionalGroundingSections/groundedSourceSummary, fires 51-52). Their deps (groundedOnUntrustedOnly/untrustedOnlySentences/reportCitationPrecision/reportCitationRecall/KnowledgeMatch) are public @muse/agent-core exports and recall already deps agent-core. commands-ask imports the 3 back (1 internal use each in registerAskCommand) + re-exports them so the verdict test (imports from ./commands-ask.js) is unchanged; the 5 now-unused agent-core imports were trimmed (lint-caught). +6-case OUTCOME test in recall (positive+negative per notice, proven fixtures).
- Why: cohere KIND (2/8 in window) consolidating scattered grounding-presentation responsibility into its proper home @muse/recall — a FRESH package (recall absent from the last-8 window), varies off decompose (4/8 leader). The grounding-notice builders belong alongside the rest of the grounding presentation already in @muse/recall. Diversity: recall 1/8, cohere 2/8 (≠ shared/cohere — different pkg).
- Review point: 4b judge — the 3 fns moved BYTE-IDENTICAL incl. load-bearing arXiv JSDoc (verify by diff); re-export keeps the verdict test's `from "./commands-ask.js"` import working (full cli suite 228 files/2648 tests green; recall 39 files/255 incl. the new 6); the 5 trimmed agent-core imports were used ONLY by the moved fns (lint went 5-errors→0 after trim, then check rc=0); groundedSurfaces held at 27 (notices still wired via re-export, no grounded-surface lost).
- Risk: low — pure relocation of pure presentation behind import+re-export; byte-identical + 6-case tested; deps are public agent-core exports; no behavior or grounding-floor change (groundedSurfaces 27 unchanged).

## fire 71 · 2026-06-14 · loop-creator v1.14.0 · 91c0244d
meta: value-class=refactor · pkg=@muse/cli · kind=decompose · verdict=PASS · firesSinceDrill=6
ratchet: testFiles 995 · fabrication 0 · groundedSurfaces 27 · commands-ask 2742->2713 LOC
- What: extracted the pure ask tier-model routing cluster — the AskTierModels interface + resolveAskTierModels (env MUSE_FAST/HEAVY_MODEL → tier models, default fallback) + routeAskTierModel (classify query tier → that tier's model) — out of the 2742-LOC commands-ask.ts god-file into a new leaf ask-tier-models.ts. The cluster's only dep is @muse/multi-agent's classifyTier + ModelTier type; after the move those were unused in commands-ask so the whole `import { classifyTier, type ModelTier } from "@muse/multi-agent"` line was removed. commands-ask imports routeAskTierModel back (1 internal use in registerAskCommand) + re-exports all three so commands-ask.test.ts is unchanged. +4-case OUTCOME test (default fallback for both tiers, blank-env→default, trim+explicit, route returns the classified tier's model). The load-bearing WHY comment (env-fallback rationale) moved with the functions.
- Why: decompose KIND (3/8 in window) of the SINGLE LARGEST god-file (commands-ask 2742 LOC) — the (cli,decompose) pair is 1/8 (only fire 68) so the ratchet is satisfied even though decompose kind sits at 4/8 after this. Phase 3 (the runGroundedRecall pipeline) was scouted again and is still genuinely multi-fire (the pipeline stages are embedded in registerAskCommand's closure with interleaved I/O + early returns — not a clean single-fire pure-stage extraction); picked the cleanest available pure top-level cluster instead. Diversity: cli 2/8, decompose 4/8.
- Review point: 4b judge — the 3 decls moved BYTE-IDENTICAL incl. the WHY comment (verify by diff); classifyTier+ModelTier were used ONLY by the moved cluster so removing the multi-agent import is safe (cli build + lint 0 prove no dangling ref); re-export keeps commands-ask.test.ts's `from "./commands-ask.js"` import working (full cli suite 229 files/2652 tests green); no cycle (ask-tier-models imports only @muse/multi-agent, a leaf-ward dep).
- Risk: low — pure relocation of pure env/routing helpers behind import+re-export; byte-identical + 4-case tested; routeAskTierModel's single internal use resolves via the new import.

## fire 72 · 2026-06-14 · loop-creator v1.14.0 · 4d4a21c7
meta: value-class=refactor · pkg=@muse/cli · kind=decompose · verdict=PASS · firesSinceDrill=7
ratchet: testFiles 996 · fabrication 0 · groundedSurfaces 27 · commands-doctor 738->673 LOC
- What: extracted the run-outcomes doctor sub-command (the `muse doctor --run-outcomes` cluster: pure formatRunOutcomes + readRunOutcomeEntries (reads .muse/runs/*.jsonl) + runRunOutcomesDoctor orchestrator) out of commands-doctor.ts into a new sibling commands-doctor-outcomes.ts. The cluster uses ONLY importable symbols (analyzeRunOutcomes/RunOutcomeEntry/RunOutcomeSummary from @muse/mcp, node fs/path, ProgramIO) — no file-level shared consts — so it moves byte-identical (runRunOutcomesDoctor gains `export` so commands-doctor imports it for the --run-outcomes branch; formatRunOutcomes stays exported + re-exported for the test). The 3 mcp symbols were cluster-only so trimmed from commands-doctor's mcp import. +3-case OUTCOME test (no-graded-runs, fail-rate head, top-failing-topics).
- Why: ABORTED the higher-value macos-tools app-read decompose mid-fire — its 470-LOC cluster looked cluster-only by its OWN symbols but USES file-level shared infra (MacOsascriptRunner/defaultOsascriptRunner/parseWifiDevice + path consts) shared with system-set, so a clean extraction needs a prior shared-infra move to macos-exec.ts (recorded as a backlog PREREQ; genuinely multi-fire). Pivoted to the commands-doctor run-outcomes cluster which is genuinely self-contained (verified: uses only importable deps). decompose KIND (4/8) — (cli,decompose) pair 2/8, under the 6/8 wall. Diversity: cli 3/8, decompose 5/8 (next fire must vary KIND).
- Review point: 4b judge — the 3 fns moved BYTE-IDENTICAL (verify by diff, runRunOutcomesDoctor only gained `export`); the 3 trimmed mcp imports were cluster-only (commands-doctor build+lint 0 prove no dangling ref + join/fs still used elsewhere); re-export keeps commands-doctor.test.ts's formatRunOutcomes import working (full cli suite 230 files/2655 tests green); no cycle (outcomes imports only @muse/mcp + node + a type).
- Risk: low — pure relocation behind import+re-export; byte-identical + 3-case tested; the run-outcomes path is exercised by the unchanged commands-doctor.test.ts. (Mid-fire abort of macos cost some budget but produced a recorded prereq, not a bad merge.)

## fire 73 · 2026-06-14 · loop-creator v1.14.0 · d857234b
meta: value-class=refactor · pkg=@muse/memory+@muse/cli · kind=comment-hygiene · verdict=PASS · firesSinceDrill=0 (reset)
ratchet: testFiles 997 · fabrication 0 · groundedSurfaces 27 · JUDGE-DRILL (9th)
- JUDGE-DRILL (triggered: 8 consecutive allPASS): injected a BAD slice on a NEW axis (distinct from fire 49 comment-WHY, 57 in-place threshold, 65 security-token) — a FALSE-REDUNDANCY dead-code removal: dropped the `/^[~/.]/u` filesystem-path-prefix regex from macos-tools.ts `looksLikeUrlOrPath`, committed as "drop redundant path-prefix check — the scheme regex already covers it". It COMPILES clean (types unchanged) so deterministic gates miss it. The independent Opus 4b judge correctly FAILED it: traced both regexes against concrete inputs (`~/Documents/file.pdf`, `/Applications/Foo.app`, `./local.txt`, `../up.txt` all flip true→false), proved the two regexes match DISJOINT classes (scheme:// vs path prefixes, neither subsumes the other), found the exact user-facing regression (mac_app_open misroutes a path from `open <path>` to `open -a <path>` → tries to launch an app named by the path → fails), and caught the comment-integrity violation (doc still claims "or a filesystem path"). Rolled back via git reset --hard HEAD~1. Verifier validated on the false-dead-code / behavior-preservation axis.
- What (real slice): stripped 2 rot iteration markers from source comments — "iter 16" in @muse/memory message-importance.ts (rewrote to "the same false-positive class the tool-filter min-length guard closed" — keeps the cross-ref WHY) + "fire 8" in @muse/cli chat-grounding.ts (kept "parity with muse ask"). Comment-only, zero behavior change.
- Why: comment-hygiene KIND (0/8 in window) — MUST vary off decompose (was 5/8, 3-in-a-row at 68/71/72); the only genuine rot left in source. Deliberately KEPT commands-swarm.ts "round 1" (a ReConcile arXiv:2309.13007 consensus-round DOMAIN term, not an iteration marker). Diversity: comment-hygiene resets the decompose dominance.
- Review point: 4b judge — comment-only diff (no code/AST change, build+lint+check rc=0 confirm); the removed tokens were pure iteration rot (code-style.md forbidden class), the surrounding WHY (min-length rationale, ask-parity) preserved; the swarm round-1 domain term untouched.
- Risk: none — comments only; no symbol/behavior touched. (Fire's main work was the JUDGE-DRILL validating the verifier; the real slice is a low-risk hygiene close.)

## fire 74 · 2026-06-14 · loop-creator v1.14.0 · 6af10f70
meta: value-class=refactor · pkg=@muse/macos · kind=cohere · verdict=PASS · firesSinceDrill=1
ratchet: testFiles 997 · fabrication 0 · groundedSurfaces 27 · macos-tools 1141->1134 LOC (infra→base)
- What: moved the shared osascript-runner infrastructure — the MacOsascriptRunner type + defaultOsascriptRunner (the `osascript -` spawn-wrapper over runChild) + its OSASCRIPT_PATH (now private) / OSASCRIPT_TIMEOUT_MS consts — OUT of macos-tools.ts INTO the macos-exec.ts shared base, where runChild/escapeAppleScript/isPermissionError already live (macos-exec's own doc comment anticipates exactly this: "so the tool factories can be decomposed into per-family modules over the shared base"). macos-tools imports the runner + OSASCRIPT_TIMEOUT_MS back; the ~16 usage sites (4 tool families inject `runner ?? defaultOsascriptRunner`, 4 timeout-error strings) are UNCHANGED; MacOsascriptRunner is re-exported from macos-tools so the test's package-level import still resolves.
- Why: the fire-72 PREREQ (recorded blocker) that unblocks the macos-tools (1141-LOC god-file) per-family decompose — defaultOsascriptRunner is shared by 4 families (app-read/media/system-set/message-send), so importing it back from macos-tools.ts would CYCLE; relocating it to the base breaks that. cohere KIND (2/8 in window) on a FRESH package (macos absent from last-8 window — varies off decompose 4/8 + cli dominance). No new OUTCOME test: defaultOsascriptRunner is a spawn-wrapper (osascript, mac-only — not portably unit-testable; a const assertion would be a forbidden declaration-only test); its behavior is byte-identical + covered by the 109 existing family tests that inject the runner. Diversity: macos 1/8, cohere 2/8.
- Review point: 4b judge — the 4 symbols moved BYTE-IDENTICAL (verify by diff); OSASCRIPT_PATH was used ONLY by defaultOsascriptRunner so it moves private (not re-imported); OSASCRIPT_TIMEOUT_MS still used 4× in macos-tools so it's exported + imported back; no cycle (macos-exec imports nothing from macos-tools — it's the leaf base); macos build + 109 tests green, full check rc=0; the SHARED parseWifiDevice/NETWORKSETUP infra is deliberately LEFT (recorded as the next sub-slice).
- Risk: low — pure relocation of a spawn-wrapper into the existing shared base behind import+re-export; byte-identical; behavior covered by the unchanged family tests; usage sites untouched.

## fire 75 · 2026-06-14 · loop-creator v1.14.0 · 862ad3e2
meta: value-class=refactor · pkg=@muse/macos · kind=decompose · verdict=PASS · firesSinceDrill=2
ratchet: testFiles 998 · fabrication 0 · groundedSurfaces 27 · macos-tools 1134->1048 LOC
- What: extracted the mac_media_control tool family (the MEDIA_ACTIONS/MediaAction/MEDIA_VERB consts + buildMediaScript + MacMediaControlToolDeps + createMacMediaControlTool — Music transport: play/pause/playpause/next/previous) out of the macos-tools.ts god-file into a new sibling macos-media-tool.ts. This is the FIRST per-family extraction the fire-74 runner→base move enabled: the family's only deps (defaultOsascriptRunner/isPermissionError/OSASCRIPT_TIMEOUT_MS + MacCommandResult/MacOsascriptRunner types) are now all in macos-exec.ts, so the sibling imports from the base with NO cycle. macos-tools re-exports createMacMediaControlTool + MacMediaControlToolDeps (matching the macos-utility-tools precedent) so the test + apps/cli actuator-tools (both import via the @muse/macos package) are unchanged. +4-case OUTCOME test (enum well-formedness, unknown-action rejection with no runner call, pause `if it is running` guard, next→track-verb mapping).
- Why: decompose KIND (3/8 in window) on a FRESH (pkg,kind) pair — (macos,decompose) is 0/8 — directly cashing in the fire-74 prereq (varies off cli-decompose dominance + the recent cohere run). media_control was the cleanest first family: its 4 internal symbols have 0 outside-uses and all external deps moved to the base in fire 74. Diversity: macos 2/8, decompose 4/8.
- Review point: 4b judge — the family moved BYTE-IDENTICAL (verify by diff); the 4 internal symbols (MEDIA_ACTIONS/MEDIA_VERB/MediaAction/buildMediaScript) had 0 outside-uses (cluster-only); re-export keeps macos-tools.test.ts + actuator-tools resolving via the package (macos 4 files/113 tests green; +4 new); no cycle (macos-media-tool imports only macos-exec + type-only @muse/tools+@muse/shared); the macos-exec imports stay used by the other families (build+lint 0).
- Risk: low — pure relocation of a self-contained tool family behind import+re-export; byte-identical + 4-case tested; the injected-runner contract is exercised by the new OUTCOME test + the unchanged family tests.

## fire 76 · 2026-06-14 · loop-creator v1.14.0 · 0a830d10
meta: value-class=refactor · pkg=@muse/macos · kind=cohere · verdict=PASS · firesSinceDrill=3
ratchet: testFiles 998 · fabrication 0 · groundedSurfaces 27 · macos-tools 1048->1036 LOC (wifi infra→base)
- What: moved the shared Wi-Fi infrastructure — parseWifiDevice (pure parser of `networksetup -listallhardwareports` → the Wi-Fi interface, e.g. 'en0') + the NETWORKSETUP_PATH const — OUT of macos-tools.ts INTO the macos-exec.ts shared base. Both are used by TWO families: mac_app_read (wifi_status read, lines 552/577) and mac_system_set (wifi_on/off, line 783); NETWORKSETUP_PATH also by both. IPCONFIG_PATH was LEFT in macos-tools (app_read-only — it'll move with app_read's eventual extraction). macos-tools imports parseWifiDevice + NETWORKSETUP_PATH back; the 7 usage sites are unchanged. +3-case OUTCOME test for parseWifiDevice in macos-exec.test.ts (Wi-Fi device parsed from the line after the port; undefined when no Wi-Fi port; undefined for empty).
- Why: the 2nd macos prereq (recorded fire 72/74) — parseWifiDevice/NETWORKSETUP are the last file-level symbols app_read & system_set share, so relocating them to the leaf base lets BOTH families extract without a cycle (the remaining blocker after fire 74's runner move). cohere KIND (2/8 in window) — varies off decompose (4/8) while continuing the macos roadmap; unlike fire 74's spawn-wrapper, parseWifiDevice is PURE so it gets a real OUTCOME test. Diversity: macos 2/8 (cohere), (macos,cohere) 2/8.
- Review point: 4b judge — parseWifiDevice + NETWORKSETUP_PATH moved BYTE-IDENTICAL (the regex `/Hardware Port:\s*Wi-Fi/iu` + `/Device:\s*(\S+)/u`, the path string — verify by diff); both had 0 external importers (internal move, no re-export) but ARE shared across 2 families so they move to the base not into one family; macos-exec stays a leaf (imports only node:child_process); IPCONFIG_PATH correctly left (app_read-only); macos build + 120 tests green (+3 new), full check rc=0.
- Risk: low — pure relocation of a pure parser + a path const into the shared base behind import; byte-identical; usage sites untouched; behavior now MORE covered (parseWifiDevice was only indirectly tested, now has direct OUTCOME cases).

## fire 77 · 2026-06-14 · loop-creator v1.14.0 · 4a31f4aa
meta: value-class=refactor · pkg=@muse/macos · kind=decompose · verdict=PASS · firesSinceDrill=4
ratchet: testFiles 999 · fabrication 0 · groundedSurfaces 27 · macos-tools 1036->968 LOC
- What: extracted the mac_app_open tool family (OPEN_PATH/OPEN_TIMEOUT_MS consts + looksLikeUrlOrPath + MacAppOpenToolDeps + createMacAppOpenTool — opens an app / URL / file via `/usr/bin/open`) out of macos-tools.ts into a new sibling macos-app-open-tool.ts. All of app_open's consts/helpers are SINGLE-FAMILY (OPEN_PATH/OPEN_TIMEOUT_MS/looksLikeUrlOrPath have 0 outside-uses), so they move WITH the family; the only base dep is runChild (+ MacCommandResult type). No osascript/escapeAppleScript needed (open is a direct CLI). macos-tools re-exports createMacAppOpenTool + MacAppOpenToolDeps so the test + apps/cli actuator-tools (via the @muse/macos package) are unchanged. +6-case OUTCOME test incl. the URL-vs-path-vs-app routing.
- Why: decompose KIND (3/8 in window) cashing in the now-clean macos base — app_open is single-family so it extracts with NO new shared-symbol prep (unlike app_read/system_set which still share PMSET_PATH). Gives looksLikeUrlOrPath (the fire-73 JUDGE-DRILL target — its `[~/.]` filesystem-path branch) a tested home: the new test asserts `~/report.pdf` opens DIRECTLY (no `-a`), pinning the exact behavior the drill's false-redundancy removal would have broken. NOTE: 4th consecutive @muse/macos fire — (macos,decompose) pair only 2/8 so the ratchet is satisfied, but I will deliberately VARY the package next fire (pkg-concentration hygiene, beyond the strict pair gate). Diversity: macos 3/8, decompose 4/8.
- Review point: 4b judge — the family moved BYTE-IDENTICAL incl. the looksLikeUrlOrPath two-regex body + the open argv routing (`looksLikeUrlOrPath(target) ? [target] : ["-a", target]`) — verify by diff; the 3 internal symbols had 0 outside-uses; re-export keeps callers/test resolving (macos 6 files/126 tests green, +6); no cycle (macos-app-open-tool imports only runChild from the base + types); the base imports remaining in macos-tools stay used by other families (build+lint 0).
- Risk: low — pure relocation of a self-contained family behind import+re-export; byte-identical + 6-case tested (incl. the path-routing the fire-73 drill flagged); usage sites untouched.

## fire 78 · 2026-06-14 · loop-creator v1.14.0 · 1fcc0d95
meta: value-class=refactor · pkg=@muse/cli · kind=dead-code · verdict=PASS · firesSinceDrill=5
ratchet: testFiles 999 · fabrication 0 · groundedSurfaces 27 · knip cli dead-exports 6 -> 0
- What: removed 6 knip-flagged dead exports across 6 NON-chat cli command files. (a) De-exported 5 internal-only consts (dropped `export`, kept the const + internal uses): MIN_BENFORD_SAMPLE (benford.ts, used 2x internally), MEMORY_KIND_FORMS (commands-memory.ts, 1x), MUSE_EXPORT_MAGIC + MUSE_EXPORT_VERSION (export-crypto.ts, 5x/2x), DEMO_CORPUS_SIZE (commands-demo.ts, 1x) — each had 0 external + 0 test importers. (b) REMOVED the truly-dead appendJobEvent function (commands-jobs.ts) — def-only, 0 uses anywhere; its stale comment ("exposed for the worker child process") was wrong: job-worker.ts inlines its OWN `appendFile` with scrubJobEvent, never importing appendJobEvent. Removed the function + the stale comment + trimmed the now-unused `appendFile` import (JobEvent kept — used 5x elsewhere).
- Why: VARIED the package (off 4 consecutive @muse/macos fires — pkg-concentration hygiene as promised in fire 77) AND the KIND (dead-code 1/8, off decompose 4/8). Chose NON-chat command files (benford/memory/export-crypto/demo/jobs) to avoid collision with the concurrent surfaces loop's chat-* churn. All 6 verified via knip + repo-wide grep (own-file occ + ext-nontest + test refs). Diversity: cli 1/8 (dead-code), dead-code 1/8.
- Review point: 4b judge — every de-exported const is still used INTERNALLY (build proves it, no dangling); appendJobEvent is genuinely dead (job-worker.ts has its own appendFile at line 48, never imports appendJobEvent; only a dist .d.ts artifact mentions it); the appendFile import trim is safe (appendFile's only non-import use WAS inside appendJobEvent); knip now reports 0 of the 6; cli build + lint 0 + full check rc=0.
- Risk: low — 5 pure visibility narrowings (no behavior change) + 1 dead-function removal whose liveness was verified against the worker's actual (inlined) append path; no new test needed (de-exports keep internal behavior; the removed fn was unreachable).

## fire 79 · 2026-06-14 · loop-creator v1.14.0 · 742d32ad
meta: value-class=refactor · pkg=@muse/observability · kind=decompose · verdict=PASS · firesSinceDrill=6
ratchet: testFiles 1000 · fabrication 0 · groundedSurfaces 27 · observability-detectors 371->187 LOC
- What: extracted the SloAlertEvaluator detector (SloViolationType/SloViolation/SloAlertEvaluatorOptions types + the sliding-window latency/error-rate SLO evaluator class + its PRIVATE percentileMs p95 helper) out of the 371-LOC observability-detectors.ts into a new sibling observability-slo-alert.ts. This continues fire 66's "one detector per module" decompose (which split MonthlyBudgetTracker). KEY finding: the 3 stats helpers were NOT actually shared — PromptDriftDetector uses meanOfNumbers+stdDevOfNumbers (4×/3×), SloAlertEvaluator uses percentileMs (2×) ONLY — so percentileMs moved WITH the Slo detector and mean/stdDev stayed with drift; no shared-stats prep needed. observability-detectors re-exports the 4 Slo symbols (matching the budget-tracker precedent) so index.ts's barrel re-export is unchanged. +3-case OUTCOME test (latency p95 over threshold → latency violation; under threshold → none; error-rate over threshold → error_rate violation).
- Why: decompose KIND on a FRESH package (@muse/observability — last in window was fire 66, out of the last-8) — varies the package off the 4 recent macos + 3 cli fires. SloAlertEvaluator (~165 LOC) is the biggest remaining self-contained detector. Diversity: observability 1/8, (observability,decompose) 1/8 (fire 66 was the only prior).
- Review point: 4b judge — the Slo cluster + percentileMs moved BYTE-IDENTICAL (verify by diff); percentileMs was Slo-ONLY (used at the 2 p95 sites in the class, 0 in drift/budget) so it correctly moved; mean/stdDev correctly STAYED (drift-only); re-export keeps index.ts + muse-snapshot + agent-metrics + the tests resolving (observability 11 files/131 tests green, +3 new); no cycle (slo-alert is a pure leaf, zero imports). NOTE: full `pnpm check` hit rc=134 (SIGABRT) on the @muse/macos vitest runner AFTER macos tests passed 132/132 — a concurrent-loop OOM ("memory allocation of 48 bytes failed"), confirmed flake via isolated reruns (macos rc=0, observability rc=0); not a regression.
- Risk: low — pure relocation of a self-contained detector + its private stat behind a re-export; byte-identical + 3-case tested; the stats-sharing was verified absent (each detector owns its stats).

## fire 80 · 2026-06-14 · loop-creator v1.14.0 · b876b3cb
meta: value-class=refactor · pkg=@muse/observability · kind=decompose · verdict=PASS · firesSinceDrill=7
ratchet: testFiles 1001 · fabrication 0 · groundedSurfaces 27 · observability-detectors 192->42 LOC (now a pure barrel)
- What: extracted the LAST detector — PromptDriftDetector (DriftType/DriftAnomaly/DriftStats/PromptDriftDetectorOptions types + DRIFT_MIN_STDDEV_FLOOR_RATIO + the class + its mean/stdDev helpers) — out of observability-detectors.ts into a new sibling observability-prompt-drift.ts. This COMPLETES the "one detector per module" decompose started fire 66 (MonthlyBudgetTracker) + 79 (SloAlertEvaluator): observability-detectors.ts is now a PURE 42-LOC BARREL (just the doc comment + 3 re-export blocks for budget/drift/slo). mean/stdDev moved WITH drift (drift's only stats; percentileMs already left with slo in f79 — verified percentileMs=0 in the file). +3-case OUTCOME test (mean-shift → input_length anomaly; stable → none; below-minSamples → none).
- Why: decompose KIND (4/8 in window — the clean cohere/dead-code/comment-hygiene veins are exhausted for non-hot packages: utility dups are divergent (slugify NFKD-vs-simple) or hot (median/toError), rot markers down to 1 legit domain term). The (observability,decompose) pair is only 1/8 (f79) so the ratchet is satisfied at decompose 5/8. This finishes a multi-fire refactor cleanly (the 480-LOC god-file → 3 per-detector modules + a thin barrel). Diversity: observability 2/8, decompose 5/8 — next fire MUST vary KIND (and fire 81 is the JUDGE-DRILL).
- Review point: 4b judge — the drift cluster + mean/stdDev moved BYTE-IDENTICAL (verify by diff); mean/stdDev were drift-ONLY (used 6×/4× by PromptDriftDetector, 0 by the now-gone slo); the barrel re-exports all 3 detector families so index.ts + consumers + the dedicated drift-detector.test.ts are unchanged (observability 12 files/134 tests green, +3 new); no cycle (prompt-drift is a pure zero-import leaf); observability-detectors.ts is now ONLY re-exports (no logic left to break).
- Risk: low — pure relocation of a self-contained detector + its private stats behind a re-export; byte-identical + 3-case tested; the file it leaves behind is a pure barrel (nothing executable to regress).

## fire 81 · 2026-06-14 · loop-creator v1.14.0 · 6fb478ef
meta: value-class=refactor · pkg=@muse/api · kind=dead-code · verdict=PASS · firesSinceDrill=0 (reset)
ratchet: testFiles 1001 · fabrication 0 · groundedSurfaces 27 · JUDGE-DRILL (10th)
- JUDGE-DRILL (triggered: 8 consecutive allPASS since fire 73): injected a BAD slice on a NEW axis (distinct from 49 comment-WHY, 57 in-place threshold, 65 security-token, 73 false-redundancy dead-code) — a BYTE-IDENTICAL-EXTRACTION CLAIM THAT IS FALSE: "extracted" parseWifiDevice from macos-exec.ts into a new macos-wifi.ts committed as "byte-identical move", but SILENTLY changed the Device-capture regex `/Device:\s*(\S+)/u` → `/Device:\s*(.+)/u` (\S+ → greedy .+). This is the FIRST drill where ALL deterministic gates PASS: it compiles AND all 132 macos tests pass (the test fixtures use clean "Device: en0" with no trailing whitespace, so .+ and \S+ both return "en0") — so ONLY a character-level diff catches it. The independent Opus 4b judge correctly FAILED it: pulled the original from the merge-base, diffed char-by-char, found the \S+→.+ alteration, reasoned the exact regression ("Device: en0 " → old "en0" vs new "en0 "; trailing content now captured → a malformed device id fed to downstream networksetup), AND explicitly named the test blind spot (clean fixtures pass under both regexes — "tests pass" is worthless, only diff review catches it). Rolled back via git reset --hard HEAD~1. Verifier validated on the extraction-faithfulness axis — the gates-pass-only-judge-catches case that most justifies maker≠judge.
- What (real slice): removed 3 knip-flagged dead exports in @muse/api — de-exported invalid() (mcp-routes-parsers.ts; 12 internal uses, 0 barrel importers) + removed the superseded registerLineWebhookRoute (a dead `server.register(lineWebhookPlugin)` wrapper — the LINE webhook is wired via lineWebhookPlugin directly in server.ts; trimmed the now-unused FastifyInstance import) + removed the def-only-dead MultiAgentOrchestrateResponseBody type.
- Why: dead-code KIND (varies off decompose 5/8 — MUST per the diversity note) on @muse/api (fire 69 only did server-helpers; api less churny than cli). All 3 verified via knip + grep (own-file/ext-nontest/test refs) + liveness check (registerLineWebhookRoute superseded by the plugin). Diversity: api 1/8, dead-code 1/8.
- Review point: 4b judge — invalid() still used 12× internally (de-export, no dangling); registerLineWebhookRoute genuinely dead (lineWebhookPlugin is the live path in server.ts:24, the wrapper never called) + FastifyInstance trim safe (was its only use); MultiAgentOrchestrateResponseBody def-only (0 refs); api 145 files/850 tests green, knip 0 of the 3.
- Risk: low — 1 visibility narrowing + 2 dead removals, all knip+grep+liveness verified; api build+tests green; no behavior touched.

## fire 82 · 2026-06-14 · loop-creator v1.14.0 · e956144a
meta: value-class=refactor · pkg=@muse/macos · kind=decompose · verdict=PASS · firesSinceDrill=1
ratchet: testFiles 1003 · fabrication 0 · groundedSurfaces 27 · macos-tools 968->900 LOC
- What: extracted the mac_shortcut_run family — the SHORTCUTS_PATH/SHORTCUTS_TIMEOUT_MS consts + ShortcutsRunner type + defaultShortcutsRunner + MacShortcutRunToolDeps + createMacShortcutRunTool (the "keystone" tool that runs any user Shortcut by name) — out of macos-tools.ts into a new sibling macos-shortcut-tool.ts. All 4 shortcut consts/runner were single-family (SHORTCUTS_* and defaultShortcutsRunner used only within the shortcut section), so they move WITH the family; the scattered top consts (SHORTCUTS_PATH 69, SHORTCUTS_TIMEOUT_MS 74, ShortcutsRunner 77, defaultShortcutsRunner 79) were lifted out while PMSET_PATH/DF_PATH/IPCONFIG_PATH (interleaved, app_read/system_set-owned) STAYED. Only base dep: runChild (+ MacCommandResult/MuseTool/JsonObject types). macos-tools re-exports createMacShortcutRunTool + MacShortcutRunToolDeps + ShortcutsRunner so the test + actuator-tools are unchanged. +4-case OUTCOME test (enum/schema, empty-name rejection w/ no spawn, named-run argv, --input-path passthrough).
- Why: decompose KIND (4/8 in window) — the cleanest remaining ready macos family (single-family, cycle-free since the f74/f76 base prep). The non-decompose veins (cohere/dead-code non-hot) are exhausted: voice isRecord dedup needs a NEW @muse/shared dep (over-coupling), other utility dups are divergent (slugify) or hot (median/toError). (macos,decompose) pair = 2/8 → 3/8, under the 6/8 gate. Diversity: macos 1/8, decompose 5/8 (vary KIND next).
- Review point: 4b judge — the family moved BYTE-IDENTICAL incl. the SHORTCUTS_TIMEOUT WHY comment (verify by diff); the 4 shortcut consts/runner were single-family (PMSET/DF/IPCONFIG correctly LEFT — they belong to app_read/system_set); re-export keeps macos-tools.test.ts + actuator-tools resolving via the package (macos 9 files/140 tests green, +4); no cycle (shortcut-tool imports only runChild from the base + types). NOTE: full pnpm check hit rc=134 (SIGABRT) on the @muse/auth vitest runner AFTER auth passed 61/61 — the same concurrent-loop OOM flake as f79 (then macos); macos isolated rc=0.
- Risk: low — pure relocation of a self-contained family behind import+re-export; byte-identical + 4-case tested; usage sites untouched; the interleaved-const split verified (single-family) so no shared symbol left dangling.

## fire 83 · 2026-06-14 · loop-creator v1.14.0 · ff36470f
meta: value-class=refactor · pkg=@muse/macos · kind=cohere · verdict=PASS · firesSinceDrill=2
ratchet: testFiles 1003 · fabrication 0 · groundedSurfaces 27 · macos-tools 900->898 LOC (PMSET→base)
- What: moved PMSET_PATH (= "/usr/bin/pmset") out of macos-tools.ts INTO the macos-exec.ts shared base. It is the LAST file-level symbol SHARED between two families: mac_app_read (battery read — `[PMSET_PATH, ["-g","batt"]]`) and mac_system_set (sleep/display_sleep — the pmset dep). DF_PATH + IPCONFIG_PATH stay in macos-tools (app_read-ONLY — they'll move WITH app_read's eventual extraction). macos-tools imports PMSET_PATH back; the 2 usage sites are unchanged. No new test (a path const moved into an existing tested module — a `toBe("/usr/bin/pmset")` assertion would be a forbidden declaration-only tautology; the path is exercised by the battery-read + system_set family tests).
- Why: MUST vary KIND off decompose (5/8) — cohere (1/8 in window). The non-decompose veins are otherwise dry: no clean dead-code in fresh/non-hot packages (knip findings only in hot agent-core/mcp + the already-done cli/api), utility dups divergent/hot, rot markers down to 1 legit term. This is the FINAL macos prep — with PMSET in the base, app_read + system_set (the 2 biggest remaining families) are both cycle-free and extractable next. (macos,cohere) pair = 1/8. Diversity: macos 1/8, cohere 1/8.
- Review point: 4b judge — PMSET_PATH moved BYTE-IDENTICAL (the path string); it WAS shared (app_read 517 + system_set 576) so it belongs in the base; DF_PATH/IPCONFIG_PATH correctly LEFT (app_read-only — verify they're still defined in macos-tools); macos-exec stays a leaf (PMSET is a bare const, no deps); the import-back keeps the 2 usage sites resolving (macos 9 files/140 tests green). NOTE: full pnpm check hit rc=134 (SIGABRT) on the @muse/auth runner AFTER auth passed 61/61 — the RECURRING concurrent-loop OOM flake (fires 79/82/83); auth + macos both rc=0 isolated.
- Risk: minimal — a single path-const relocation into the shared base behind an import; byte-identical; 2 usage sites untouched; no behavior change.

## fire 84 · 2026-06-14 · loop-creator v1.14.0 · 3e6ee74a
meta: value-class=refactor · pkg=@muse/macos · kind=decompose · verdict=PASS · firesSinceDrill=3
ratchet: testFiles 1004 · fabrication 0 · groundedSurfaces 27 · macos-tools 898->429 LOC
- What: extracted the mac_app_read family — the BIGGEST macos family (~470 LOC: MAC_OSASCRIPT_READ_APPS/MAC_SHELL_READ_APPS/MAC_APP_READ_APPS consts + MacReadApp type + buildReadScript (the per-source AppleScript snippets) + parseReadOutput + 5 shell parsers (battery/storage/wifi_status/ip_address/running_apps) + MacAppReadToolDeps + createMacAppReadTool) out of macos-tools.ts into a new sibling macos-app-read-tool.ts. The app_read-ONLY DF_PATH + IPCONFIG_PATH consts moved WITH the family (their only user); all SHARED deps (defaultOsascriptRunner/escapeAppleScript/runChild/parseWifiDevice/NETWORKSETUP_PATH/PMSET_PATH/OSASCRIPT_TIMEOUT_MS) are imported from the macos-exec base — clean only because the f74/f76/f83 prep moved every shared symbol there. macos-tools re-exports createMacAppReadTool + MacAppReadToolDeps. +4-case OUTCOME test (enum/schema, unknown-app rejection, contacts-query-required no-spawn, clipboard read via injected runner).
- Why: decompose KIND (4/8 in window) — the top clean ◦, now cycle-free after fire 83 completed the base prep. This is the same app_read cluster I ABORTED in fire 72 (it shared file-level infra then); the 3-fire prep (f74 runner, f76 wifi, f83 pmset) made it cleanly extractable. macos-tools 898→429 LOC (was 1141 at f73 — a 62% reduction across the family extractions). (macos,decompose) pair 2/8→3/8, under 6/8. Diversity: macos 1/8, decompose 5/8 (vary KIND next).
- Review point: 4b judge — the family moved BYTE-IDENTICAL incl. all the AppleScript snippet strings in buildReadScript + the parse-helper logic (verify by diff); the 11 cluster symbols had 0 outside-uses; DF/IPCONFIG correctly moved (app_read-only, were their only user); the base imports were complete (build caught a missing OSASCRIPT_TIMEOUT_MS, now added); re-export keeps macos-tools.test.ts + actuator-tools resolving (macos 10 files/144 tests green, +4); no cycle (app-read-tool imports only macos-exec + types).
- Risk: low-moderate (large 470-LOC move) — but pure relocation behind import+re-export, byte-identical, +4-case tested, and the cluster-only/shared-dep separation was verified symbol-by-symbol; the unchanged family tests exercise the read paths.

## fire 85 · 2026-06-14 · loop-creator v1.14.0 · c48f6e6f
meta: value-class=refactor · pkg=@muse/model · kind=dead-code · verdict=PASS · firesSinceDrill=4
ratchet: testFiles 1005 · fabrication 0 · groundedSurfaces 27 · knip unresolved-imports 1->0
- What: fixed a dead/phantom-module import in packages/model/test/sse-trailing-event.test.ts. The test imports `type { ModelEvent } from "../src/types.js"` — but NO types.ts/types.js exists in model/src; ModelEvent's canonical home is src/index.ts:147, and every OTHER model test imports it from "../src/index.js". Repointed the import to "../src/index.js" (the convention). ModelEvent is genuinely USED in the test (the collect()/textOf() AsyncIterable<ModelEvent> signatures), so it's a wrong-PATH fix, not an unused-import removal.
- Why: MUST vary KIND off decompose (5/8) — and the non-decompose veins are otherwise dry (rot markers down to 1 legit term; no clean dead-code in fresh/non-hot packages; utility dups divergent/hot). knip's "Unresolved imports (1)" flagged this latent defect that BOTH deterministic gates miss: the type-only import is erased by vitest at runtime (test passes), and tsc's package build excludes test files (build passes) — so a test depending on a phantom module path sat undetected. Classified dead-code (a dead/unresolved module reference — knip's category). (model,dead-code) pair = 1/8. Diversity: model 1/8, dead-code 3/8 — breaks the decompose run.
- Review point: 4b judge — behavior-preserving (ModelEvent is the SAME type whether via the phantom types.js or the real index.js; the test runs identically — 17 files/299 tests green); the fix aligns with all other model tests' `../src/index.js` import; knip's unresolved-import warning now 0; pure test-file import-path correction, no source touched.
- Risk: minimal — a single test-file import-path correction to the canonical module; type-only (erased at runtime); the test's assertions are unchanged.

## fire 86 · 2026-06-14 · loop-creator v1.14.0 · 2dd95546
meta: value-class=refactor · pkg=@muse/macos · kind=decompose · verdict=PASS · firesSinceDrill=5
ratchet: testFiles 1006 · fabrication 0 · groundedSurfaces 27 · macos-tools 429->328 LOC
- What: extracted the mac_system_set family (SYSTEM_SETTINGS/SystemSetting consts+type + MacSystemSetToolDeps + createMacSystemSetTool — volume/mute/unmute/display_sleep/sleep/wifi_on/wifi_off) out of macos-tools.ts into a new sibling macos-system-set-tool.ts. This is the LAST non-outbound macos family — it COMPLETES the macos family decomposition begun fire 19/43: macos-tools is now 328 LOC (was 1141 at f73), holding only the mac_message_send cluster (deferred, outbound-safety) + the 5 re-export blocks. system_set's only deps are the macos-exec base (defaultOsascriptRunner/runChild/parseWifiDevice/NETWORKSETUP_PATH/PMSET_PATH/OSASCRIPT_TIMEOUT_MS) — cycle-free since the f74/f76/f83 prep. After it + app_read (f84) both left, NETWORKSETUP_PATH/parseWifiDevice/PMSET_PATH/runChild became unused in macos-tools → trimmed from its macos-exec import (escapeAppleScript/isPermissionError/defaultOsascriptRunner/OSASCRIPT_TIMEOUT_MS stay — message_send uses them). +3-case OUTCOME test (enum/schema, volume set+clamp-to-100, volume-requires-numeric no-spawn).
- Why: decompose KIND (4/8 in window — not dominant after f77 aged out) on the top clean ◦; finishes a major multi-fire refactor. (macos,decompose) pair 2/8→3/8, under 6/8. The macos-tools god-file (1141 LOC, 7 tool families) is now 6 per-family sibling modules + a thin barrel + the outbound cluster. Diversity: macos 1/8, decompose 5/8 (vary KIND next).
- Review point: 4b judge — the family moved BYTE-IDENTICAL incl. the AppleScript volume/mute/sleep/wifi command strings (verify by diff — cf. f81 drill's regex tamper); SYSTEM_SETTINGS/SystemSetting cluster-only (0 outside-uses); the 4 trimmed base imports were genuinely unused after app_read+system_set left (lint flagged them, build clean after trim); re-export keeps macos-tools.test.ts + actuator-tools resolving (macos 12 files/151 tests green, +3); no cycle.
- Risk: low — pure relocation of a self-contained family behind import+re-export; byte-identical + 3-case tested; the import-trim was lint-driven (the 4 were provably unused); message_send (the only family left) verified to still use its base imports.

## fire 87 · 2026-06-14 · loop-creator v1.14.0 · ea8c655a
meta: value-class=refactor · pkg=@muse/cli · kind=dead-code · verdict=PASS · firesSinceDrill=6
ratchet: testFiles 1007 · fabrication 0 · groundedSurfaces 27 · knip cli dead-exports 3->0 (+1 cascade)
- What: removed 4 dead exports across 3 stable (non-chat) cli files. (a) De-exported friendlyFetchError (program-helpers.ts) — 4 internal uses, 0 importers (a test string-match, not an import). (b) De-exported isNodeError (program-helpers.ts) — 3 internal uses; its export is dead because chat-history.ts + credential-store.ts each carry their OWN local isNodeError copy (a 3x dup — noted for a future cohere, NOT touched here). (c) Removed the dead DEFAULT_TODAY_HEADLINES_CAP from the commands-today.ts re-export block (nobody imports it through commands-today); this CASCADED — with the re-export gone, the const's own `export` in commands-today-feeds.ts became unused (it's used only internally at lines 49/52), so de-exported that too.
- Why: MUST vary KIND off decompose (5/8) — dead-code (2/8). The recorded cli backlog ◦; chose the STABLE non-chat files (program-helpers utility + commands-today) to avoid the surfaces loop's chat-* churn. All 4 verified via knip + repo-wide grep (own-file/ext-nontest/test refs + the cascade re-check). (cli,dead-code) pair = 2/8. Diversity: cli 1/8, dead-code 2/8.
- Review point: 4b judge — all 4 are visibility narrowings (no behavior change): friendlyFetchError/isNodeError still used internally in program-helpers (build proves it); DEFAULT_TODAY_HEADLINES_CAP still used internally in commands-today-feeds (49/52); the re-export removal left the OTHER re-exported symbols (formatHeadlines/formatWeatherLine/resolveTodayFeedHeadlines/resolveTodayWeatherLine — still consumed via commands-today) intact; isNodeError's external "refs" are SEPARATE local copies (chat-history:298, credential-store:222), not imports of program-helpers'; cli build + lint 0 + check rc=0; knip 0 of the 4.
- Risk: low — 3 de-exports + 1 dead-re-export removal, all knip+grep verified; no behavior touched; the cascade (def export unused after re-export removal) was caught + cleaned in the same slice.

## fire 88 · 2026-06-14 · loop-creator v1.14.0 · 8fe67e19
meta: value-class=refactor · pkg=@muse/cli · kind=decompose · verdict=PASS · firesSinceDrill=7
ratchet: testFiles 1008 · fabrication 0 · groundedSurfaces 27 · commands-daemon 1276->1242 LOC
- What: extracted the daemon-config persistence cluster (the DaemonConfig interface + resolveDaemonConfigFile (env→~/.config/muse/daemon.json path) + readDaemonConfig (tolerant JSON parse — missing/malformed → {}) + writeDaemonConfig (mkdir+write)) out of the 1276-LOC commands-daemon.ts god-file into a new sibling commands-daemon-config.ts. The cluster's only deps are node builtins (fs/os/path) — no cli-local deps — so it moves byte-identical (the "Tolerant" WHY comment kept). DaemonConfig was cluster-only; the 3 functions are each called once in registerDaemonCommands, which now imports them back (grouped with the existing commands-daemon-launchagent sibling import). No import-trim needed (the fs/os/path builtins are used 3-13× elsewhere in commands-daemon). +5-case OUTCOME test (explicit-env + default path resolution; tolerant read of valid/missing/malformed).
- Why: decompose KIND (4/8 in window) on a FRESH (cli,decompose) pair (0/8 — no cli decompose in the last-8) + FRESH package (cli, off the recent macos run); commands-daemon is the 4th-largest cli god-file (1276 LOC). The config cluster is the cleanest self-contained piece (config I/O, node-builtin-only). Diversity: cli 1/8, (cli,decompose) 0/8→1/8.
- Review point: 4b judge — the cluster moved BYTE-IDENTICAL incl. the tolerant-parse logic + the path-resolution + the WHY comment (verify by diff); DaemonConfig/resolve/read/write had 0 external importers; the import-back keeps registerDaemonCommands's 3 call sites resolving (full cli suite 231 files/2668 tests green, +5 new); no cycle (commands-daemon-config imports only node builtins); the fs/os/path imports stay in commands-daemon (used elsewhere).
- Risk: low — pure relocation of a self-contained config-I/O cluster behind an import; byte-identical + 5-case tested (incl. the tolerant missing/malformed paths); call sites unchanged.

## fire 89 · 2026-06-14 · loop-creator v1.14.0 · 765a2e64
meta: value-class=refactor · pkg=@muse/cli · kind=decompose · verdict=PASS · firesSinceDrill=0 (reset — 6th JUDGE-DRILL completed)
ratchet: testFiles 1009 · fabrication 0 · groundedSurfaces 27 · commands-today 1326->1240 LOC
- What: TWO parts. (1) JUDGE-DRILL (allPASS≥8 trigger, fires 81-88 all PASS): injected a cosmetic-looking commit "tidy the SLO latency-p95 read" claiming "No behavior change" that silently flipped percentileMs(...,0.95)->0.9 at observability-slo-alert.ts:119. It built clean + 137 observability tests passed (the uniform 5-sample fixtures make p90==p95, so the gates are BLIND). The independent Opus ④b judge correctly FAILed it — caught 0.95->0.90, the p90/p95 divergence on non-uniform windows, the self-contradiction (still named `p95`, message still "P95 latency", the sibling snapshot() still uses 0.95), and the test blind spot. Rolled back via `git reset --hard HEAD~1` (both 0.95 sites restored). (2) REAL slice: extracted the stale-task + episode-revisit pure-helper cluster (STALE_TASK_DAYS/STALE_TASK_MAX consts + StaleTask/DueEpisode interfaces + selectStaleTasks/selectEpisodeToRevisit/formatEpisodeRevisitLine/formatStaleTasksSection) out of the 1326-LOC commands-today.ts god-file into a new sibling today-stale-revisit.ts (94 LOC). The cluster's only non-builtin dep is revisitDueInterval (from commands-notes-rag.js) — re-imported in the new file; commands-today.ts drops that now-unused import. import+re-export keeps commands-today.test.ts (imports these 4 from commands-today.js) resolving unchanged. +4-case OUTCOME test (today-stale-revisit.test.ts: stale picks open+undated oldest-first, excludes dated/done; episode picks largest-interval-crossed; formatters render age/singular-day).
- Why: JUDGE-DRILL was DUE (8 consecutive allPASS, fires 81-88) — hard-counter, not deferrable. Real slice = decompose KIND on a FRESH-pair-light window: (cli,decompose) 1/8(f88)->2/8, decompose 3/8, cli 3/8 — all well under the 6/8 ratchet. commands-today is the largest remaining cli god-file (1326 LOC); the stale/revisit pure helpers are the cleanest self-contained piece (no IO, no TodayBriefing/RecallHit coupling — unlike formatConnectionsSection/selectTodayOverdue, deliberately LEFT).
- Review point: ④b judge — (drill) verify the judge's FAIL reasoning was sound (0.95→0.90 IS a behavior change despite the uniform-fixture pass) and the rollback restored both p95 sites; (real) the cluster moved BYTE-IDENTICAL incl. the spacing-effect WHY comments (verify by diff); the 4 fns + 2 interfaces + 2 consts had 0 external importers beyond commands-today's re-export; revisitDueInterval re-import wired (build proves it) + the now-unused import removed from commands-today (lint flagged); re-export keeps commands-today.test.ts's 134-210 cases resolving (full cli suite 232 files/2672 tests green, +4 new); no cycle.
- Risk: low — pure relocation of a self-contained no-IO helper cluster behind import+re-export; byte-identical + 4-case tested; the one cross-module dep (revisitDueInterval) re-imported, the dropped import lint-verified unused. Drill confirms the maker≠judge verifier catches a gates-invisible false-no-op claim.

## fire 90 · 2026-06-14 · loop-creator v1.14.0 · 9865d8ca
meta: value-class=refactor · pkg=@muse/mcp · kind=cohere · verdict=PASS · firesSinceDrill=1
ratchet: testFiles 1010 · fabrication 0 · groundedSurfaces 27 · notion dup-helpers 2→1 source
- What: consolidated the Notion HTTP/response-parse primitives that were hand-DUPLICATED byte-for-byte in BOTH packages/mcp/src/tasks-providers-notion.ts and notes-providers-notion.ts into a new sibling notion-shared.ts. Moved: 4 consts (NOTION_DEFAULT_ENDPOINT/_VERSION/_TITLE_PROPERTY/_LIST_MAX_PAGES) + 4 functions (isTransientNotionStatus — 429/5xx retry classification; mapNotionStatus — HTTP→NOTION_AUTH/NOT_FOUND/RATE_LIMIT/HTTP_n; isRecordArray — body[key] array guard; extractTitleString — Notion rich-text title join). Each provider keeps its OWN domain-specific consts (tasks: STATUS_PROPERTY/OPEN/DONE; notes: BLOCKS_MAX_PAGES) and helpers (tasks: extractSelectName/parseDate; notes: parsePageSummary/extractParagraphText/bodyToParagraphBlocks) — only the genuinely-shared cluster moved. Both files now import the 8 symbols from ./notion-shared.js. +5-describe OUTCOME test (notion-shared.test.ts: const pins, transient-status classification, error-code mapping, record-array guard, rich-text title extraction incl. plain_text/text.content/empty/non-array/null).
- Why: cohere KIND (0/8 in the last-8 window — best possible diversity off the decompose streak which was 6/8); within ONE package (@muse/mcp) so NO new cross-package dep and NO pnpm-lock.yaml change (the post-merge --frozen-lockfile gate stays green). Chosen over the named "isRecord 8-dup" backlog item because that one is stale (most already done) and its remaining targets need either a new @muse/shared workspace dep on voice (lockfile churn) or touch the hot agent-core package. The notion files are NOT churned by the concurrent loops (only followup-firing-loop.ts is dirty). (mcp,cohere) pair 0/8→1/8.
- Review point: ④b judge — verify the 4 fns + 4 consts moved BYTE-IDENTICAL (diff each vs the deleted originals; both providers had identical copies, pre-verified by diff before the move); each provider still imports + USES all 8 (every symbol had ≥2 refs def+use in both files; no unused-import lint); the domain-specific consts/helpers were NOT touched; no behavior change (pure relocation behind import); mcp build clean + notion tests (4 files/14) green isolated + full check rc=0 (mcp 194 files). The 1 plan-cache "caps at MAX_PLAN_CACHE_ENTRIES" failure in the filtered run was the known CPU-contention load-timeout (backlog:234), passes isolated in 2.07s — NOT a regression.
- Risk: low — pure consolidation of byte-identical duplicated helpers into a shared sibling, both consumers import them back; behavior-preserving; +5-describe test pins the moved behavior at its new home; no new dep / no lockfile change / no public API change (all symbols were file-private, stay import-private).
