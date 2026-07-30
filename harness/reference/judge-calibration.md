---
title: Judge Calibration (LLM-as-judge)
audience: [developers, AI agents]
purpose: How well the evaluator gets "valid passes, invalid fails" against human labels — measured as TPR/TNR
updated: 2026-06-13
---

# Judge Calibration

> Note: in the Muse project, a more detailed and current version of this topic lives in
> [`../../.claude/rules/verification/agent-testing.md`](../../.claude/rules/verification/agent-testing.md) (meta-evaluation,
> fault-injection drills, calibration evidence) — this file is the harness's portable condensed
> version.

> **Why it is needed (2026 finding):** a typical LLM judge **passes valid outputs well (TPR>96%)
> but is terrible at catching invalid outputs (TNR<25%)** — the "plausible → pass" bias. So the
> judge must be measured against a **human-labeled calibration set** (confusion-matrix inversion,
> Rogan–Gladen). Our harness's strength is exactly this invalid-detection (TNR), so we prove with
> numbers that it is actually high.

> **Caution:** the builds (code snippets) in the calibration set below are only **fixtures
> (workload) that test the evaluator** — not artifacts the harness produces. What is measured is
> "does the evaluator (the harness's verification component) actually catch invalid work", not
> the quality of that code itself.

## Method

1. Keep a small calibration set with ground-truth (PASS/FAIL) labels (a mix of valid and
   **subtly invalid** cases).
2. Give the evaluator role a rubric — "check each acceptance criterion one by one and **actually
   work through the edge cases**; if any is violated, no PASS" — and have it judge each case.
3. Compare against the labels and compute **TPR** (valid→PASS), **TNR** (invalid→FAIL), and
   accuracy.

## Calibration set (labels = human ground truth)

| ID | Acceptance criterion | Build | Label | Trap |
|---|---|---|---|---|
| V1 | Sum of two integers | `return a+b` | PASS | — |
| V2 | Reverse a string · Unicode · empty→empty | `return s[::-1]` | PASS | — |
| I1 | Primality test (exact on 1·9·2) | `return n % 2 != 0` | FAIL | odd≠prime (misjudges 9→T · 2→F · 1→T) |
| I2 | Word count · ignore repeated/leading/trailing spaces · empty→0 | `len(s.split(" "))` | FAIL | split with an argument mass-produces empty tokens |
| I3 | Palindrome · ignore case/spaces | `return s == s[::-1]` | FAIL | normalization missing |
| I4 | List maximum · empty→exception | `return l[0]` | FAIL | first element ≠ maximum |
| V3 | Factorial · 0!=1 · 5!=120 | loop `r*=i` (0→1) | PASS | — |
| V4 | clamp(x,lo,hi) | `max(lo,min(x,hi))` | PASS | — |
| I5 | Leap year (100·400 rules) | `return y % 4 == 0` | FAIL | century rule missing (misjudges 1900→T) |
| I6 | Binary search · return index/-1 | `return x in arr` | FAIL | returns bool (not an index) · linear |
| I7 | Average · empty list→0.0 | `sum(nums)/len(nums)` | FAIL | empty→ZeroDivisionError |
| I8 | slugify · alphanumerics+hyphens only | `lower().replace(' ','-')` | FAIL | special chars not removed ('!' remains) |

## Measurement (2026-05-31, real Claude Code — n=12)

| Metric | Result |
|---|---|
| TPR (valid→PASS) | **4/4 = 100%** |
| TNR (invalid→FAIL) | **8/8 = 100%** |
| Accuracy | **12/12 = 100%** |

Measured the first 6 cases (V1·V2·I1–I4), then added 6 more (V3·V4·I5–I8) — all correct in both
rounds. All 8 invalid cases (prime · spaces · palindrome · maximum · leap year · binary search ·
empty-list division · slugify) were caught as **FAIL**, each time with a concrete counterexample
(1900 misjudged as leap, `x in arr` returns bool, etc.). Even as the invalid sample (TNR
denominator) grew 4→8, 100% held.

The evaluator caught all 4 subtle invalid cases (prime · spaces · palindrome · maximum) as
**FAIL**, and each time named **the violated criterion with concrete evidence** ("misjudges 9 as
True", "split mass-produces empty tokens", etc.). Well above the typical judge's TNR<25% baseline
— the cause is not "plausible → pass" but the rubric that forces **criterion-by-criterion
checking + direct edge verification**.

> **Honest limitation:** this is an n=12 calibration set (8 invalid) — grown from the initial
> n=6, with TNR held at 100%. To tighten the confidence interval, keep adding invalid cases and
> repeat multiple times to also cover non-determinism. This document pins the **method, data, and
> reproduction recipe** (one table row per added case).

## Periodic stress (a battery, not a one-off measurement)

Judge reliability is managed by a **repeated stress battery**, not a single agreement number
(Judge Reliability Harness, 2603.05399). On hard response pairs even strong judges are near
coin-flip (best ~64%, GPT-4o at random level — JudgeBench 2410.12784). So: as the calibration set
grows, keep adding "subtly invalid" cases, and **re-measure this table whenever the harness
prompt or the model changes** — calibration is a subscription, not an asset.

## Reproduction recipe

Give the evaluator role prompt ([role-prompts](../core/role-prompts.md)) the rubric above, have it
judge each (criterion, build) pair in the table, then compare against labels and count TPR/TNR.
The more invalid cases you add, the firmer the TNR estimate. The judge is also managed as a
regression alongside G8–G12 of the [golden-set](golden-set.md).

## Sources

- Hamel Husain — [Using LLM-as-a-Judge](https://hamel.dev/blog/posts/llm-judge/) (calibration against human labels)
- [How to Correctly Report LLM-as-a-Judge Evaluations](https://arxiv.org/pdf/2511.21140) · [futureagi — LLM-as-Judge Best Practices 2026](https://futureagi.com/blog/llm-as-judge-best-practices-2026) (TPR>96%/TNR<25% bias, confusion-matrix inversion · Rogan–Gladen)
- [JudgeBench (2410.12784)](https://arxiv.org/abs/2410.12784) (judges ~random on hard pairs — never trust without meta-evaluation) · [Judge Reliability Harness (2603.05399)](https://arxiv.org/abs/2603.05399) (repeated stress battery)
