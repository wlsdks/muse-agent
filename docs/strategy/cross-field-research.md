---
title: Cross-field research — mining open papers from many fields into Muse's agent
audience: [기획자, 개발자, AI 에이전트]
purpose: The record of what we've tried — every cross-disciplinary mechanism distilled into a Muse capability, with its field, paper, and command. The moat vs hermes/openclaw.
updated: 2026-06-05
related: [identity.md, the-edge.md, reasoning-principles.md, ../../README.md]
---

# Cross-field research — the mechanisms we mined into Muse

> Standing direction (진안): Muse must be an OVERWHELMINGLY better agent than its
> peers (Hermes, OpenClaw). One lever is unique: we continuously read OPEN papers
> from MANY fields — biology / life-sciences first, but also neuroscience,
> ecology, network science, control theory, decision theory, information science,
> linguistics, psychology, forensic & environmental statistics — find a REAL
> mechanism (how nature, the brain, a market, or a cell actually solves a
> problem), and FAITHFULLY distill it into a Muse capability. The science drives
> the design, not a buzzword label. **One verified slice per iteration. Record
> every one — here, in the code as a cited comment, and in `CAPABILITIES.md`.**

## Why this is a moat

Hermes self-improves but can confabulate; OpenClaw "dreams" but its dreams aren't
grounded. Both are capability-first. Muse's edge is the **refusal floor**
(grounding + "I'm not sure" + fabrication=0, [the-edge.md](the-edge.md)) — and on
top of that floor we compound an advantage neither rival has: an agent whose
behaviours are **distilled from peer-reviewed mechanisms across disciplines**,
each one deterministic where possible and live-verified on the local model. A
competitor can copy a feature; copying a *research-distillation discipline* that
is yoked to a fabrication-zero floor is far harder.

## The discipline (every slice)

1. **Faithful** — the paper's mechanism drives the design; we cite it in the
   module header comment and here. No cargo-cult labels.
2. **Deterministic where possible** — the load-bearing logic is code, not a model
   guess, so the small local Qwen can't flake it.
3. **Live-verified** — a real round-trip on the loop PC proves it before it ships.
4. **Honest about limits + negative results** — what was tried and *rejected* is
   recorded too (below), so we don't repeat dead ends.

## The catalog

| Field | Mechanism (paper) | Muse capability |
| --- | --- | --- |
| Ecology | Marginal Value Theorem / optimal foraging (Charnov 1976) | `muse recall --adaptive` — the evidence picks how many sources to return |
| Ecology / biodiversity | Shannon & Simpson diversity indices + Pielou evenness (Shannon 1948; Simpson 1949) | `muse diversity` — is a category column DIVERSE or concentrated in one bucket? |
| Collective behaviour / biology | Stigmergy, ant pheromone trails (Grassé 1959; Vittori 2006) | `muse notes trails` / `hubs` — an evaporating co-recall relatedness graph |
| Physiology / neuroscience | Allostasis — predictive regulation (Sterling 2012) | `muse pattern upcoming` — anticipate a recurring need before its slot |
| Network science | k-shell decomposition / influential spreaders (Kitsak et al. 2010) | `muse notes hubs` — the load-bearing core of your notes (depth, not degree) |
| Control theory / SPC | CUSUM change-point (Page 1954) | `muse pattern lapsed` — a recurring habit that has STOPPED |
| Decision / information theory | Expected information gain / EVPI (Lindley 1956; Howard 1966) | `muse ask` clarify arm — ask when divergent sources tie, vs guess or abstain |
| Computer science (web-scale) | Broder resemblance / shingling (Broder 1997) | `muse feeds` near-duplicate collapse (same story across outlets) |
| Information science | Luhn extractive summarization (Luhn 1958) | `muse summarize` — a document's own key sentences (cannot fabricate) |
| Computational linguistics | Pointwise mutual information (Church & Hanks 1990) | `muse contacts related` — inferred relationship edges from co-mention |
| Queueing / operations research | Little's Law L=λW (Little 1961) | `muse tasks flow` — are you finishing tasks as fast as you add them? |
| Forensic statistics | Benford's Law + Pearson χ² (Benford 1938; Pearson 1900) | `muse benford` — unnatural patterns in a numeric column |
| Organizational psychology | Attention residue / deep work (Leroy 2009) | `muse calendar focus` + a morning-brief beat — longest uninterrupted block |
| Psychology | Implementation intentions / time-blocking (Gollwitzer 1999) | `muse calendar block` — book the next free slot to protect focus (an ACT) |
| NLP | RAKE keyphrase extraction (Rose et al. 2010) | `muse keywords` — a document's key phrases (topics) |
| Cognitive psychology | Autobiographical / date-cued recall (Rubin et al. 1986) | `muse on-this-day` + a brief beat — notes from today's date in earlier years |
| Environmental statistics | Mann-Kendall trend + Sen's slope (Mann 1945; Kendall 1975) | `muse trend` — is a tracking column rising, falling, or wandering? |
| Cognition / strategy | First-principles thinking (Musk) + contrarian question (Thiel) | reasoning principles in `muse ask` — engine; the grounding floor is the brake ([reasoning-principles.md](reasoning-principles.md)) |

## Negative results (recorded so we don't repeat them)

- **Immune negative-selection for per-claim grounding** — fully built, then
  FALSIFIED by a live nomic-embed calibration: recombination hallucinations embed
  as "self" (topical, not propositional). Reverted. The viable path is a
  propositional per-claim LLM ISSUP judge, not topical embeddings.
- **SimHash for headline dedup** — false-merged two DIFFERENT same-template
  stories in the live test; pivoted to Broder resemblance (cleanly separable).
- **Nigrini fixed-threshold MAD for Benford** — cried wolf on a genuine 250-row
  column (sample-size-independent); pivoted to chi-square (scales to the sample).
- **A "proactivity rubric" reusing the lexical answerability gate** — unsound on a
  semantic/cosine surface (suppressed legitimate paraphrase matches).

## Efficacy verification — does it actually WORK, not just run?

> 진안 (2026-06-05): verifying a mechanism RUNS is not the same as verifying it
> has an EFFECT. For anything that claims to *improve* something, measure the
> improvement against a baseline — don't assume it.

**The split that matters:**

- **Deterministic mechanisms** (recall ranking, dedup, the stats commands, the
  clarify gate) are **efficacy-clear by construction** — their correctness test
  IS the proof. Mann-Kendall genuinely detects a monotonic trend; Broder
  resemblance genuinely collapses near-duplicates; PMI genuinely demotes the
  ubiquitous contact. There is no "does it work?" gap.
- **Model-dependent / prompt mechanisms** must be A/B'd, because a small local
  model may simply ignore a prompt nudge.

**First efficacy A/B (`apps/cli/scripts/verify-reasoning-efficacy.mjs`):** the
reasoning-principles block (Musk/Thiel, wired into `muse ask`) — same reasoning
questions answered with the principles ON vs OFF (`MUSE_ASK_REASONING_PRINCIPLES=0`),
a blind qwen judge picking the better-reasoned answer (order randomized).
**Result over 12 judgments: ON 1 / OFF 1 / TIE 10 — NEUTRAL.** The 3-line nudge
has **no measurable effect on qwen3:8b**; it doesn't hurt, but it doesn't help.
Honest takeaway: a prompt nudge is weak on a small model — the deterministic
mechanisms carry the value, and the reasoning *principle* is best honoured by the
grounding floor (which is first-principles-by-construction: "claim only what the
sources establish"), not by extra prompt lines. (The framing doc stands; the
prompt wiring's fate is 진안's call since he approved it.)

## Next direction

Per 진안 (2026-06-05): lean harder into **biology / life-sciences / biotech** —
there is a deep well there we've only sampled (foraging, stigmergy, allostasis,
autobiographical memory). Candidates to mine next: immune clonal selection /
affinity maturation, gene-regulatory motifs, homeostatic feedback, predictive
coding / free energy, complementary-learning-systems consolidation, ecological
diversity indices, kin selection / reciprocity for the relationship graph.
