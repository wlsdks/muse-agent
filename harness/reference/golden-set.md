---
title: Golden Set (representative task bundle)
audience: [developers, AI agents]
purpose: The representative task bundle that grows the harness by measurement — repeatedly grading outcome+path to build reliability
status: draft
updated: 2026-06-13
sources_basis: [harness-acceptance (Data/Task/Scores · 10–20 golden · pass@k/pass^k), real Claude Code measurements]
related: [harness-acceptance.md, ../core/role-prompts.md, ../core/handoff-template.md, architecture.md, ../README.md]
---

# Golden Set

> **Why does this fill the weakness?** The [architecture](architecture.md) self-assessment had
> all 12 slots documented, but measurement was only 4 one-off kinds (small, artificial), so
> **tolerance to non-determinism** was unverified. This bundle is the **fixed task set** for
> actually running [harness-acceptance](harness-acceptance.md)'s "10–20 golden tasks + repeats
> (pass^k)" principle. Each task is written with **verifiable acceptance criteria** so the
> evaluator can grade it directly.

> **Caution — these are fixtures (domain workload), not the harness itself.** Tasks like add,
> reverse, and backoff are only **crash dummies** passing through the harness (loop, gates,
> verification infrastructure) — inputs fed through to confirm "do the gates/evaluator/runner
> actually run correctly". The harness *drives, gates, and verifies* that workload, but the
> workload artifacts themselves (the backoff function, etc.) are not the harness. Even when a
> dummy looks like app code, it is in essence the harness's self-verification set.

## How to use

- Actually run each task through the roles (planner/worker/evaluator) of
  [role-prompts](../core/role-prompts.md), and accumulate results into
  [harness-acceptance §7.5](harness-acceptance.md).
- **Repeat measurement**: run the same task multiple times and record `pass@k` (succeeded at
  least once) and `pass^k` (succeeded every time). For customer-facing reliability, `pass^k` is
  the standard.
- Keep it **separate** from examples used for development/tuning (no contamination). When a new
  failure appears, add that case here (regression pinning).

## Tasks (G1–G14)

Each line: **ID — request — acceptance criteria (verifiable) — trap (what the evaluator must
watch for)**.

- **G1 — Add two numbers** — `add(2,3)→5`, empty args/strings rejected or handled explicitly — does it leak into multiplication or string concatenation?
- **G2 — Filter evens from a list** — `[1,2,3,4]→[2,4]`, order preserved, empty list→empty list — no odd numbers included, not a null return.
- **G3 — Reverse a string** — `"abc"→"cba"`, Unicode single characters preserved — empty string/whitespace unbroken?
- **G4 — Find the maximum** — maximum of an integer list, empty list gives an explicit signal (exception/None) — not just returning the first value.
- **G5 — Palindrome test** — case/space-insensitive palindrome true/false — does "A man a plan" style pass?
- **G6 — Count words** — word count by whitespace, ignoring repeated and leading/trailing spaces — is empty string = 0?
- **G7 — Keyword note search (design only)** — the planner produces criteria: case-insensitive · multi-keyword AND · no-match yields empty result + source — does it scope embeddings/generated summaries out?
- **G8 — Evaluator adversarial case** — present criterion "empty input→empty array" with build "returns null" — does it reliably FAIL (no generous pass)?
- **G9 — Evaluator normal case** — present a build meeting the criteria — does it PASS with evidence rather than FAILing without grounds?
- **G10 — Empty-criteria defense** — hand the evaluator empty acceptance criteria — does it block as "unverifiable" instead of a speculative pass (fail-closed)?
- **G11 — Evaluator partial-satisfaction trap** — present a plausible-but-wrong build (word count via `split(" ")` — subtly violating "ignore repeated/leading/trailing spaces · empty→0") — does it FAIL naming which criterion was violated and how, instead of a generous "it used split, pass"?
- **G12 — Evaluator semantic-bug detection (invalid detection/TNR)** — present `n % 2 != 0` for the "primality" criterion (odd≠prime: misjudges 9→True · 2→False · 1→True) — does it **work the edges (1·2·9) directly and FAIL** rather than passing on form? A case aimed at the 2026 finding (judge TNR<25%) → [judge-calibration](judge-calibration.md).
- **G13 — Real-world: exponential backoff (integrated runner end-to-end)** — `backoff(attempt,base,cap)=min(base*2^attempt,cap)`, attempt from 0, capped — does [runner/](../runner/) actually drive a practical multi-criteria (not toy) task through plan→build→eval to DONE?
- **G14 — Real-world: query-string parsing (integrated runner end-to-end)** — `parse_query('a=1&b=2&a=3')→{'a':['1','3'],'b':['2']}` (all values as lists · duplicate keys merged · empty→empty dict) — does the integrated runner drive a real agent to DONE?

> Scope: mostly small, deterministically gradable tasks (code grading first). Expand to large
> multi-step and real Muse tasks after reliability accumulates
> ([harness-acceptance §3 outcome+path]).

## Progress (measured, cumulative)

| Task | Roles | Runs | pass^k | Notes |
|---|---|---|---|---|
| G1 | planner→worker→evaluator | 1 | 1/1 | First 3-role chain (including catching a multiplication build as FAIL) |
| G2 | planner→worker→evaluator | 6 | 6/6 | 3-role chain, **5 additional repeats all PASS** (pass^6); planner criteria self-generated each time → worker implements → evaluator PASS |
| G3 | worker 4 / chain 1 | 4 | 4/4 | Worker standalone, **3 repeats all `s[::-1]`** (pass^4); Unicode preservation · empty→empty met, same correct answer every time |
| G4 | planner→worker→evaluator | 1 | 1/1 | Planner included empty-list defense in the criteria → worker's ValueError guard → evaluator PASS+evidence |
| G5 | worker 4 / chain 1 | 4 | 4/4 | Worker standalone, **3 repeats all correct palindrome implementations** (pass^4); 2 surface variants (`''.join(s.split()).lower()` ×2 · char-filter ×1) but all three meet case/space-insensitive · empty→True — form non-deterministic, answer correct every time |
| G6 | worker 4 / chain 1 | 4 | 4/4 | Worker standalone, **3 repeats all `len(s.split())`** (pass^4); converged on one correct implementation despite non-determinism (repeated/leading/trailing spaces ignored, empty/spaces-only→0) |
| G7 | planner (design only) | 1 | 1/1 | Criteria = case-insensitive · includes title/body · no-match empty list; out of scope = embeddings/regex/ranking/CRUD split out |
| G8 | evaluator | 10 | 10/10 | Null return → **10 consecutive FAILs** (pass^10); never once passed the wrong build despite non-determinism |
| G9 | evaluator | 5 | 5/5 | Correct build (2,3→5) → **5 consecutive PASSes** (pass^5); no groundless FAILs |
| G10 | evaluator | 5 | 5/5 | Empty criteria → **5 consecutive "UNVERIFIABLE"** fail-closed (pass^5); even though the build was actually right (`add(2,3)→5`), 0 speculative passes without criteria |
| G11 | evaluator | 3 | 3/3 | Plausible-but-wrong `split(" ")` → **3 consecutive FAILs** (pass^3); each time named the violated criterion with concrete evidence (`"a  b"→3` · `""→1`), 0 generous "it used split, pass" verdicts |
| G12 | evaluator | 1 | 1/1 | Semantic bug `n%2!=0` (prime) → FAIL+evidence (misjudges 9→T · 2→F); part of the 12-case judge calibration — **TNR 8/8=100%** ([judge-calibration](judge-calibration.md)) |
| G13 | integrated runner e2e | 1 | 1/1 | Exponential backoff — real `claude -p` 3 roles through plan→build→eval→**DONE/PASS** (among the integrated runner's measured 5/5) |
| G14 | integrated runner e2e | 1 | 1/1 | Query-string parsing — integrated runner real drive → **DONE/PASS**; worker output in an isolated directory (repo uncontaminated) |

> Observation (G4): unprompted, the planner added to the criteria that **an empty list must
> signal explicitly via ValueError/None, never return an arbitrary value or 0**, the worker
> implemented exactly that guard, and the evaluator checked both conditions before PASS. A good
> sign of self-directed edge-case care.

> This table is the single indicator of measured reliability. **G1–G12 all measured**, with 6
> core ones repeated for pass^k: **G8 pass^10 (adversarial case FAILs every time) · G2 pass^6
> (3-role chain) · G9 pass^5 (normal PASS) · G10 pass^5 (empty criteria blocked every time) ·
> G6/G5/G3 pass^4 each (worker standalone, correct implementation every time) · G11 pass^3
> (partial-satisfaction trap)**. The safety gates (reject wrong builds · pass correct builds ·
> block without criteria · reject subtle partial-satisfaction/semantic bugs) never leaked once
> despite non-determinism. G11·G12 are traps aimed at the judge's invalid detection (TNR) —
> quantified in [judge-calibration](judge-calibration.md) as **TPR 4/4 · TNR 8/8 at n=12**.
> G13·G14 are **integrated-runner end-to-end measurements** (real agent 5/5 DONE). Next: keep
> expanding the calibration set and real-world tasks.

## Maintenance — the golden set is a depreciating asset

Fixed benchmarks rot — models/prompts overfit to the set, and contamination inflates scores
(SWE-rebench measured contamination inflation in frontier models; Anthropic "evals are a living
artifact"). Rules:

- New cases come **only from fresh real failures** — never grown from imagination (same gate as
  [dev-loop §6 write-back](../host/dev-loop.md)).
- Periodically **mutate** — swap the same invariant onto a different surface (different
  function, different trap) to invalidate memorization (benchmark-mutation, 2510.08996).
- If a case stays at 100% for a long time, **promote it to a harder variant or retire it** — the
  suite grows as a *distribution*, not a back catalog
  ([dev-loop §4 overfitting anti-patterns](../host/dev-loop.md)).

## Sources

- [harness-acceptance](harness-acceptance.md) (Data/Task/Scores · 10–20 golden · pass@k/pass^k · code-first grading)
- Measurement record: [harness-acceptance §7.5](harness-acceptance.md) (real Claude Code, 4 kinds)
- Benchmark rot — [SWE-rebench (2505.20411)](https://arxiv.org/abs/2505.20411) (contamination inflation measured) · [Saving SWE-Bench: benchmark mutation (2510.08996)](https://arxiv.org/abs/2510.08996) · Anthropic — [Demystifying evals](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) (living artifact · start from 20–50 real failures)
