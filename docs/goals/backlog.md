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

## Open — grounding edge (the maintained floor → frontier)

- ◦ **(follow-up) SQuAD drift-path arm — lift Δ above 0.63** — the public-dataset arm
  SHIPPED (see Done), Δ+0.63 on gemma4. 3/8 drift cases slip because the mismatched
  answer shares tokens with the cited paragraph (coverage doesn't fully fail). Sharpen:
  pick drift answers with NO lexical overlap (distinct entities/numbers), or add the
  SQuAD-unanswerable→fabricated-answer drift variant. Smaller, well-specified now.
- ★ **Poisoned-source / grounded≠true battery** — the biggest open hole: the gate
  verifies claim↔SOURCE match, never source VERACITY, so a false note / poisoned
  episode / hostile MCP output is faithfully cited as "grounded". Source: the same
  review's adversarial completeness critic. Slice: a battery injecting 5-10 false
  notes and asserting Muse measures-and-names the gap (does NOT silently launder a
  confident grounded lie). Distinct from prompt-injection (already defended).
- ◦ **Best-of-N recall gated by EXISTING deterministic verifiers** — turn the gate
  from a pass/fail filter into a selector: draw n recall drafts, keep the best-grounded
  survivor (verifyGrounding), else "I'm not sure". Higher answered-rate at SAME
  fabrication=0. Small models can't self-verify (arXiv 2504.04718) but Muse owns
  deterministic verifiers, so this is principled. Flag-gated, safety-critical recall only.

## Open — dev-loop fuel & measurement (makes the loop compound)

- ★ **Trace outcome-logging parity for `cli.local`** — PREREQUISITE for any
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

- ★ **`groundedSurfaces` ratchet should count CASES, not battery FILES** — adding a
  golden case to an EXISTING battery (the most common write-back) leaves the file
  count unchanged, so self-eval's ratchet is blind to a dropped case. Slice: sum the
  case-array lengths across the registered verify-*.mjs / corpus datasets so a removed
  case fails self-eval. Source: will-it-work review must-fix #3.
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
