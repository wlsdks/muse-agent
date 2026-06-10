# Muse dev backlog — the living ledger

> The ONE compounding artifact the dev loop reads FIRST. Resurrected after the
> docs reset deleted it (which forced every session to re-discover "what to build"
> with expensive scout subagents and throw the answer away). The `improve-muse`
> skill picks the top OPEN item here when `self-eval` is green; every fire appends
> the chosen slice + the candidates it rejected + the source, so a direction is
> researched ONCE, not re-paid each session. Keep it pruned: move shipped items to
> DONE, drop dead ones. This file is the antidote to the treadmill.
>
> Priority: ★ = do next · ◦ = ready · ⏳ = blocked (reason noted).
> Each item: **what** — why (source) — the smallest verifiable slice.

## Open — refilled 2026-06-09 (gap-finding scout, clean autonomous slices)

## Open — grounding edge (the maintained floor → frontier)

- ◦ **(follow-up) SQuAD drift arm — STABILIZE before optimizing** — a fire (2026-06-09)
  TRIED the obvious sharpen (pick drift answers with NO lexical overlap so coverage fully
  fails) and it made Δ WORSE: +0.63 → +0.13 (gate-ON catch 5/8 → 1/8). Reverted. The real
  finding: the SQuAD drift catch is HIGH-VARIANCE — the gate-ON path runs verifyGroundingWithReverify
  (a stochastic gemma reverify), so a single-run Δ on 8 cases is not stable, and the lexical-coverage
  hypothesis does not dominate the catch. So the right next step is STABILITY first: run the SQuAD
  arm at MUSE_EVAL_REPEAT≥3 (pass^k) and/or grow to 20-30 cases to get a stable number, THEN optimize.
  (Rejected: the disjoint-drift sharpen, as an unverified — in fact negative — win.)
- ⏳ **Source-trust segregation — NEEDS JINAN'S DESIGN CALL** (architectural fork; an autonomous
  fire should not pick it). The decision: merge tool-output INTO the grounding set with `trusted:false`
  (touches the core recall/gate path) vs mark trust on the VerifiedSource/response-filters path where
  tool-derived citations already live. FOUNDATION SHIPPED (see Done):
  `KnowledgeMatch.trusted` provenance bit + the pure detector `groundedOnUntrustedOnly` (flags a
  grounded answer resting ONLY on untrusted sources), agent-core, 4 tests. REMAINING — RE-SCOPED
  2026-06-09 (a fire found the naive wiring target wrong): tool-output does NOT become a
  `KnowledgeMatch` — it produces `VerifiedSource` (tool-output-evidence.ts) consumed by the
  response-filters path, SEPARATE from the grounding evidence set (`KnowledgeMatch` today comes only
  from the user's own notes, i.e. always trusted). So `groundedOnUntrustedOnly` has no untrusted input
  in the CURRENT graph — it is a forward-looking guard. Correct sub-slices: (1) DECIDE the design —
  merge tool-output INTO the grounding set with `trusted:false` (architectural), OR mark trust on the
  VerifiedSource/response-filters path where tool-derived citations actually live; (2) surface a marker
  when a cited claim rests only on untrusted provenance; (3) a live battery. Start with (1)'s decision.
  Below is the original framing (kept for context):
  NAMED (see Done: grounded-not-true.test.ts locks that a false-but-source-supported answer
  is "grounded", while a fabricated citation is still caught). The user's OWN false note is
  unfixable by design ("it's yours"), but an UNTRUSTED source (hostile/allowlisted MCP
  tool-output, per architecture.md) being treated as ground-truth IS fixable. Slice: tag
  evidence provenance (user-note vs tool-output) through the recall→gate path and surface a
  distinct verdict/marker when a grounded answer rests ONLY on untrusted tool-output, so the
  user knows the citation is not their own data. Source-veracity is impossible on a fixed 12B;
  source-TRUST segregation is not. (tool-output-evidence.ts already treats tool output as
  untrusted — thread that signal into verifyGrounding's evidence set.)
- ◦ **(follow-up) measure --best-of's answered-rate lift on a drift-prone corpus** —
  the mechanism shipped (see Done 2026-06-10) but its LIVE adoption path never fired in 3
  adversarial attempts (gemma4 + the gate are robust enough that a natural first-draft
  verdict failure is rare on a clean corpus — itself a positive finding). When labeled
  `ungrounded` traces accumulate from real usage, replay those queries with --best-of 3
  and report the adoption rate; promote the flag to default-on only with that number.

## Open — dev-loop fuel & measurement (makes the loop compound)

- ◦ **(follow-up) outcome labels for the remaining cli.local surfaces** — `muse ask` now
  labels every trace (see Done 2026-06-10); still `grounded:null`: ask `--json` mode and
  `--image` (the verdict doesn't run there by design), and `muse chat --local` (the chat
  gate is the sync NUMBER-only check, a different verdict shape). Label chat-local when
  the error-analysis fuel from ask proves insufficient — don't build ahead of need.
- ⏳ **`error-analysis.mjs` — cluster `.muse/runs` failures into a ranked taxonomy**
  — the missing ANALYZE half. BLOCKED on the instrumentation above (no labels = no
  Pareto; clustering a passing-looking corpus with the same 8B is maker=judge theater).
  Defer until ~20-30 real labeled failures exist. Source: eval-driven-dev research
  (Husain/Yan; Google "every user report → permanent test case").
- ◦ **Split the eval scoreboard into TRAJECTORY vs FINAL-RESPONSE axes** (Google ADK:
  EXACT/IN_ORDER/ANY_ORDER match modes + separate final-response score) so a regression
  localizes to path-vs-answer. Pure refactor of `scripts/eval-harness.mjs`.
- ◦ **`hallucinations_v1`-style per-sentence groundedness** — finer than the answer-level
  gate: label each sentence supported/unsupported/contradictory so eval:self-improving
  reports WHICH sentence was un-groundable. Source: Google ADK eval criteria.

## Open — dev-loop hardening (from the 2026-06-08 will-it-work review)

- ◦ **Extend `groundedCases` to ALL battery corpora** — the `groundedCases` ratchet
  SHIPPED for the grounding corpus (see Done: a dropped case there now fails self-eval).
  Remaining: extend the count to the other golden sets (eval:tools, adversarial, plan-quality)
  whose cases live in their own files, so a dropped case in ANY battery regresses. Source: must-fix #3.
- ◦ **Backlog refill is the autonomy ceiling** — write-back records the provenance of
  the consumed item but does NOT mint net-new actionable work, so autonomy lasts ~the
  seed length (~7 fires) then degrades to gap-scout. The durable refill is error-analysis,
  which is BLOCKED on trace outcome-logging (the fuel accrues from Jinan USING Muse, not
  from dev fires). Not a single slice — a standing truth: when ★ OPEN runs low, a refill
  fire (gap-scout or a human direction) is itself the work. Source: review honest-ceiling.

## Open — agent core

- ◦ **Type + validate the multi-agent worker handoff (fail-close) + a live orchestration
  eval** — handoff is untyped free-text today (multi-agent/index.ts:593); SupervisorAgent
  is unit-tested only. MAST: untyped handoff is the dominant multi-agent bug class.
  Lower priority — secondary surface for a single-user agent.

## Blocked / deferred

- ⏳ **Grammar-constrained tool-call decoding** — INFEASIBLE on Ollama today: `format`
  (schema→grammar) and `tools` are NOT composable (Ollama #6002). Revisit when #6002
  lands or accept an inference-stack change. Existing `groundToolArguments` already
  covers the fabricated-value class.

## Rejected directions (do NOT re-derive these)

- ✗ **Chase general agentic leaderboards (SWE-bench Verified / τ²-bench / BFCL) as the
  "best" claim.** A fixed ~12B local model loses by construction (best open-weight
  SWE-bench ~80% on 200B+ MoE; BFCL 8-14B ~66% vs ~88% frontier). Own the architectural
  grounding-DELTA niche instead — the one claim a bigger model can't beat by swapping in.
  (2026-06-08 review, 3 adversarial critics concurred.)
- ✗ **Build the error-analysis analyzer before instrumenting outcome-logging.** No fuel
  (labels) exists yet; building the pipeline first is infrastructure for a flywheel with
  no gas. Instrument first (above), analyze later.

## Done (recent — newest first)

- ✓ 2026-06-10 **Best-of-N recall shipped — the gate is now a SELECTOR, not just a filter**
  (`muse ask --best-of <n>`, 2-5): when the first draft fails the grounding verdict, redraw n-1
  fresh drafts, `selectBestGroundedDraft` (agent-core, deterministic rubric-sum ranking, "weak"
  never accepted, TDD 5/5) picks the best grounded survivor, and the FULL reverify-backed gate
  confirms it before it replaces the answer — fail-close, so resampling can only raise the
  answered rate at the same fabrication=0. Orchestration extracted as `drawBestGroundedRedraft`
  (4/4 unit, composed with the REAL selector). Gates: pnpm check all-workspace green, lint 0/0,
  precheck:grounding pass^3 3/3, eval:grounding-delta Δ+0.94 unchanged, live happy-path ×4.
  HONEST LIMIT: the live adoption path (🎯) never fired in 3 adversarial forcing attempts —
  measured follow-up recorded above. Source: backlog ◦ (arXiv 2504.04718 — small models can't
  self-verify; Muse's owned verifier selects instead).
- ✓ 2026-06-10 **Trace outcome-logging COMPLETE for `muse ask` — cli.local traces carry real labels**
  (the standing ★ PREREQUISITE): the ask path now writes a run-log trace per answered run with the
  top-level `grounded` label the run already computed — `abstain` (refusal), `grounded`/`ungrounded`
  (rubric verdict), `null` only where the verdict doesn't run (`--json`/`--image`). Pure
  `askOutcomeLabel` (TDD, 3/3) + writeRunLog wiring before the output split; full CLI suite 210
  files/2426 green; LIVE both polarities on gemma4 (혈액형→abstain, notes question→grounded, source
  receipt shown). Error-analysis fuel now accrues from real usage; the analyzer stays deferred until
  ~20-30 labeled failures exist.
- ✓ 2026-06-10 **improve-muse restructured: finder/recommender, not full build loop** — a real
  invocation ended with "할 게 없다" (the ★ refill had all shipped; remaining = 1 medium-risk ★ +
  2 ⏳-on-Jinan), exactly the autonomy-ceiling failure dev-loop.md §5 predicted. Per Jinan's direction
  the skill now runs ORIENT+FIND only and MUST end with a ranked recommendation ("nothing to do" is a
  forbidden output — empty backlog ⇒ the refill scout IS the candidate; blocked item ⇒ the surfaced
  decision IS the recommendation). BUILD→COMMIT stays in dev-loop.md §3 after the pick. GREEN-verified:
  a fresh subagent following the new skill against the same repo state produced 3 ranked candidates +
  the source-trust ⏳ as an A/B question + a clear 내 추천, no build, no "nothing to do".

- ✓ 2026-06-09 **pre-push hook fix** — the hook ran `exec pnpm` and blocked the push with
  "pnpm: not found" from a GUI/IDE git client (which spawns hooks with a minimal PATH where an
  nvm/corepack-installed pnpm is absent). Now resolves pnpm (with common-path fallback) and SKIPs
  (exit 0) if still unfound — fail-open on a broken hook environment, never block a push because the
  tripwire couldn't start. LESSON: a pre-push convenience hook must degrade to skip, not block.
- ✓ 2026-06-09 eleventh `improve-muse` fire (20-min loop) — **`noWrite` over-invocation scorer**:
  `toolScorers.noWrite(writeToolNames)` in eval-harness.mjs — reads allowed, any write/execute
  (actuator) tool fails. The IrrelAcc primitive `noTool` couldn't express ("report yesterday" may
  call a recall read but must never fire calendar_add). 14/14. The refill's 3 ★ are now all shipped.
- ✓ 2026-06-09 tenth `improve-muse` fire (20-min loop) — **groundToolArguments substring-hardening**:
  isGrounded now matches a value token at a WORD START (prefix), not as a raw substring — so a fabricated
  "art" is no longer grounded by "start the meeting", while morphology (meeting→meetings) and Korean
  particle attachment (강남역→강남역에서) still ground. Strengthens the deterministic anti-fabrication edge
  at the tool boundary. unit 12/12; live eval:tool-arg-grounding 2/2 (강남역 kept, fabrication dropped).
- ✓ 2026-06-09 ninth `improve-muse` fire (20-min loop) — **REFILL + outbound-safety guard test**:
  the clean backlog had drained, so FIND WORK (c) ran a gap-finding scout → 3 fresh clean ★ slices
  added (contacts negative-invariant, groundToolArguments substring-hardening, noWrite scorer). Then
  built the top one: resolve-contact.test.ts now pins that relationship/about/connections NEVER resolve
  a recipient (outbound-safety rule 3) — 7/7. The loop un-stuck itself via the prescribed refill.
- ✓ 2026-06-09 eighth `improve-muse` fire (20-min loop) — **NEGATIVE result, recorded**: tried the
  disjoint-drift sharpen on the SQuAD arm; it dropped Δ +0.63→+0.13 (catch 5/8→1/8), so verify-before-claim
  REVERTED it. Real finding: the SQuAD drift catch is high-variance (stochastic gemma reverify) — the
  single-run +0.63 is not stable; stabilize with pass^k before optimizing. A failed experiment caught and
  recorded, not shipped — the discipline working on a metric regression.
- ✓ 2026-06-09 seventh `improve-muse` fire (20-min loop) — **trace outcome-label schema**:
  writeRunLog now lifts `success`/`grounded` to the TOP LEVEL of every `.muse/runs` trace
  (readResponseSuccess/readResponseGrounded), so error-analysis can grep outcomes without
  descending into `response`. Additive (no existing test broke; 17/17). Foundation for the
  data flywheel; populating cli.local's `grounded` (medium-risk ask-path change) is the next sub-slice.
- ✓ 2026-06-09 sixth `improve-muse` fire (20-min loop) — **`groundedCases` ratchet**: self-eval
  now also counts the grounding-corpus CASES (29), so a dropped case fails self-eval, not just a
  dropped battery file (must-fix #3, for the grounding corpus). unit 9/9. Same fire surfaced the
  human-decision ceiling: source-trust → ⏳ (architectural fork, needs Jinan), trace-logging scoped
  (medium-risk persisted path). The loop is reaching the seed-drain / refill point honestly.
- ✓ 2026-06-09 fifth `improve-muse` fire (20-min loop) — **pick-evals matches grounding TEST
  files** (regex `grounded` added → `grounded-not-true.test.ts` now maps to the grounding
  batteries, not lint-only). Same fire RE-SCOPED the source-trust ★: a graph trace found
  tool-output produces `VerifiedSource` (response-filters path), SEPARATE from the grounding
  `KnowledgeMatch` set — so the wiring target was wrong; corrected before code was wasted.
- ✓ 2026-06-08 fourth `improve-muse` fire (first 20-min-loop iteration) — **source-trust
  FOUNDATION**: `KnowledgeMatch.trusted` provenance bit + pure `groundedOnUntrustedOnly`
  detector (additive — verifyGrounding/the gate untouched), agent-core, 7/7 tests. Live
  gate unchanged (eval:grounding-delta still Δ+0.94). The grounded≠true mitigation now has
  a foundation; wiring it through tool-output-evidence → recall → answer-marker is the next ★.
- ✓ 2026-06-08 third `improve-muse` fire — **grounded≠true boundary NAMED**:
  `packages/agent-core/src/grounded-not-true.test.ts` (3 cases, deterministic) locks that the
  gate marks a false-but-source-supported answer "grounded" (faithfulness is to the source,
  not truth) while STILL catching a fabricated citation (integrity protected). The biggest open
  hole is now a tracked, named property; the actionable mitigation (source-trust segregation)
  is the new top ★. testFiles 847→848.
- ✓ 2026-06-08 second `improve-muse` fire — **public-dataset grounding-delta arm SHIPPED**:
  `buildSquadGroundingCorpus` maps a pinned SQuAD-2.0 slice (8 paras, no model-generation —
  templated answers) → `eval:grounding-delta:squad` writes `docs/benchmarks/RESULTS-squad.md`.
  LIVE Δ+0.63 (gate ON 0.63 vs OFF 0.00) on gemma4 — the first EXTERNALLY-anchored architectural
  delta. unit 10/10; self-authored arm still Δ+0.94 (no regression).
- ✓ 2026-06-08 first real `improve-muse` fire: BUILD's verify-before-claim caught that the
  top item's "SQuAD-unanswerable→refuse" mapping yields Δ≈0 (refuse=retrieval-confidence;
  SQuAD-unanswerable is adversarially similar → stays confident). Re-scoped the item to the
  drift/answer-grounding path with templated answers, before any fixture work was wasted.
- ✓ 2026-06-08 `feat/grounding-ci-gate`: fabrication=0 grounded-surface ratchet (self-eval)
  · live pre-push grounding tripwire (`precheck:grounding`) · grounding-delta benchmark
  (`eval:grounding-delta`, Δ+0.94 gate ON vs OFF on gemma4) · self-eval ENOENT fix.
