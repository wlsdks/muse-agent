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
