# Agent research findings vs. Muse — 2026-07-13

Paper-grounded survey (two research passes: prompt-engineering techniques +
LLM-as-agent pitfalls), cross-referenced against what Muse already encodes.
Companion to `agent-principles-2026.md` (vendor guidance) and
`.claude/rules/agent-testing.md` (the method). Every row cites a real arXiv id.

## What the papers CONFIRM Muse already bet on (keep doing it)

| Finding (paper) | Muse's existing form |
|---|---|
| Prompt-injection defenses at chance: adaptive attacks 96.7% success, defense classifiers AUROC 0.43–0.59, safety-training can WORSEN it (2605.17634) | The whole "security is deterministic code, never prompt instruction" non-negotiable; the egress gate + citation gate + injection-provenance are code, not prompts. This paper is the strongest external validation of Muse's core security thesis. |
| Bare reflection repeats the error ~85% without an external verifier (2510.18254) | The reflection-schedule guard (`agent-testing.md`) — every retry/reflection surface must be backed by a deterministic/judge verifier. Already pinned. |
| Tool over-invocation: some local models fire an unneeded tool 77–98% of the time on no-tool control tasks (ToolFailBench 2607.04686) | The casual-prompt detector + `eval:tools` IrrelAcc negative cases (zero-tool is the right answer). Already a first-class gate. |
| Long CoT HURTS small-model tool-calling: 32 tokens optimal, 256 tokens drops function-selection accuracy back below no-CoT; long CoT hallucinates new tools (2604.02155) | Muse keeps reasoning/thinking OFF on the local model (`tool-calling.md` rule 6). The paper validates "off" over "long" — but also opens a question (below). |
| Compounding error: τ-bench 3-step ≈ 90% → 8+-step ≈ 43%; pass^k degrades across trials (2406.12045) | pass^k with `MUSE_EVAL_REPEAT`; "keep the first tool call correct", one-tool-per-turn, short chains. Already the design posture. |
| Uncertainty/abstention with formal guarantees (KnowNo 2307.01928) | RGV recall gate uses the conformal-calibrated `MUSE_GROUNDING_MIN_COSINE`; "I'm not sure" degradation. Already wired. |
| Lost-in-the-Middle U-shape (2307.03172) | Within-block `reorderForLongContext` + cross-block `edgePlaceByPriority` + the ask-route parity fix (this session). |

## What is NEW and points to concrete Muse work

1. **LLM-judge position bias is WORST on Qwen-class small models — 0.192, flip rate 25–50% (2606.19544).** Muse's `llmJudge` runs a LOCAL, same-family (Qwen/gemma-class) model, and `agent-testing.md` already names "maker == judge" as Muse's honest constraint with `eval:judge` as the compensating meta-eval. But that meta-eval does NOT currently test POSITION bias — swap the order of the two candidates and see if the verdict flips. On the most-biased model class this is a real, measurable hole in every judge-gated battery. → **Slice: add an order-swap invariant to `eval:judge` (same pair, both orders, verdict must be stable) and, if it flips, randomize/average order in `llmJudge`.** Highest-value new finding: it hardens a load-bearing gate on exactly the model class Muse runs.

2. **Reasoning masks sycophancy rather than removing it (2603.16643): CoT cuts sycophancy 36–50% but the model then constructs deceptive justifications.** Muse's identity-core already says "correct the user, don't flatter" — but there is no eval that a *reasoned* wrong-agreement is caught. → **Slice: a sycophancy battery — user asserts a falsehood with confident framing; assert Muse corrects it AND that its stated reason is faithful (not a fabricated justification for agreement).** Ties into the existing faithfulness/misgrounding flywheel.

3. **Brief CoT (8–32 tokens) can IMPROVE tool selection on small models even where long CoT hurts (2604.02155).** Muse runs thinking fully OFF. The paper suggests a *tiny* bounded reasoning window is the optimum, not zero. → **Investigation (measure before believing): an `eval:tools` A/B — thinking-off vs a hard-capped ~16–32-token scratch — on gemma4:12b. If brief beats off on selection+args at equal IrrelAcc, adopt a capped window; if not, the current "off" is vindicated with data. Do NOT change the default on the paper alone.**

4. **Tool-Use Tax: routing pure computation through tools degrades it (GSM8K −14–33%) (2605.00136).** → **Audit: does Muse ever wrap arithmetic/date math in a tool the model must call, vs. computing deterministically in code? The tool-time-field lesson (`startsAt` not `*Iso`) already pushes TZ math into code — confirm no reasoning-shaped task is tool-routed.**

## What to do next — ranked

- **P1 — judge position-bias hardening (#1). ✓ SHIPPED (edabdb948).** runShadowTrial
  dual-order + fail-closed; gemma4:12b empirically flipped on the engineered probe
  and the hardening resolved it to HOLD. Deterministic proof 36/36, live 6/6.
- **P2 — sycophancy+faithfulness battery (#2). ✓ SHIPPED.** eval:adversarial gains
  MUST_CORRECT (confident falsehoods incl. the reasoned-sycophancy bait, EN+KO) +
  MUST_NOT_OVERCORRECT (true/subjective statements). Runs against Muse's REAL
  composed identity prompt. 9 cases STABLE 3/3; no sycophancy gap surfaced — the
  identity-core anti-flattery line holds under adversarial pressure (honest
  negative finding). adversarialCases 26→35.
- **P3 — brief-CoT tool-calling A/B (#3). ✓ MEASURED — thinking-off default confirmed
  (agent-reliability fire 3).** eval:tools gains an opt-in `MUSE_EVAL_BRIEF_COT` arm that
  prepends a bounded (~20-word) reasoning nudge before tool selection; the default
  (flag unset) is BYTE-IDENTICAL to today's thinking-off eval (deterministically proven
  + ④b-verified).
  **Finding (measured 2026-07-14, gemma4:12b, repeat=1): baseline (thinking-off) 374/376
  = 99% vs brief-CoT 373/376 = 99% — NEUTRAL / marginally worse.** The tool-selection
  baseline is already SATURATED at 99%, so there is no headroom for a reasoning nudge to
  help; the ~20-word step marginally hurts (one case). The paper's brief-CoT benefit does
  NOT transfer to gemma4 at this saturation point. **Verdict: thinking-off default
  CONFIRMED with data — P3a (adapter capped-scratch mode) is NOT built (would be dead
  infra).** The measure-first instrument caught this before any production change; the
  opt-in arm stays for re-measuring on a future model swap or a harder golden set.
  (repeat=1 is directional; the conclusion is robust because the baseline is saturated,
  not because of the 1-case delta.)
- **P4 — tool-use-tax audit (#4). ✓ CLEAN (fire 2).** Tool schemas carry no model-precomputed
  args (*Iso/duration/offset/epoch); Muse doesn't route pure computation through tools.

## Sources

Prompt/reasoning: CoT 2201.11903 · zero-shot CoT 2205.11916 · self-consistency
2203.11171 · ToT 2305.10601 · ReAct 2210.03629 · least-to-most 2205.10625 ·
Reflexion 2303.11366 · lost-in-the-middle 2307.03172 · illusions-of-reflection
2510.18254 · brief-CoT 2604.02155 · tool-use-tax 2605.00136 · SLM tool-calling
2512.15943.
Pitfalls: τ-bench 2406.12045 · MAST 2503.13657 · ToolFailBench 2607.04686 ·
context-memory 2603.04814 · LLM-judge reliability 2606.19544 · G-Eval
2303.16634 · judge survey 2411.15594 · injection-always-fails 2605.17634 ·
KnowNo 2307.01928 · RLVR reward-hacking 2604.15149 · sycophancy-under-reasoning
2603.16643.
