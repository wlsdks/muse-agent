# Whetstone — the weakness-aware self-improvement axis

> *A modest blade kept sharp out-cuts a fine blade left dull.* A small
> local model is still a form of intelligence; like a person of ordinary
> ability who outperforms through disciplined, systematic self-correction,
> Muse improves by **knowing its own weaknesses and deliberately grinding
> them down** — without ever changing the model's weights.

Origin: Jinan's directive (2026-06-06) — *"본인의 약점을 스스로 파악하고
개선하는 AI agent를 핵심 강점으로."* This is the **third core axis**, beside
the **grounding edge** (never fabricate) and the **Playbook** (reinforce what
works). Where the Playbook remembers the *plays that succeed*, Whetstone is the
metacognition that remembers *what Muse reliably gets wrong, and the drill that
fixes it.*

## Honest framing: this is NOT reinforcement learning

Jinan asked: *can it learn like a human, via RL?* The honest answer for a
**fixed local 8B**: there is no policy gradient, no value network, no weight
update — calling it "RL" would be a misnomer that invites the wrong code.
The correct framing is **experience-indexed, retrieval-augmented cognition
with a reliability brake**. The RL vocabulary is a useful *metaphor* only:

| RL concept | Muse's gradient-free analogue |
|---|---|
| reward signal | the deterministic **grounding gate** passing / a user not correcting |
| policy | which **Playbook strategy / weakness-hint** gets retrieved & emphasised |
| policy update | re-weighting retrieval & rewriting prompt scaffolds — **never weights** |
| exploration | spaced **re-challenge** of weak task types |

Improvement is real, but it lives in *process, memory, prompts, and routing* —
exactly how a disciplined human learner improves a fixed brain.

## The loop (learning-science ⨉ ML agree on the same four phases)

Both bodies of research — cognitive/education science and 2024-2026 agent papers
— converge on one loop. Each phase already has a seam in Muse.

1. **Monitor / Predict** — tag every answer with a structured confidence
   (`HIGH|MED|LOW`, `grounded|inferred|uncertain`). This is a *Judgment of
   Learning* (Nelson & Narens 1990) and a calibration probe.
   *Seam:* the ask-wedge answer envelope; the grounding verdict already computes
   most of this.
2. **Detect** — the **grounding gate / rubric / a user correction** is the
   failure signal. It already fires on every weak answer — Muse doesn't need a
   new detector, it needs to *record* what fired.
   *Seam:* `verifyGrounding` + the correction-decay path.
3. **Attribute / Classify** — sort each failure into a small **taxonomy**
   (retrieval-gap · wrong-tool/args · context-overflow · prompt-format ·
   ungrounded-claim), keyed on `(failure_axis, topic)`. Deterministic where
   possible; one focused LLM call only when needed (qwen3:8b does focused
   classification well — cf. the correction-contradiction judge, 11/11 live).
   *New artifact:* the **Weakness Ledger** — a durable `~/.muse/weaknesses.json`
   of `{axis, topic, count, lastSeen, hint}` rows.
4. **Remediate / Reschedule** — inject the top weakness-hints for the active
   context ("watch out: you tend to drop the timezone on calendar times") into
   the next turn's system block; **spaced re-challenge** of weak task types
   (testing effect — Roediger & Karpicke 2006); and a periodic **calibration
   brake** that resets confidence when over-confidence drifts up.
   *Seam:* the Playbook injection path + `eval:self-improving`.

Orthogonal to all four: **blind-spot detection** (Dunning-Kruger 1999) — the
cases where Muse is confidently wrong (HIGH confidence, systematic failure) are
the *highest-priority* ledger entries, because a weakness you don't know you
have is the dangerous one.

## Why this strengthens — never weakens — the grounding edge

Whetstone is downstream of the grounding gate, never a bypass of it. It records
and remediates the gate's own misses; the calibration brake (Huang et al. 2025,
*Beyond Accuracy*) explicitly prevents the failure mode where iterative self-
improvement inflates confidence until a drifting strategy produces *confidently
wrong cited answers*. fabrication-rate = 0 stays the floor.

## Grounding in real, public work

Learning science (how a human finds & fixes their own weaknesses):

- **Metacognitive monitoring/control** — Flavell 1979; Nelson & Narens 1990.
- **Self-regulated learning** (forethought → performance → reflection;
  *strategy* vs *ability* attribution) — Zimmerman 2000.
- **Deliberate practice** (target the edge of current capability) — Ericsson,
  Krampe & Tesch-Römer 1993.
- **Calibration / illusion of knowing** — Kruger & Dunning 1999; Koriat 1997;
  Thiede et al. 2003.
- **Formative assessment + testing effect** (gap-closing feedback; errors as
  the readout of what hasn't consolidated) — Black & Wiliam 1998; Roediger &
  Karpicke 2006.

Agent / ML (fixed-weight self-improvement, 2023-2026):

- **Reflexion** (verbal post-mortem into episodic memory) — Shinn et al.,
  NeurIPS 2023. *Caveat: capability-gated — on a ~7B model the reflection must
  be structured, not free-form, to help.*
- **ExpeL** (contrastive success/failure → generalised insights) — Zhao et al.,
  AAAI 2024.
- **ReasoningBank + MaTTS** (asymmetric success/"avoid" memory; failure
  trajectories made constructive) — Ouyang et al., ICLR 2026.
- **AgentDebug / AgentErrorTaxonomy** (5-axis failure taxonomy → targeted
  replay) — Zhu et al. 2025.
- **Beyond Accuracy: Calibration in Self-Improving LLMs** (the brake; ECE drifts
  up across self-improvement on 7-8B models) — Huang et al. 2025.
- **Knowledge-boundary survey** (detecting what a model doesn't know) — Li et
  al. 2024.

## Build order (one verified slice per loop fire)

1. **Weakness Ledger write** — when the grounding gate rejects (or a user
   corrects), classify the failure (deterministic taxonomy first) and upsert a
   `~/.muse/weaknesses.json` row. *Check:* a unit test that a forced gate-reject
   writes the right `(axis, topic)` row; encrypted-at-rest via `encrypted-file.ts`.
2. **Weakness-hint injection** — inject the top-N active-context weakness hints
   into the next turn's system block. *Check:* `eval:self-improving` — a topic
   with a recorded weakness shows a measurable lift; ablate the injection.
3. **Calibration brake** — a `verify-calibration` probe in `eval:self-improving`
   measuring ECE drift; fire a re-anchor when it exceeds threshold. *Check:* the
   probe’s before/after ECE on local qwen.
4. **Spaced re-challenge** — re-surface weak task types at widening intervals;
   graduate ones that pass consistently out of the active set. *Check:* a
   deterministic scheduler unit test.
5. **`muse doctor --weaknesses`** — surface the ledger to the user (honest
   self-report: "here's what I'm still bad at"), pairing with the existing
   `muse doctor --grounding`.

Naming note: this axis is **Whetstone**; its core data structure is the
**Weakness Ledger**. (Alternatives considered: *Weakness Ledger* as the whole
axis; *Report Card* for the user-facing surface. Easy to rename — one find/replace.)
