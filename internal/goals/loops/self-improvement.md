# Loop journal — self-improvement

**Theme:** hermes-style self-improvement machinery — Playbook (strategy memory,
RL-style reward↑/decay) · whetstone (weakness ledger) · Skill authoring ·
Reflection/dreaming · memory consolidation (Mem0-style). Strengthen + PROVE each,
keeping the grounding floor (fabrication=0) intact.

**Autonomy:** Tier1.5 — dedicated branch `loop/self-improvement` in a /tmp
worktree; each fire commits locally and syncs from LOCAL main (rebase) to stay
conflict-free; **every 3 fires FF-merges into LOCAL main** (Jinan's directive). Hard
floor: NO push, NO remote auto-merge, NO force, NO `--no-verify`.

**Cadence:** session cron `0b48bb96`, 20 min. **Stop:** `CronDelete 0b48bb96` or cmux.

**Surfaces & packages:** `@muse/mcp` (playbook/whetstone stores) · `@muse/agent-core`
(reflection, playbook ranking) · `@muse/memory` (consolidation/decay) · `@muse/skills`
(authoring/curate). Live battery: `pnpm eval:self-improving` (LLM merge/preference/pattern
paths) + `pnpm eval:agent` (judge/shadow-trial) when those are touched.

---

## fire 1 · 2026-06-20 · skill v2.0.0 · `1b9d31a7`
meta: value-class=micro-fix · pkg=@muse/mcp · kind=correctness/RL-ranking · verdict=PASS · firesSinceDrill=1
ratchet: testFiles=1057 (tests added to existing file) · fabrication 0 · gates: mcp 35/35 + check (saturation-only timeouts, clean in isolation) + self-eval ok + lint pass

- **What:** Replaced `retainPlaybookEntries` bank-overflow eviction — sorting by raw point-estimate `reward`
  — with sorting by PEVI Wilson-LCB `retentionUtility` (inline-replicated `rankingUtility`). no-tally falls
  back byte-identically via `clampReward(reward)`.
- **Why:** The injection path (`rankingUtility`, Wilson LCB) and the survival ranking disagreed → a
  thin-but-lucky strategy could destructively evict a battle-tested one (PEVI arXiv:2012.15085 edge case c).
  Corrected fix of the item that was rolled back in paper-grounded fire 3 for wrongly replicating
  `effectiveStrategyReward` (shrinkage).
- **Review point:** mcp is deliberately agent-core-independent (its own REWARD_MIN/MAX) → an inline replicate,
  not an import, is the right call. The discriminating test (thin 1/0 reward=5 vs proven 11/9 reward=1, cap=1)
  went RED ("thin" survives) on old → GREEN ("proven" survives) on new. The independent ④b Opus judge
  confirmed the correct function was replicated (util proven −1.58 vs shrinkage +0.43 distinguishes them),
  the arithmetic, and that all 1870 pass.
- **Risk:** Low — deterministic store logic, no public API change, retentionUtility is file-private, the 4
  legacy retain tests are byte-identical. Recency discount is NOT applied (time-free, index tie-break kept —
  matches `rankingUtility`'s nowMs-undefined shape).
- **Sibling audit:** This is the only place doing raw-reward eviction sort (the injection path already uses
  rankingUtility) — clean.

## fire 2 · 2026-06-20 · skill v2.0.0 · `7b22ce7f`
meta: value-class=wiring · pkg=@muse/cli (+@muse/mcp) · kind=whetstone learn→apply / DRY-unify · verdict=PASS · firesSinceDrill=2
ratchet: testFiles=1057→1058 (new chat-weakness-nudge.test.ts) · fabrication 0 · gates: mcp 1872 + cli 2766 + check EXIT=0 ALL packages clean + self-eval ok + lint pass

- **What:** Unified chat's hardcoded repeat-weakness nudge with a shared `askTimeWeaknessNudge` + extracted
  `renderAskTimeNudge` (a single axis-aware KO/EN phrasing). ask becomes a byte-identical refactor; chat is
  replaced with `chatRepeatWeaknessNudge` (read ledger → select → render).
- **Why:** The existing chat nudge only fired on this-turn refusal, used this-turn count, and hardcoded a
  grounding-gap "note added" message → **couldn't hint at source-conflict rebalancing and couldn't suppress
  on mastery**. ask already used the shared helper → this brings chat up to parity and blocks phrasing drift
  between the two surfaces (N1 follow-up).
- **Review point:** The independent ④b Opus judge confirmed via **md5 the byte-identity of ask's 4
  phrasings** + the behavioral delta (ledger-driven phrasing = the same intentional parity as ask) is safe +
  misgrounding exclusion is preserved + the lazy-import invariant + mutation RED reproduced. chat
  runtime-`await import`s @muse/mcp (bun binary), types only via `import type`.
- **Risk:** Low — deterministic, both branches of recordChatWeaknessForTurn unchanged (same side effects),
  fail-close (throw → no nudge). nit: chat doesn't call recordWeaknessResolved on grounded success (ask does)
  → a closed gap keeps nudging until BKT mastery (registered in backlog as a ◦ NEXT item, out of scope ·
  existing shared-ledger property).
- **Sibling audit:** Both point-of-use surfaces (ask/chat) now converge on the shared helper — recap uses a
  separate selectVolatileBeliefs path (unrelated).

## fire 3 · 2026-06-20 · skill v2.0.0 · `b801ab88`
meta: value-class=new-capability · pkg=@muse/memory · kind=consolidation/decay · verdict=PASS · firesSinceDrill=3
ratchet: testFiles=1058 (tests added to existing recall-promotion.test.ts) · fabrication 0 · gates: memory 456 + check EXIT=0 ALL clean + self-eval ok + lint pass

- **What:** Added `importanceHitsFloor` (default 8) to `selectForgettable` — a memory whose lifetime recall
  hits are at or above the floor is excluded from fade candidates even if idle+decayed. AND-combined (only
  removes candidates, cannot make forgetting more aggressive).
- **Why:** fade only looked at the recency-DECAYED score (hits×2^(-age/half)), so a memory recalled
  frequently over its lifetime but idle recently would fade like a barely-used one — ignoring lifetime
  frequency (importance). MemoryBank's (arXiv:2305.10250) frequency-consolidation: frequently-used memories
  harden in strength and resist Ebbinghaus decay.
- **Review point:** The independent ④b Opus judge confirmed **end-to-end wiring** (manual `memory
  consolidate` + daemon tick → consolidationPlan → selectForgettable, all the way to the persistFade
  side-effect) · arithmetic RED-before/GREEN-after (established hits10 score0.19≤0.25 would have faded under
  the old code) · non-circularity (raw hits is new information distinct from the decayed score) · no
  regression (the existing hits8 case is already excluded by the score filter). Diversity: fire1 mcp/RL ·
  fire2 cli/wiring → fire3 memory/consolidation.
- **Risk:** Low — non-destructive (fade is a report), AND-combination is safe, default 8 is a reasoning-set
  value (tuning is a ◦ left unresolved along with the other consolidation constants). Sibling audit:
  selectPromotableMemories already uses minHits+minScore+score-ranking so it doesn't have the "ignores
  lifetime frequency" defect → fade-only is correct (not a half-fix).

## fire 4 · 2026-06-20 · skill v2.0.0 · `9f2f484b`
meta: value-class=wiring · pkg=@muse/cli · kind=whetstone resolve-parity · verdict=PASS · firesSinceDrill=4
ratchet: testFiles=1061→1062 (new chat-weakness-resolve.test.ts) · fabrication 0 · gates: cli 2771 + check EXIT=0 ALL clean + self-eval ok + lint pass · merge-to-main: n/a (fire 4 ≠ ×3; next at fire 6)

- **What:** Wired weakness RESOLVE into chat's grounded-success path — a new pure `isChatGroundedSuccess`
  (matches>0 ∧ axis null) + `chatResolveWeakness` (lazy, best-effort) → `recordWeaknessResolved` (BKT
  mastery). Parity with ask's `recordAskWeaknessResolvedLive`.
- **Why:** ask resolves a weakness on grounded success, stopping the nudge, but chat only recorded and never
  resolved, so a topic that once blocked kept nudging even after later successes. Closes the fire-2 ④b judge
  nit.
- **Review point:** The independent ④b Opus judge confirmed **robustness against false-resolve**
  (refusal/misgrounding/unbacked/no-evidence are all excluded, mutation confirmed the matches guard is
  load-bearing) + faithful and stricter parity with ask (added matches>0 → fewer false positives) +
  record/resolve are mutually exclusive (axis null vs non-null) + the same raw message key + a single BKT
  step doesn't reach 0.95 mastery so it's safe. Diversity: fires=(mcp,RL)·(cli,wiring)·(memory,consolidation)
  ·(cli,wiring) — (cli,wiring) is 2/4, under the threshold (6/8), OK.
- **Risk:** Low — deterministic predicate, ledger-only write (finalResponse unchanged), fail-close (throw →
  no-op). nit (judge): isChatGroundedSuccess's unbackedAction argument is always false at the call site
  (harmless, predicate stays self-contained).
- **Defer note:** validateSkillToolReferences (the original fire-4 candidate) is UNSOUND because Skill has no
  structured tool field, so heuristic extraction false-positives on shell commands/identifiers → rejects
  valid skills. Prerequisite: add a tool-reference convention to the skill contract. The wiring site
  (autoconfigure:850, holds toolRegistry) is ready. Blocker recorded in backlog.

## fire 5 · 2026-06-20 · skill v2.0.0 · `1bde1536`
meta: value-class=micro-fix · pkg=@muse/cli · kind=whetstone doctor-UX · verdict=PASS · firesSinceDrill=5
ratchet: testFiles→1064 (new doctor-weakness-labels.test.ts) · fabrication 0 · gates: cli 2773 + check EXIT=0 ALL clean + self-eval ok + lint pass · merge-to-main: n/a (fire 5 ≠ ×3; next at fire 6)

- **What:** The user-facing `muse doctor --weaknesses` (`formatWeaknesses`) was exposing source-conflict/
  misgrounding as raw keys; resolved by adding friendly labels (2 entries in WEAKNESS_AXIS_LABEL). Closes G1
  RESIDUAL.
- **Why:** Both axes are actually WRITTEN to the ledger but missing from the label map, so the `?? axis`
  fallback let the raw "misgrounding" key leak straight to the user — a self-reporting UX flaw.
- **Review point:** The independent ④b Opus judge PASSED — purely additive (existing labels/fallback
  unchanged), confirmed both axes are real WeaknessAxis members and are WRITTEN, OUTCOME test (renders the
  friendly label, no raw-key leak) + mutation RED verified. Sibling audit: formatDevFixableWeaknesses
  intentionally keeps raw axis since it's dev-facing (not a half-fix, judge agreed).
- **Risk:** Very low — display-only, data/gates unchanged, unrelated to fabrication.
- **Vein signal:** The easy deterministic vein of self-dev is thinning — the remaining high-value items are
  large/blocked (T2-c memory-promotion needs recall-count prerequisite, T3-d self-fork review,
  reflection-dedup corpus tuning). Recommend the next fire target a different (pkg,kind) or decompose one of
  those large items. Diversity: fires=(mcp,RL)·(cli,wiring)·(memory,consolidation)·(cli,wiring)·(cli,
  micro-fix).

## fire 6 · 2026-06-20 · skill v2.0.0 · `8b12d589`
meta: value-class=new-capability · pkg=@muse/memory · kind=consolidation/promote-spacing · verdict=PASS · firesSinceDrill=6
ratchet: testFiles=1064 (tests added to existing recall-promotion.test.ts) · fabrication 0 · gates: memory 473 + check EXIT=0 ALL clean + self-eval ok + lint pass · merge-to-main: fires 4-6 (this fire, ×3)

- **What:** Added an ACT-R spacing guard (`minDistinctAccessDays`, default 2) to `selectPromotableMemories` —
  a record with per-access history must be recalled on ≥2 distinct days to be promoted to an always-on
  persona. Legacy records (no recentAccessMs) are skipped.
- **Why:** The existing promote filter only looked at hits+score, so a single-session burst (5 recalls in one
  day) could pollute the persona without durable evidence. ACT-R spaced learning (Anderson & Schooler 1991):
  massed ≠ durable. The PROMOTE-side sibling of fire-3's fade frequency-floor (completes the pair: fade
  protects the established, promote excludes bursts).
- **Review point:** The independent ④b Opus judge PASSED — no regression (all existing ACT-R test records
  have ≥2 distinct days, NOW=UTC midnight so no off-by-one, mutation confirmed spacedOk is load-bearing) · a
  false-negative is a DEFER, not a permanent block (the judge simulated the personal-recall-hits-store FIFO
  cap=20 edge: a later access restores eligibility) · reaches the default via both callers (daemon tick +
  commands-memory promote) · no expansion/reordering · PromotedMemory shape unchanged.
- **Risk:** Low — only removes burst candidates (non-destructive), the legacy short-circuit is guaranteed. nit
  (judge): a narrow edge with the personal-recall-hits-store cap=20 (1 early day + 20 same-later-day →
  collapses to distinct=1) is itself massed so the weak spacing signal is acceptable.

## fire 7 · 2026-06-20 · skill v2.0.0 · (scout — no code)
meta: value-class=scout · pkg=n/a · kind=exhaustion-assessment · verdict=SCOUT · firesSinceDrill=6
ratchet: testFiles=1064 · fabrication 0 · gates: self-eval ok (no code change) · merge-to-main: n/a (fire 7 ≠ ×3)

- **What:** Zero failure fuel (.muse/runs empty) + judged the easy-deterministic self-dev vein to be
  thinning → third scout, no tokens burned (EXHAUSTION rule), carefully assessed the highest-value large item
  T3-d → **reassessed as MISFIT/STALE** (backlog ⊘).
- **Why (finding):** T3-d "verifyGrounding on proposed memory/skill writes" — (a) SKILL half: skill drafts
  are intentionally generalized, so a faithfulness-judge false-positives on a valid generalization (same
  unsound class as validateSkillToolReferences), and it's already gated by constraint+risk-scan. (b) MEMORY
  half: background-review has no memory-proposal arm at all (only the skill arm + commitments arm, and
  commitments is already draft-first/human-confirmed). The value of the hermes pattern is already
  structurally satisfied in Muse → not a clean win as-written.
- **Review point:** Across 6 fires, of self-dev's 4 surfaces, Playbook (1)·whetstone/cli (2,4,5)·
  memory-consolidation (3,6) were productive but thinning; reflection/dreaming is mature (read the code, few
  clean deterministic slices remain, the rest is corpus-tuning); skill-authoring needs the structured
  tool-field prerequisite. What's left is design-heavy/corpus/blocked.
- **Risk/recommendation:** Ended honestly rather than inventing fake work. Jinan's options: (1) repoint the
  theme (e.g. a different axis like orchestration/recall-quality) (2) allow corpus-tuning slices
  (real-embed-measured reflection-dedup/episodic-threshold) (3) leave the cron as-is and accept a lower hit
  rate. The loop itself is healthy (6 fires PASS · 2 merged · 0 regressions).
- **Lesson:** The easy deterministic vein of the self-improvement theme thins at ~6 fires; "put
  grounding/faithfulness gates on skills" is a recurring misfit (a skill is a generalization, not a grounded
  claim) — distilled here so the next loop avoids the same trap.

## fire 8 · 2026-06-20 · skill v2.0.0 · `b467b9c3`
meta: value-class=new-capability · pkg=@muse/agent-core (+@muse/cli wiring) · kind=research-grounded/self-consistency-write-gate · verdict=PASS · firesSinceDrill=7
ratchet: testFiles=1064 (tests added to existing correction-distiller.test.ts) · fabrication 0 · gates: agent-core 2512 + cli(passes isolated, single check failure=chat-ink-render saturation-timeout 40/40 GREEN isolated) + self-eval ok + lint pass · eval:self-improving=live battery (deterministic core is unit-proven; LOCAL OLLAMA skip≠pass)

- **What (research-grounded, per Jinan's "research our own method"):** `distillConsistentStrategy` — instead
  of drawing ONE generation, draw k=3 drafts and bank the medoid **only when they AGREE** (mean Jaccard
  ≥0.5). An unstable (disagreeing = confabulation-prone) self-improvement write is not made. Wired default-on
  into `distillSessionCorrections`.
- **Why:** The existing distill was a single generation, so even passing the support/verbatim gate could be a
  one-off guess. Applied self-consistency (conformal abstention arXiv:2405.01563 + ReasoningBank MaTTS
  2509.25140) to the **WRITE path** — extending the fabrication=0 floor from read→learning-write (our own
  application; selfConsistency had 0 hits).
- **Review point:** The independent ④b Opus judge PASSED — measured end-to-end gating (reject→
  recordPlaybookStrategy skipped), measured false-reject risk (same prompt at T=0.3, a true paraphrase ≈0.78
  admits vs a divergent one ≈0.0 rejects; a drop costs zero permanently since it's re-distilled next time and
  reward-decay still fires), majority/medoid/agreement math correct, acyclic
  (playbook↛correction-distiller), genuine mutation (disabling the floor → reject case goes RED). Diversity:
  agent-core/research-grounded (a different pkg+kind from the previous 6 fires).
- **Risk:** Low — only blocks unstable writes (non-destructive), k=1 disables it for back-compat, the offline
  distill path makes the 3× model-call cost acceptable. nit→backlog ◦: measure the 0.5 floor's false-reject
  rate from rejected-agreement telemetry and tune it.
- **Lesson:** When the easy backlog vein dries up, don't stop — build from research-grounded (open arXiv +
  our own application) new mechanisms. Fire 7's EXHAUSTION-close was premature; the research path was the
  right call (Jinan's feedback [[feedback-self-improvement-loop-autonomy]]).

## fire 9 · 2026-06-20 · skill v2.0.0 · (reconcile + merge)
meta: value-class=infra · pkg=n/a · kind=divergence-reconcile+merge · verdict=MERGE · firesSinceDrill=8
ratchet: testFiles ↑ · fabrication 0 · gates: check EXIT=0 (agent-core 2515 · cli 2780 · memory 473, 0 timeouts)

- **What:** A concurrent loop had forked LOCAL main (my fire-6 FF got pushed off, fires 4-8 fell off main) →
  reconciled the branch onto current main (f3b33736). Rebase kept hitting repeated docs (INDEX) conflicts, so
  took the cleaner path: `reset --hard main` + cherry-picked the 4 feat commits (the code files don't overlap
  with main's changeset = no conflicts) + re-verified check (all green) + reapplied docs. Landed fires 4-8
  back on main.
- **Why:** The Tier1.5 3-fire merge point (fire 9, ×3). Concurrent loops merging into the same LOCAL main and
  pushing each other's FF off is a known hazard — my work was safe on the branch, and cherry-pick relanded it
  with zero loss.
- **Review point:** After cherry-picking, `pnpm check` EXIT=0 (confirms semantic integration —
  correction-distiller still works even importing knowledge-recall as changed by main). No code conflicts,
  deterministic.
- **Lesson:** When multiple loops share a LOCAL main and FF gets pushed off, reset+cherry-pick (when the code
  doesn't overlap) is faster and safer than repeated rebase conflicts; the branch is always the
  source-of-truth. Re-verifying check on the cherry-picked code before merging is mandatory.

## fire 10 · 2026-06-20 · skill v2.0.0 · `af25e7c2` (JUDGE-DRILL)
meta: value-class=new-capability · pkg=@muse/agent-core · kind=judge-drill+telemetry · verdict=PASS · firesSinceDrill=0 (drill done, reset)
ratchet: testFiles=1065 · fabrication 0 · gates: agent-core 2515 + check(single model timeout=saturation, 325 GREEN isolated) + self-eval ok + lint pass

- **What (JUDGE-DRILL, triggered by firesSinceDrill≥10):** Deliberately injected an INERT slice — declared an
  `onReject` option + documented "fires on reject" but **never called it in the body** + a config-only test
  (only confirms the option is accepted without throwing). The independent ④b Opus judge **FAILED it**
  (named the dead option · the OUTCOME-less test · the undelivered value, with file:line, and proposed the
  correct minimal fix) → proved the verifier works → forward-fix applied.
- **Why:** maker≠judge compensating control (a fixed ceiling means the drill is the only compensating control
  when the judge is the same model) — periodically prove the verifier actually catches inert/declared-only
  work. The material was a fire-8 telemetry follow-up (exposing rejected-agreement), so the drill also left
  real value behind.
- **Review point:** The real fix = fire `options.onReject?.(agreement)` only on the disagreement-reject path
  (read-only, gating decision unchanged). Added a spy OUTCOME test (called once with agreement<0.5 on reject,
  not called on admit) + mutation RED→GREEN. A second ④b judge pass confirmed the fire location, read-only
  nature, exclusion on early-reject/admit, and mutation-sensitivity.
- **Risk:** Very low — an optional synchronous callback, return value/gate unchanged. ◦ NEXT: wire a
  production sink (caller counts/logs via onReject).
- **Lesson:** The ④b adaptive judge reliably FAILs inert ("declared but never invoked") work → maker≠judge
  compensating control is healthy. Don't defer the drill (firesSinceDrill≥10 hard counter). Using a real
  backlog follow-up as inert-then-real drill material secures both verification and value at once.

## fire 11 · 2026-06-21 · skill v2.0.0 · `c9e7fe4b`
meta: value-class=new-capability · pkg=@muse/mcp · kind=research-grounded/reflection-retention · verdict=PASS · firesSinceDrill=1
ratchet: testFiles=1065 (tests added to existing reflections-store.test.ts) · fabrication 0 · gates: mcp 1879 + check EXIT=0 (0 timeouts) + self-eval ok + lint pass

- **What (research-grounded, an untouched reflection surface):** Replaced the reflection store's cap-overflow
  eviction from **pure recency → recency+salience weighted**. `scoreReflectionRetention` (0.5^(age/30d) +
  min(1,support/5)) + `selectRetainedReflections`. First use of the already-stored `supportCount` for
  retention.
- **Why:** `writeReflections` looked only at recency, so a high-support recurring insight grounded across
  multiple episodes could be evicted before a one-off new one — Generative Agents (arXiv:2304.03442)
  retention=recency+importance. The memory store has ACT-R/Ebbinghaus but the reflection store had neither —
  this gap.
- **Review point:** The independent ④b Opus judge PASSED — no legacy regression (equal support→salience
  constant→reduces to recency, the existing 1970-epoch cap test's tie is broken identically by createdAtMs,
  confirmed calculation+mutation-isolated) · balance is sound (defensible saturation+weight, guards against
  NaN/negative/huge support) · safe in degenerate cases. Diversity: fires 8/10 were agent-core, fire11 is
  @muse/mcp (different pkg). research-grounded kind.
- **Risk:** Low — legacy-identical when support is equal, dedup/atomic-write unchanged, unrelated to
  fabrication (only decides which grounded insight survives the cap). nit→backlog ◦: listReflections display
  order is still newest-first (retention≠display; but strictly better than before, since evicted items were
  never visible at all).

## fire 12 · 2026-06-21 · skill v2.0.0 · `66d153e4`
meta: value-class=wiring · pkg=@muse/cli · kind=telemetry-consumption · verdict=PASS · firesSinceDrill=2
ratchet: testFiles=1065 · fabrication 0 · gates: agent-core 2516 + cli 2781 + check EXIT=0 (0 timeouts) + self-eval ok + lint pass · merge-to-main: fires 10-12 (this fire, ×3)

- **What:** **Consumed** fire-10's `onReject` telemetry seam in production — `distillSessionCorrections` now
  counts low-consistency (disagreement) rejects and exposes them as `DistillResult.lowConsistencyRejected`.
  Previously there was only the seam, no consumer (inert seam → actually consumed now).
- **Why:** To tune the self-consistency gate's 0.5 floor false-reject rate, it needs to be observable from
  real sessions (fire-8/10 follow-up). Read-only (gating decision · banking · decay/reinforce unchanged).
- **Review point:** The independent ④b Opus judge PASSED — real consumption (counter exposed · OUTCOME test:
  3 disagreeing same-script drafts→count 1·status skipped·playbook 0) · counts only disagreement-rejects
  (honest semantics) · no regression (identical-stub admit path unchanged · both consumers read-only) · all 6
  returns set the field · mutation (removing +=1 → RED). Diversity: fire11 was mcp, fire12 is cli/wiring.
- **Risk:** Low — read-only telemetry, DistillResult union consistent across both branches + the 4 early
  returns all 0. When there's no embedder, the cross-script support-gate fails closed with an early-reject
  (onReject doesn't fire) — that's correct; the test targets same-script+embed to hit the disagreement path
  precisely.
- **Lesson:** A telemetry seam must be wired to a production consumer or it stays an "inert seam"; distill
  tests must use same-script drafts+embed to hit the disagreement path correctly, because of the cross-script
  support-gate.

## fire 13 · 2026-06-21 · skill v2.0.0 · `e7656eb8`
meta: value-class=micro-fix · pkg=@muse/cli · kind=whetstone doctor-consistency · verdict=PASS · firesSinceDrill=3
ratchet: testFiles=1065 · fabrication 0 · gates: cli 2789 + check(single api messaging-webhooks timeout=backlog#545 known concurrent-load env flake, saturates >20s even isolated, unrelated) + self-eval ok + lint pass

- **What:** `muse doctor --weaknesses`'s `formatWeaknesses` was listing even MASTERED (BKT pKnown≥0.95)
  weaknesses as "weak at"; excluded them with a `!isMasteredWeakness` filter (+ a "· N mastered" note + an
  all-mastered "resolved" line). Consistent with the runtime nudge's mastery suppression.
- **Why:** doctor kept listing repeatedly-resolved (mastered) topics as "weaknesses" → stale and nagging. The
  runtime nudge (selectRemediableWeaknesses) already suppresses via !isMasteredWeakness, but the doctor
  inventory didn't, causing inconsistency (flagged by judge fire-32).
- **Review point:** The independent ④b Opus judge PASSED — OUTCOME (excluded from rendered list · genuine
  mutation) · no-pKnown/low-pKnown remain active (not proven) · non-mutating input (a new array from
  [...].filter) · a re-failure self-corrects via bktUpdate lowering pKnown · sibling
  formatDevFixableWeaknesses is a different axis class, out of scope. Diversity: sibling of fire-5
  (whetstone-doctor) but kind=consistency.
- **Risk:** Very low — display-only, the mastered note is honest (nothing hidden), the legacy empty-ledger
  path is preserved.

## fire 14 · 2026-06-21 · skill v2.0.0 · `fd2a3516`
meta: value-class=new-capability · pkg=@muse/agent-core (+@muse/cli wiring) · kind=research-grounded/episodic-write-novelty · verdict=PASS · firesSinceDrill=4
ratchet: testFiles=1066 (novelty tests in existing episodic-summariser.test.ts) · fabrication 0 · gates: agent-core 2521 + cli 2789(program 236/236) + check(single api messaging-webhooks timeout=backlog#545 env flake, unrelated) + self-eval ok + lint pass

- **What:** Added a write-time NOVELTY gate (`isEpisodeNovelVsRecent`, token Jaccard ≥0.8 vs the 10 most
  recently stored summaries→reject) to `captureEndOfSessionEpisode`. Wired after salience/ownerId, before
  upsert. Embedder-free · fail-open (empty summary/read error→admit) · subtractive.
- **Why:** The existing write gates (outcome-quality·grounding·salience) all judge a session in ISOLATION →
  a weekly-recurring topic gets near-identically re-summarized and stored as yet another near-dup
  `[session:…]` source, diluting recall (read-time consolidateNearDuplicates only cleans up after the fact).
  Mem0 write-side NOOP (arXiv:2504.19413)+SAGE (arXiv:2605.30711).
- **Review point:** The independent ④b Opus judge PASSED — genuinely blocks the outcome (blocked before
  upsert · proven by mutation) · **measured false-drops** (near-dup 1.0/0.75 drop, same-topic-different-
  decision 0.46/short 0.5 admit → 0.8 is conservative) · fully fail-open · the existing truthy-spelling test
  was a recapture within the same session, so my gate correctly skipping it required adapting the isolated
  episodesFile (index-keyed, avoiding case-insensitive FS) to preserve the env-intent (not a weakening) ·
  sibling audit clean (1 production call site). Diversity: agent-core/episodic (a different kind than fires
  8/10's correction).
- **Risk:** Low — subtractive (only refuses to store, unrelated to fabrication), fail-open means no session
  loss. 0.8/10 is a reasoning-set value but safe given the measured false-drop margin.
- **Lesson:** "All the cheap candidates are stale/blocked" isn't vein-exhaustion but a **research-scout
  signal** — per Jinan's correction, keep looking instead of stopping (correcting the fire 7/14 early
  misjudgment). After a run of cheap-scan rejections, go straight to a research scout.

## fire 15 · 2026-06-21 · skill v2.0.0 · `1f86f39c`
meta: value-class=new-capability · pkg=@muse/skills · kind=research-grounded/skill-eviction · verdict=PASS · firesSinceDrill=5
ratchet: testFiles=1067 (eviction tests in existing authored-skill-store.test.ts) · fabrication 0 · gates: skills 66 + agent-core 2521 + cli passed + check(2 api timeouts=box saturation env flake, unrelated) + self-eval ok + lint pass · merge-to-main: fires 13-15 (this fire, ×3)

- **What:** Replaced `AuthoredSkillStore.enforceCap`'s cap-overflow eviction from FIFO-by-authoredAt →
  **utility-aware**. New pure `rankSkillsForEviction` (never-used first, ties broken by LRU) + `hasUsage`;
  enforceCap uses this to pick the evict-set.
- **Why:** The store already records usage (recordUsage→lastUsedAt) but enforceCap ignored it → a defect
  where a frequently-used old skill could be archived before a never-used new one (SkillOps arXiv:2605.13716
  utility-retire; TinyLFU arXiv:1512.00727 value-aware eviction). With no usage, lastActiveAt=authoredAt, so
  it degrades exactly to FIFO (a strict superset).
- **Review point:** The independent ④b Opus judge PASSED — genuine OUTCOME+mutation (end-to-end
  discriminates from FIFO: a USED old alpha survives) · **EXACT no-regression** (all-unused→ascending
  authoredAt=old FIFO, existing cap tests pass) · correct eviction count/name-Set (writeOrPatch enforces
  authored-name uniqueness) · a used skill can never be evicted before a never-used one · non-destructive
  (archive). Diversity: @muse/skills (this loop's first contact with this fresh surface).
- **Risk:** Low — archive (not delete), unrelated to bundled skills (listAuthored only), identical to old
  behavior when there's no usage. nit (judge): hasUsage re-parses metadata.muse separately from lastActiveAt
  (harmless).

## fire 16 · 2026-06-21 · skill v2.0.0 · (scout + DECOMPOSE-ON-DEFER)
meta: value-class=decompose · pkg=@muse/memory(scouted) · kind=verify-before-build/decompose · verdict=SCOUT · firesSinceDrill=6
ratchet: testFiles=1068 · fabrication 0 · gates: self-eval ok (no code) · merge-to-main: n/a (fire 16 ≠ ×3, next at 18)

- **What:** Verified an Opus scout's top pick (memory UPDATE refine-vs-contradict) via verify-before-build →
  **mostly stale at the core**: the contested/volatility signal *already* is refinement-aware via
  `refinementAwareDistinctValueCount` (token-subset — the scout confused the distinctValueCount path with
  collectFactSupersessions). What remains is only factHistory timeline labeling, but dropping the refinement
  outright would lose elaboration history so it's debatable, and the LABEL approach spans >1 fire (memory
  interface+2 store persist+cli renderer). → refused to build a fake/debatable slice; decomposed the two
  genuinely-remaining items into loop-sized ◦ backlog entries (factHistory-kind-labeling a/b ·
  playbook-injected-id-credit a/b/c).
- **Why:** DECOMPOSE-ON-DEFER + verify-before-build. A green gate ≠ correctness — even a genuine scout arXiv
  can hit a seam that's already filled, so code confirmation is mandatory (fire 14 also found stale items).
  Not building was correct (removing the debatable factHistory would be a change the ④b judge would FAIL).
- **Review point:** In maker≠judge spirit, independently code-verified the scout's claim — confirmed via sed
  that refinementAwareDistinctValueCount really does exclude token-subsets. The next fire should start from
  the backlog's decomposed ◦ (factHistory-kind a or playbook-credit a); a fresh-context cron fire is well
  suited.
- **Risk:** None (no code change). Note: main inherited a byte-hygiene RED (`commands-logo.test.ts`, another
  loop's mascot commit) so the full `pnpm check` is RED — unrelated to my fires, that loop's fix to make
  (deliberately untouched: avoiding cross-loop conflict).
- **Lesson:** A paper-scout pick must be code-verified *before building* to confirm the seam isn't already
  partly implemented — arXiv-real ≠ Muse-empty. When a scout claims "signal X updates," grep the *actual
  computation path* of that signal to check it's already handled (distinctValueCount is a separate
  token-subset path, not the supersession-log).

## fire 17 · 2026-06-21 · skill v2.0.0 · `1fd3fb8b`
meta: value-class=new-capability · pkg=@muse/autoconfigure · kind=audit-driven/fabrication-guard sibling-parity · verdict=PASS · firesSinceDrill=7
ratchet: testFiles=1069 · fabrication 0 · gates: autoconfigure 611/611 + check(only failure=inherited commands-logo byte-hygiene from another loop's mascot commit, unrelated; my files byte-clean) + self-eval ok + lint pass · merge-to-main: n/a (fire 17 ≠ ×3, next at 18)

- **What:** Per Jinan's instruction ("find out whether self-improvement is genuinely working and whether the
  mechanism is right"), ran an **EFFICACY AUDIT** (3 parallel Opus, maker≠judge, codegraph/grep-verified),
  then immediately fixed the highest-priority *verified* finding: the self-consistency write gate only
  existed on the sync distiller (off-by-default) and was **missing from the default-on idle/daemon learner**
  (`distillQueuedCorrections`), which had been banking a single draft; wrapped it with
  `distillConsistentStrategy` (k-draw agreement) for sibling-parity (@muse/autoconfigure).
- **Why:** "Declared ≠ working" — the fabrication-guard we built in fires 8/10/12 wasn't actually covering
  the *default autonomous learning path* (a missed sibling-audit). Now both paths refuse to auto-write an
  unstable (=confabulated) distillation.
- **Review point:** Independent ④b Opus PASSED (7/7: outcome-genuine·mutation RED·queue-drain unchanged·no
  regression·invariant·diversity); a cost-honesty nit (k=3× LLM/event) is noted in a header comment.
  **verify-before-build REJECTED audit Finding 2**: Agent A cited a file that doesn't exist
  (`context-engineering-builders.ts:426`) claiming "buildPlaybookProvider drops origin," but the actual CLI
  injection carries origin via `toPlaybookStrategy`, and the runtime playbookProvider isn't even configured
  from the CLI → a fabricated finding.
- **Risk:** Low — only tightens writes (fewer bankings, cannot fabricate), idle writes remain probationary.
  The k× cost is tunable (`strategyConsistencySamples`).
- **Lesson:** An audit sub-agent's file:line citations must always be independently verified — even Opus can
  confidently invent a path that doesn't exist (Finding 2). And "mechanism shipped" ≠ "applied on the default
  path": confirm via grep that a new guard covers every sibling path — sync/idle/ASK/CHAT.
- **AUDIT SUMMARY (answering Jinan's question):** HEALTHY/actually-working = whetstone (weakness ledger
  record→BKT→resolve→nudge, ASK/CHAT parity, mastery suppression) · Mem0 auto-extract+belief-provenance
  (File store, default-on) · Playbook ranking (rankingUtility Wilson-LCB, the old bug hasn't recurred) ·
  skill selection+recordUsage+eviction. INERT/dead by default = episodic capture
  (MUSE_EPISODIC_MEMORY_ENABLED off — the fire-14 novelty gate included, doesn't fire by default) ·
  summary-recall (CLI uses an InMemory store so it's empty every process) · fade/promote (daemon-only+
  MUSE_SELFLEARN_ENABLED off). UNMEASURED (the biggest gap) = there is *no* end-to-end measurement at all of
  "does past experience help the next turn"; every eval only confirms a single-turn mechanism fires, and
  self-eval is a count ratchet (bigger≠better). → registered as backlog ◦.

## fire 18 · 2026-06-21 · skill v2.0.0 · `7b860f8e`
meta: value-class=micro-fix · pkg=@muse/autoconfigure + @muse/recall · kind=correctness/audit-fix · verdict=PASS · firesSinceDrill=8
ratchet: testFiles=1070 · fabrication 0 · gates: recall 366/366 + autoconfigure 612/612 + cli build clean + check(only failure=inherited commands-logo byte-hygiene, another loop, unrelated) + self-eval ok + lint · merge-to-main: fires 16-18 (this fire, ×3)

- **What:** **Re-verified fire-17 audit Finding 2** (`buildPlaybookProvider` drops origin) → **confirmed
  REAL → fixed**. + The ④b judge *found two more sibling sites feeding the same ranker*
  (`selectPlaybookSection`·`topAppliedStrategy` @muse/recall, the default `muse ask` path) → patched all
  three to carry origin (parity with the CLI's `toPlaybookStrategy` sibling). Now every entry→
  PlaybookStrategy projection preserves provenance.
- **Why:** origin is the key that toggles REFLECTED_RANK_PENALTY + the CBR low-support gate → dropping it
  lets a synthesized (reflected) strategy rank equal to a grounded one — "evidence beats synthesis" was
  **dead on both the runtime and default ask paths**. A mechanism we shipped wasn't actually running (a
  direct answer to Jinan's "is the mechanism right" question).
- **Review point:** The independent ④b Opus PASSED (the bug is real·outcome-discriminating: origin decides
  ties, mutation RED·diversity OK) + the judge caught the two sibling sites → *patched together in the same
  fire* (sibling-completeness). Both fixes mutation-verified.
- **Risk:** Low — conditional spread (only when origin exists), the 8 existing fields unchanged, only
  restores the ranking penalty (unrelated to fabrication). The input type widening is back-compat (optional).
- **Lesson (honest correction):** Rejecting Finding 2 as "hallucination" in fire-17 was **my error** — I only
  searched `context-engineering-builders.ts` in @muse/agent-core and missed @muse/autoconfigure. Lesson: even
  when an audit citation appears to be "a file that doesn't exist," confirm with a *whole-repo grep* before
  rejecting (it may just have been searched in the wrong package). And a sibling-audit's grep scope must
  extend to @muse/recall — every package that feeds the selector must be checked (the judge caught my
  omission).

## fire 19 · 2026-06-21 · skill v2.0.0 · `932c3020`
meta: value-class=new-capability · pkg=@muse/memory + @muse/autoconfigure · kind=audit-fix/store-persistence · verdict=PASS · firesSinceDrill=9
ratchet: testFiles=1071 · fabrication 0 · gates: memory 482 + autoconfigure 615 + cli build clean + check(remaining failures=flaky model property-fuzz[16/16 isolated]+1 saturation api timeout, unrelated; byte-hygiene 0=another loop fixed commands-logo) + self-eval ok + lint · merge-to-main: n/a (fire 19 ≠ ×3, next at 21)

- **What:** Fixed audit #3 (the most obviously inert) — the CLI's ConversationSummaryStore is InMemory (no
  DB), so every process starts empty: the runtime save path's summaries were lost, default-on cross-session
  recall was always empty, and fade/promotion had no fuel. Added `FileConversationSummaryStore` (JSON·
  atomic·0o600·ISO date round-trip·missing/corrupt→empty) + made the no-DB factory default File (PERSIST=
  false stays InMemory). Mirrors the FileUserMemoryStore pattern.
- **Why:** "Default-on cross-session memory" was a mirage on the CLI (audit Agent B #1). Now a summary
  written by one session is actually recalled by the next → real cross-session self-improvement + recovered
  consolidation fuel. Direct answer to Jinan's "is self-improvement really working": turns inert into real.
- **Review point:** The independent ④b Opus PASSED — genuine outcome (a fresh instance recalls the previous
  write; InMemory cannot, mutation: disable rename→RED)·dates+nested fact dates round-trip·semantics parity
  with InMemory·robust (missing/corrupt→empty, atomic)·safe factory flip (the API server's db→Kysely
  unchanged, store-factories test updates reflect the contract change). Diversity: @muse/memory (fresh pkg)
  store-backend. Nit fix: use a valid FactCategory (GENERAL) for the test category.
- **Risk:** Low — pure storage backend (creates no claims, unrelated to fabrication), local file no-egress
  (local-by-construction), read-modify-write race is acceptable for a single-user CLI (strictly better than
  the prior every-process loss). Sibling createTaskMemoryStore is recorded in backlog (caught by the judge).
- **Lesson:** Even when a "default-on" flag is on, if the backend is non-persistent (InMemory), the feature
  is dead — when verifying a mechanism, check *not just the flag but whether the store backend survives
  across processes*. A sibling audit should also enumerate other stores from the same factory (taskMemory).

## fire 20 · 2026-06-21 · skill v2.0.0 · (JUDGE-DRILL — no code, verifier proven)
meta: value-class=drill · pkg=@muse/agent-core(drill target) · kind=judge-drill/verifier-proof · verdict=DRILL-PASS · firesSinceDrill=0 (reset)
ratchet: testFiles=1071 (unchanged — drill rolled back) · fabrication 0 · gates: self-eval ok · merge-to-main: n/a (fire 20 ≠ ×3, next at 21)

- **What:** firesSinceDrill=10 triggered a mandatory JUDGE-DRILL. Deliberately injected a bad slice: added a
  `caseSensitive?` option to `isEpisodeNovelVsRecent` that was *declared but its body never read*
  (config-only/declared-unused) + a non-discriminating test that only asserted "the option is accepted"
  (empty recents so the option doesn't matter, always true). Set up a trap where build/tests looked green so
  it would look "passing."
- **Why:** Since Opus is maker=judge under the fixed ceiling, periodically prove the verifier still catches
  bad slices (the JUDGE-DRILL hard counter). If the verifier degrades to rubber-stamping, the whole loop's
  quality gate loses its teeth.
- **Review point:** The independent ④b Opus judge (verifying normally, unaware it was a drill) **correctly
  FAILED it** — named the concrete violation: "caseSensitive is only declared at line 221 · body 222-238
  never reads it; lexicalTokenList is already lowercased at knowledge-recall:109 so case-sensitivity is moot;
  the test asserts both options are true on empty recents = a non-discriminating fake test that stays green
  even if the option is deleted." It even proposed what the correct version should do. → verifier reliability
  proven, immediately `git restore`d (worktree clean).
- **Risk:** None (drill rolled back, no code change). The real fix — File-backing taskMemory (flagged by the
  judge as a sibling) — spans >1 fire due to 3 kinds of nested-dated array serialization+purge maintenance,
  so decomposed into backlog ◦ (recommend a fresh fire, not a post-drill add-on).
- **Lesson:** The JUDGE-DRILL works — a config-only/declared-unused option + a non-discriminating test (same
  result on empty input regardless of the option) is caught by the verifier from a mutation-minded angle
  ("if deleting the option still stays green, it's fake"). Self-check for this same trap pattern (a
  declared-only option, an empty-input assertion) on real slices too.

## fire 21 · 2026-06-21 · skill v2.0.0 · `4926fce8`
meta: value-class=new-capability · pkg=@muse/memory + @muse/autoconfigure · kind=store-persistence/audit-fix-sibling · verdict=PASS · firesSinceDrill=1
ratchet: testFiles=1071 · fabrication 0 · gates: memory 484 + autoconfigure 618 + pnpm check EXIT=0 (model property-fuzz flaky passed this time; byte-hygiene 0) + self-eval ok + lint · merge-to-main: fires 19-21 (this fire, ×3)

- **What:** Completed fire-19's sibling (flagged by ④b) — `createTaskMemoryStore` defaulted to InMemory with
  no DB, so in-progress task state (goal/plan/decisions/blockers) was lost every CLI process; persisted it
  via `FileTaskMemoryStore`. **wrap-delegate-persist** design (file→rehydrate into InMemory [rebuild the
  active-index+retention/trim, normalize preserves the timestamp]→delegate→persist entries()). Nested Dates
  (plan/decisions/blockers + top-level) round-trip via ISO, atomic·0o600·missing/corrupt→empty. The no-DB
  factory now defaults to File (PERSIST=false escape hatch).
- **Why:** The same gap fire-19 fixed for conversation-summary existed for task-memory (caught by the judge
  in fire-19). Now in-progress work survives across sessions = real cross-session self-improvement.
- **Review point:** The independent ④b Opus PASSED — **rebutted the retention-trap concern**
  (normalizeTaskState preserves `updatedAt ?? createdAt ?? now` → rehydrate doesn't reset expiry; the purge
  test proves it directly) · genuine outcome+mutation (a fresh instance recovers via
  findById/findActiveBySession, the 4 nested Dates match exact getTime, disabling rename→RED) · the assembly
  test update is justified (PERSIST=false only verifies wiring · avoids touching the real ~/.muse).
  Diversity: @muse/memory store-persistence (same kind as fire-19, different store).
- **Risk:** Low — pure storage (unrelated to fabrication), local file no-egress, the wrap reuses 100% of the
  InMemory logic (minimal reimplementation). nit (judge, non-blocking): RMW race (acceptable for single-user
  CLI)·write-back on read to persist the expiry-clear.
- **Lesson:** wrap-delegate-persist = a safe pattern for File-backing a complex in-memory store
  (dual-index+retention+trim) — rehydrate→delegate→persist reuses the logic instead of reimplementing it
  (but first confirm normalize preserves the timestamp, or it's a retention-reset bug). All sibling stores
  from the same factory (user/summary/task) now converge on File-default.

## fire 22 · 2026-06-21 · skill v2.0.0 · `6a99f621`
meta: value-class=new-capability · pkg=@muse/autoconfigure (test) · kind=cross-turn-measurement/verification · verdict=PASS · firesSinceDrill=2
ratchet: testFiles=1072 · fabrication 0 · gates: autoconfigure 620/620 isolated (full check SIGTERM on apps/cli = box saturation, 0 AssertionErrors·0 crash-markers; test-only so cli is unaffected) + self-eval ok + lint · merge-to-main: n/a (fire 22 ≠ ×3, next at 24)

- **What:** The **landable half** of audit #1 (the biggest gap: "no end-to-end evidence that self-improvement
  actually helps") — `experience-recall-cross-session.test.ts`: session1 stores an experience in
  FileConversationSummaryStore → session2 (a fresh instance, connected only via the file)
  `StoreBackedEpisodicRecallProvider` (injected stub embed) **actually recalls it**; an empty store/unrelated
  query doesn't recall. Deterministic (no Ollama)·CI-gated.
- **Why:** With fires 19/21 making the stores persistent, the cross-turn mechanism "a prior session's
  experience is recovered in the next session" can now be proven without a model. Under a fixed model,
  self-improvement = experience-indexed retrieval, so a retrieval-level proof is a legitimate measurement
  (asserting on answer-text would be a brittle anti-pattern). A deterministic answer to Jinan's "is
  self-improvement really working" question.
- **Review point:** The independent ④b Opus PASSED — not-a-tautology (the two stores share zero in-memory
  state · connected only via the file, mutation: disabling persistence→genuine RED) · the stub embed is
  discriminating (cosine 0.577 vs 0, minScore 0.1, non-cheating) · honest framing (states clearly this proves
  retrieval, not answer-quality) · no vacuous green (the positive `.some(Dana Kim)` is load-bearing).
  Diversity: cross-cutting verification (fresh kind).
- **Risk:** Low — test-only (src unchanged, unrelated to fabrication/grounding), local file. The LIVE
  answer-quality delta is left in backlog ◦ (smoke:live stalls on this box). nit (judge): pinning
  similarity·userId-isolation case is a next step.
- **Lesson:** When a LIVE eval is blocked by box stalls, proving the *deterministic core* of that measurement
  (here, the persist→retrieve chain) via an injected dependency (embed) without a model still lands and is
  CI-gated — a stronger gate. Bypasses "skip is not pass" deterministically.

## fire 23 · 2026-06-21 · skill v2.0.0 · `602b675b`
meta: value-class=wiring · pkg=@muse/mcp (+@muse/cli) · kind=reflection-store recall-ordering · verdict=PASS · firesSinceDrill=3
ratchet: testFiles=1071 · fabrication 0 · gates: mcp 1884 + cli build clean + check(only failure=1 api timeout saturation, 0 AssertionErrors·0 model-fuzz·0 my-package FAILs) + self-eval ok + lint · merge-to-main: n/a (fire 23 ≠ ×3, next at 24)

- **What:** Closed a follow-up gap from fire-11's retention (salience-aware) — ask-grounding RECALL used
  `listReflections` (newest-first) `.slice(0,5)`, so a retained high-support old insight could get buried
  and never reach the prompt; replaced with sorting by `selectReflectionsForRecall` (reusing
  scoreReflectionRetention=recency+salience). listReflections stays newest-first for `muse reflections`
  display.
- **Why:** A retention≠display gap — retention was salience-aware but surfacing was recency-only, so the
  intent of retention (keeping high-support insights alive) wasn't reflected in the grounding surface.
  Aligning retention and display on the same score closes it. Follows fire-19/21/22 (persistence+proof) with
  reflection-surface alignment.
- **Review point:** The independent ④b Opus PASSED — real outcome (a real value flips: 21d/sup3=1.216 >
  1d/sup1=1.177, mutation: recency-only→RED) · honest about salience-vs-relevance (old also had no
  query-filter in the top-5 so there's no new off-topic risk, the new one aligns with retention · salience
  saturates at +1 so an ancient item can't dominate forever) · sibling-complete (ask is the only recall path;
  commands-brief uses its own supportCount selector·display/synthesis paths are correct). Diversity:
  @muse/mcp reflection (fresh pkg).
- **Risk:** Low — only reorders already-RGV-grounded reflections (unrelated to fabrication), listReflections
  unchanged (no display impact), Date.now() is normal runtime behavior. nit (judge): duplication between
  selectRetained and the sort formula (harmless, kept independently variable).
- **Lesson:** Sibling-audit a mechanism per surface — after fixing RETENTION to be salience-aware, check
  whether the surfaces that *consume* it (RECALL/DISPLAY) use the same signal (retain≠surface). Aligning the
  retention policy and the surfacing policy's signals is the key.

## fire 24 · 2026-06-21 · skill v2.0.0 · `35bd3dd9`
meta: value-class=new-capability · pkg=@muse/skills · kind=skill-authoring dedup (research-grounded) · verdict=PASS · firesSinceDrill=4
ratchet: testFiles=1071 · fabrication 0 · gates: skills 70/70 + cli build clean + check(only failure=model web-search-policy property-fuzz=same flaky as fires 19/21, 16/16 isolated; +1 api timeout saturation; unrelated to skills) + self-eval ok + lint · merge-to-main: fires 22-24 (this fire, ×3)

- **What:** Write-time SUBSUMPTION dedup for skill authoring — `writeOrPatch` only compared name+description
  Jaccard and **never compared bodies**, so a draft with a fresh name but a procedure-body that's a subset of
  an existing skill could be authored as a near-dup (leaving idle-time cleanup cost for the curator); added
  `skillBodyIsSubsumed` (directional containment |draft∩existing|/|draft| ≥0.85) to skip at write time.
- **Why:** Voyager's skill-library novelty gate (arXiv:2305.16291) — gate library additions on novelty.
  Directional, so a richer SUPERSET skill is never suppressed; fail-open (empty body→write allowed);
  non-destructive (skip, no mutation).
- **Review point:** verify-before-build confirmed the seam was empty (writeOrPatch really did ignore body).
  The independent ④b Opus PASSED — real outcome (the test's name+desc Jaccard=0.0 confirms the new body path
  actually ran, mutation: removing the gate→skip test goes RED) · false-skip bounded (only short-tail
  drafts, 0.85 is conservative, recoverable·non-destructive) · sibling-complete (writeOrPatch is the single
  write seam·consolidate is post-hoc). Diversity: @muse/skills authoring-dedup (fire15 was eviction,
  different kind).
- **Risk:** Low — subtractive (only defers a redundant write, unrelated to fabrication), the risk-scan
  quarantine still runs first, no bypass of enforceCap. nit (judge): a low-probability interaction between
  consolidate umbrella writes and subsumption-skip → backlog ◦.
- **Lesson:** A research-scout pick must be code-verified as an empty seam before building (lesson from fires
  14/16 stale picks) — this time the reflection-synthesis "≥2 source" candidate *was already built*
  (DEFAULT_MIN_SUPPORT=2), so the scout correctly rejected that surface and pointed precisely at the empty
  seam (skill body dedup). Symmetric Jaccard match can't express a directional subset relation → containment
  is a distinct signal.

## fire 25 · 2026-06-21 · skill v2.0.0 · `04661584`
meta: value-class=new-capability · pkg=@muse/agent-core (+@muse/cli +@muse/autoconfigure) · kind=proactive cross-session discharge (research-grounded) · verdict=PASS · firesSinceDrill=5
ratchet: testFiles=1074 · fabrication 0 · gates: agent-core 26 + autoconfigure 621 + cli e2e 2 + check(only failure=packages/auth flaky[15/15 isolated]+1 api timeout; unrelated to my packages) + self-eval ok + lint · merge-to-main: n/a (fire 25 ≠ ×3, next at 27)

- **What:** Cross-session auto-discharge for a persisted check-in — `selectDischargedCommitments`
  (discharge-MARKER turn AND cosine ≥ the existing COMMITMENT_DISCHARGE_COSINE) cancels a standing nudge
  when the user says "done, I handled it" in a later session. The in-session filter (selectOpenCommitments)
  only sees one conversation, so it can't see a future-session discharge. Wired at **both** the CLI
  `scanSessionCheckins` and daemon `scanCommitmentsFromTurns` seams.
- **Why:** π-Bench (arXiv:2605.14678) proactivity failure — continuing to nag about something already done.
  No new threshold (reuses the existing 0.55+marker), conservative (marker AND cosine: a missed discharge
  just nags once more, a false-cancel is reversible), fail-soft (embedder error→discharges nothing).
- **Review point:** verify-before-build confirmed the seam was empty (cancelCheckin was manual-only). The
  independent ④b Opus PASSED (mechanism+CLI wiring) + **caught the missing daemon twin as #5** → completed
  the sibling in the same fire. **The end-to-end test caught a real ordering bug** (the daemon twin's
  `raw.length===0` early-return sat before the discharge, so a discharge-only session was missed → moved the
  discharge ahead of the early-return). Mutation: removing the marker filter→the no-marker test goes RED.
  Diversity: @muse/agent-core+cli+autoconfigure proactive (fresh kind).
- **Risk:** Low — nudge-cancel only (unrelated to fabrication/grounding), reversible, fail-soft. cosine
  ignores instance-specificity (judge nit, acceptable since the nudge is reversible).
- **Lesson:** End-to-end test sibling wiring *in the same fire* — the daemon twin's early-return-before-
  discharge bug wasn't catchable by a pure unit test but was caught by an end-to-end one (discharge-only
  session→cancelled). When wiring the same pattern into two seams, verify each seam's *control-flow
  difference* (early-return position) individually.

## fire 26 · 2026-06-21 · skill v2.0.0 · (scout + verify-before-build + ESCALATE)
meta: value-class=scout/escalate · pkg=n/a · kind=exhaustion-signal/escalation · verdict=SCOUT · firesSinceDrill=6
ratchet: testFiles=1072 · fabrication 0 · gates: self-eval ok (no code) · merge-to-main: n/a (fire 26 ≠ ×3, next at 27)

- **What:** Research-scout + verify-before-build rejected/already-done every candidate → signals the clean
  deterministic vein is exhausted + ESCALATEs the remaining high-value item (playbook-credit). (1) The
  scout's top pick, BKT-Forget mastery-decay = **rejected on the merits** (the weakness ledger's mastery =
  Muse's grounding reliability; it must not decay just from being idle → time-decay would be an unfounded
  re-nag; a regression already resurfaces via a new failure; same reasoning as fire 14). (2) The backlog's
  factHistory labeling = **already shipped** (agent-hardening fire 16 `0304823e`, a different loop) — stale.
  (3) playbook injected-id credit = deferred 3× → **DECOMPOSE-ON-DEFER escalate** (high-value but a
  genuinely 3-seam multi-fire item; seam-a alone is config-only so it can't be done incrementally).
- **Why:** After shipping 9 verified slices across fires 17-25, self-improvement's *cheap 1-fire
  deterministic* vein is genuinely exhausted. What remains = playbook-credit (multi-fire)·LIVE
  experience-delta (stalls on the Ollama box). Rather than force a fake/dubious slice, honestly escalating is
  the contract (EXHAUSTION + DECOMPOSE-ON-DEFER).
- **Review point:** verify-before-build caught a stale/dubious pick for the *third* consecutive time (fire 14
  line100, fire 16 distinctValueCount, fire 24 reflection-≥2-source, now factHistory+BKT-Forget) — a scout
  pick needs triple confirmation: arXiv-real ≠ Muse-empty ≠ domain-sound. No code change (refused to build
  the dubious one).
- **Risk:** None (no code change). The escalation was delivered to Jinan via PushNotification.
- **Lesson:** A scout pick needs both (1) seam-empty and (2) domain-sound confirmed — BKT-Forget had an empty
  seam but was domain-unsound (a weakness ledger ≠ a decaying skill). "There's a dead field (lastResolved)" ≠
  "the mechanism is correct." When the cheap vein is exhausted, honestly escalate a high-value multi-fire
  item rather than forcing a marginal/dubious one.
