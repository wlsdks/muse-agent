# Shared Continuity review preparation

## Header

- **Task:** continuity-review-core
- **Goal:** make CLI, HTTP, and web review the same oldest eligible Continuity delivery, progress, and exact current evidence through one `@muse/attunement` Module.
- **Why:** Pack opening is shared, but review is not. The CLI owns a private first-20 queue and exact-evidence resolver while `/api/attunement/review` returns a separate recent-delivery projection and web can show only stored IDs. This creates semantic drift precisely where outcomes are judged.
- **Stage:** COMPLETE
- **Worker:** Codex

## Architecture decision

Three candidates were inspected:

1. **Deepen Continuity review preparation — selected.** Move eligibility, deterministic ordering, progress, current-link verification, and exact-evidence resolution behind one core Interface. Deleting it would recreate the same rules in CLI and HTTP, so the Module earns depth, leverage, and locality.
2. **Add smarter inference or automatic source binding — rejected now.** It contradicts the manual-only evidence gate and would expand authorship/permission risk without longitudinal proof.
3. **Change outcome schema for matched cohorts — deferred.** Comparable natural returns do need better longitudinal evidence, but no honest code change can manufacture those moments. Do not mutate the existing 21 receipts or claim causal improvement.

The core result contains domain facts only. CLI outcome commands and translated web copy stay surface-local adapters.

## Baseline and falsifiable improvement

- **Before:** `muse thread review` selects the oldest unreviewed delivery among the first 20 and resolves exact current evidence; `/api/attunement/review` has no equivalent queue and web shows only `evidenceRefs` on a newest-first list.
- **After required:** the same seeded state must yield byte-for-byte equivalent canonical domain fields through direct core and HTTP `reviewQueue`. CLI JSON remains backward-compatible by adding only its existing `outcomeCommands` adapter to `next`; removing that adapter must make the remaining CLI projection byte-for-byte equal to core. Web must render the HTTP projection without opening a delivery or recording an outcome.
- **Product claim allowed:** review consistency and evidence visibility improved.
- **Claims forbidden:** smarter inference, automatic linking, proactive delivery, outcome-policy/schema changes, causal adaptation improvement, or new dogfood evidence.

## Acceptance criteria

- [x] `@muse/attunement` exports one read-only Continuity review preparation Interface that owns first-20 eligibility, `openedAt` then id ordering, oldest-unreviewed selection, and progress calculation.
- [x] The Module resolves only a delivery reference that still matches a current user-authored thread link; removed or changed links are `unavailable`, never searched or guessed.
- [x] A missing referenced thread throws the typed `AttunementStoreError` with the corrupt delivery id. Persisted reads reject it before review; CLI reports the error and HTTP maps it to a structured conflict/error response. No surface may return an empty/complete-looking queue.
- [x] The core result contains no CLI command strings, locale text, HTTP reply objects, or React fields.
- [x] CLI JSON/text use the shared result and preserve their existing copy-ready outcome commands through a surface-local adapter without private eligibility/evidence logic. A test removes only `outcomeCommands` and compares the remaining JSON exactly to core.
- [x] `/api/attunement/review` exposes the same shared `reviewQueue` using the canonical local exact resolver. External evidence remains unavailable on web; it is never fetched through an unverified MCP connection.
- [x] Web visibly renders first-20 progress, the oldest pending delivery, exact available artifact title/marker, unavailable evidence, and the existing explicit four-outcome controls.
- [x] Review remains read-only until the user presses an outcome control: fetching core/CLI/API/web review creates no delivery, outcome, policy change, or source mutation.
- [x] Existing recent-delivery, thread, evaluation, reset, Pack-opening, and hidden-next-step behavior remains compatible.
- [x] Public-interface tests cover no deliveries, deterministic tie ordering, first-20 cutoff, missing thread, removed link, available/unavailable evidence, and life/work neutrality.
- [x] Cross-surface contract tests prove direct core = HTTP `reviewQueue` and direct core = CLI JSON domain projection for seeded local states.
- [x] A two-pending-delivery loop records one explicit outcome through a public surface and proves canonical readers advance to the second pending delivery.
- [x] Browser Mode proves the oldest-pending review card, then an explicit outcome interaction advances the visible card to the next pending delivery without framework errors.
- [x] A read-only dogfood check ran the new Module against the real local Attunement file plus canonical local resolver; before/after bytes, SHA-256, and delivery/outcome counts were identical, and the honestly empty queue was recorded.
- [x] No Attunement store schema, outcome enum/reducer, automatic link, proactive send, or first-21 ledger data is changed.
- [x] Focused package/API/CLI/web tests, TS7 graph + web typecheck, changed-file lint, and actual push-scoped hook pass.

## TDD verification loop

1. RED→GREEN: core public Interface selects and resolves one oldest pending delivery.
2. RED→GREEN: removed link/unavailable and typed missing-thread fail-closed edges, including CLI/HTTP error mapping.
3. RED→GREEN: CLI imports core result; existing CLI review contract stays green.
4. RED→GREEN: API returns the shared queue and the API read leaves persisted state byte-identical.
5. RED→GREEN: seed two pending deliveries; one explicit outcome advances core, CLI, HTTP, then rendered web to the same next item.
6. Run the read-only Module on a byte-identical copy of the real local store and compare bytes/counts before and after.
7. Refactor only while green; then run focused regression, TS7, lint, and Browser QA.

## Worker notes

- TDD RED evidence: the new public export was missing; API `reviewQueue` was absent; corrupt-state HTTP returned 500 instead of a structured 409; rendered web had no pending-review card. Browser Mode then exposed an inaccessible outcome button caused by using the wrong Button accessibility prop.
- Focused GREEN evidence: core/Pack 22 tests, HTTP 9 tests, CLI 17 tests, and Chromium Browser Mode 3 tests passed. Root TS7 graph, direct web typecheck, changed-file ESLint, and `git diff --check` passed before final hook execution.
- Cross-surface evidence: HTTP `reviewQueue` equals direct core; CLI JSON with only `outcomeCommands` removed equals direct core; the two-pending HTTP loop and rendered web both advance after an explicit outcome.
- Real-store evidence: `/Users/jinan/.muse/attunement.json` remained byte- and SHA-256-identical with 21 deliveries and 21 outcomes before/after. The canonical result was no pending item and first-20 progress 20/20.
- Browser-plugin evidence: the in-app Browser reported no available browser even after the documented single bootstrap retry. Repo Chromium Browser Mode provided rendered interaction verification; no screenshot claim is made.

## Evaluator verdict

- **PLAN PASS.** Centralizing eligibility, ordering, progress, and exact current-link resolution in `@muse/attunement` is the correct architectural seam. The corrected plan now has one coherent domain projection with an explicit backward-compatible CLI adapter; a typed corrupt-state failure that cannot appear as a complete queue; and both real-store byte-identity dogfood and a repeatable two-pending review→outcome→next-review proof across core, CLI, HTTP, and rendered web. It remains read-only before explicit feedback, preserves current links and local-only resolution, and makes no unsupported adaptation or automation claim.
- **COMPLETION PASS.** The implementation follows the selected deep Module seam and the independently exercised behavior is green: exact current-link resolution, typed corrupt-store handling, core/API/CLI projection equality, read-only API and real-store paths, explicit outcome-to-next advancement, accessible rendered interaction, and the fail-closed pre-push hook all pass. No inference, automatic linking, proactive delivery, schema/reducer, or first-21 ledger change appears in the full tracked/untracked diff. The final public-interface blocker is closed by two independent adversarial cases: equal-timestamp pending deliveries inserted as `[delivery_b, delivery_a]` must select `delivery_a`, while a reverse-insertion 21-delivery fixture separately proves the deterministically ordered first-20 cutoff. The latest focused file passes 8/8; the prior comparator-removal mutation produced RED as expected.
- **Concrete blockers:** none.

## Status log

- 2026-07-17 · Codex · PLAN · baseline drift, selected deepening candidate, forbidden claims, and falsifiable cross-surface acceptance drafted.
- 2026-07-17 · independent evaluator · PLAN · selected Module seam is sound, but cross-surface shape, corrupt-state semantics, and real/repeating loop verification are incomplete; PLAN FAIL.
- 2026-07-17 · Codex · PLAN · separated canonical domain projection from CLI commands, specified typed corrupt-store mappings, and added real-store byte identity plus two-pending outcome-to-next proof.
- 2026-07-17 · independent evaluator · PLAN · corrected projection, corrupt-state, and real/repeating verification contracts are coherent and testable; PLAN PASS.
- 2026-07-17 · Codex · BUILD · shared Module, surface adapters, fail-closed mapping, read-only dogfood, and focused rendered/type/lint verification completed; final hook and independent completion evaluation remain.
- 2026-07-17 · independent evaluator · COMPLETION · focused core/Pack 17, API 9, CLI 17, rendered Browser 3, real-store byte identity, and actual fail-closed hook passed; COMPLETION FAIL only because the tie-order test does not exercise insertion order against the id tiebreak.
- 2026-07-17 · independent evaluator · COMPLETION · explicit `[delivery_b, delivery_a]` tiebreak plus independent reverse-order cutoff are adversarial and 8/8 GREEN; prior comparator-removal mutation was RED; COMPLETION PASS.
