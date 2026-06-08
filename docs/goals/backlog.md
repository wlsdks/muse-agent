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

- ★ **Harden `groundToolArguments` against substring false-positives** — `isGrounded`
  (tool-argument-grounding.ts:42) uses raw `haystack.includes(token)`, so a fabricated value token
  "art" is "grounded" by *"start the meeting"*. Change to a token-boundary match for whitespace-delimited
  scripts (reuse contentTokens membership / `\b`), KEEPING substring for CJK (강남역 ⊂ 강남역에서 must
  still pass). Add Latin false-positive cases. Strengthens the anti-fabrication edge
  ([[project_tool_arg_fabrication]]). Verify: `pnpm --filter @muse/agent-core test -t groundToolArguments`
  + build (existing 11 cases incl. Korean particle stay green). Risk: one pure function, fully tested.
- ★ **Add a `noWrite` over-invocation scorer to the eval harness** — `scripts/eval-harness.mjs`
  toolScorers (line ~99) has `noTool` (zero calls) but no scorer for "READ tools OK, NO write/execute
  tool may fire" (a greeting may call knowledge_search but must never call calendar_add/web_action).
  Add `toolScorers.noWrite(writeToolNames)`; pin in eval-harness.test.mjs beside `noTool`. Gives every
  battery the missing IrrelAcc primitive for ACTUATOR over-firing (highest blast radius). Verify:
  `node --test scripts/eval-harness.test.mjs`. Risk: pure additive in the dep-free harness; no battery forced to adopt.

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
- ◦ **Best-of-N recall gated by EXISTING deterministic verifiers** — turn the gate
  from a pass/fail filter into a selector: draw n recall drafts, keep the best-grounded
  survivor (verifyGrounding), else "I'm not sure". Higher answered-rate at SAME
  fabrication=0. Small models can't self-verify (arXiv 2504.04718) but Muse owns
  deterministic verifiers, so this is principled. Flag-gated, safety-critical recall only.

## Open — dev-loop fuel & measurement (makes the loop compound)

- ★ **Trace outcome-logging — POPULATE cli.local `grounded`** — the top-level outcome-label SCHEMA
  shipped (see Done: writeRunLog now lifts `success`/`grounded` to the top of every trace via
  readResponseSuccess/readResponseGrounded; null for cli.local until populated). REMAINING (the
  medium-risk part): thread the `grounded` verdict the local ask path already computes
  (commands-ask.ts ~3413) into the writeRunLog input so cli.local traces carry a real label — THEN
  error-analysis has fuel. PREREQUISITE for any
  error-analysis. Verified 2026-06-08: 1078/1095 `.muse/runs` traces (cli.local) carry
  only {message,response,toolsUsed,runId} — NO success/grounded/errorCode; only the 16
  cli.remote traces do. So failures are not yet machine-readable. Slice: write
  success/grounded/abstain onto each cli.local trace (parity with the remote path), so
  real misses accumulate greppably. THEN — and only then — an analyzer has fuel.
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
