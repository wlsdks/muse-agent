# Goal epic — cross-field mechanisms A/B/C (compounding, careful, one slice per fire)

> Jinan (2026-06-06): make A, B, C all goals and work them **slowly and
> carefully** — Muse should grow stronger by **compounding** over time, get
> increasingly tailored to me, **admit its own mistakes**, and **self-learn in
> the background when it has time**. Source menu:
> [`docs/strategy/cross-field-research.md`](../strategy/cross-field-research.md)
> (candidate pipeline, 2026-06-06).

**Discipline (unchanged):** local qwen3:8b · fabrication-zero floor is never
weakened · each slice = deterministic + locally-computable + a runnable LOCAL
before/after check · one slice per loop fire · record in all three places
(this file ← status, `cross-field-research.md` ← catalog row, `CAPABILITIES.md`
← proof) when a slice ships. **No rush — correctness compounds; a wrong floor
change is a regression.**

---

## Group A — harden the grounding/calibration FLOOR (do FIRST: floor + Whetstone + moat triple-align)

- [x] **A1 · Conformal calibrated abstention** — A1a (core) ✅ + A1b (`doctor --calibration`) ✅ + A1c (live gate wiring via opt-in `MUSE_GROUNDING_MIN_COSINE`) ✅ DONE. (Angelopoulos & Bates 2022; Mohri & Hashimoto ICML 2024).
  - *Mechanism:* a held-out calibration set of `(score, correct?)` pairs gives a
    distribution-free score threshold guaranteeing target coverage; below it →
    provably abstain.
  - *Muse:* upgrade the hand-tuned cosine "I'm not sure" cutoff to a threshold
    calibrated on the user's OWN notes; surface via `muse doctor --calibration`
    (threshold + empirical coverage). This IS Whetstone's calibration brake.
  - *Slices:* (A1a) pure `conformal.ts` — `conformalThreshold(scores,labels,α)` +
    `empiricalCoverage(...)`, unit-proven coverage guarantee on synthetic data;
    (A1b) `muse doctor --calibration` reports threshold + coverage on the bundled
    grounding corpus; (A1c) wire the calibrated threshold into the live
    abstention decision behind a flag, live-verify no new false refusals.
  - *Check:* a battery asserting empirical coverage ≥ target on a held-out split.

- [x] **A2 · Quorum-sensing multi-witness confidence** (opt-in single-source hedge `MUSE_QUORUM_HEDGE`) (Becker et al., Nat. Commun. 2022/2023) — *biology.*
  - *Mechanism:* a population switch fires only when aggregated independent
    signals cross a quorum threshold; noise-robust distributed vote.
  - *Muse:* answer only when ≥quorum independent passages agree, else "I'm not
    sure — only N/M sources agree." A second line of defense on fabrication-zero.
  - *Check:* inject a query with 0 / 1 / 3 agreeing sources → assert abstain /
    hedge / confident, via the RGV battery.

## Group B — fill a NEW axis (compounding personalization + background self-learning)

- [x] **B1 · Dunbar tie-strength decay → relationship nudges** (`muse contacts overdue`, calendar-derived) (Roberts & Dunbar 2011; Sapiezynski et al., Sci. Rep. 2022).
  - *Mechanism:* ties decay without contact at a layer-dependent rate; gap ≫ your
    usual cadence ⇒ overdue. Computable from contact TIMESTAMPS only (no content).
  - *Muse:* `muse relationships nudge` — "you haven't connected with X in a while
    — longer than usual." Privacy-preserving, emotionally resonant, a brand-new axis.
  - *Check:* synthetic contact log with a known overdue tie → assert it (and only
    it) is flagged.

- [x] **B2 · Synaptic tagging & capture → consolidation** (forget-half engine + `muse memory consolidate`; daemon hook = follow-up) (Tetzlaff 2021; Cairney et al., Trends Neurosci. 2025).
  - *Mechanism:* salient/re-engaged traces get consolidated; the rest decay
    (salience × recency × cross-reference → replay probability).
  - *Muse:* `muse consolidate` / a **background Sleep daemon** that, when idle,
    runs a weighted replay pass — promotes worth-keeping notes/episodes, decays
    the rest, re-verifies the promoted ones against the grounding gate. **This is
    the "background self-learning" Jinan asked for** + the loop-v2 Sleep daemon.
  - *Check:* seed notes with varied salience → assert the replay pass promotes the
    high-salience ones and decays the low.

## Group C — sharpen an EXISTING axis (recall / proactivity / reflection)

- [x] **C1 · activity anomaly** (`muse anomaly`; robust MAD point-anomaly — the deterministic per-day cousin of Matrix-Profile discords) (Lu et al., SIGKDD 2022) → `muse anomaly`: your most structurally abnormal day vs your own history.
- [~] **C2 · C1 feed-forward-loop persistence gate** — pure `selectEarnedThemes` engine ✅ (proven); daemon wiring (needs a theme-occurrence source) next. (Mangan & Alon 2003) → earned-proactivity: a nudge fires only when a theme persists across multiple sources over a dwell window (the north-star "earned proactivity", 3 counters + threshold).
- [ ] **C3 · Peak-end rule** (Kahneman et al. 1993) → `muse recap` stores an episode as its PEAK + END (cited), cheaper retrieval.
- [x] **C4 · Zeigarnik / Ovsiankina open-loops** (`muse tasks open-loops`) (Masicampo & Baumeister 2011) → `muse open-loops`: surface unfinished tasks + attach a when/where plan.
- [x] **C5 · change-point detection** (`muse pattern shifts`) (Adams & MacKay 2007) → `muse patterns --shifts`: detect the START of a new routine regime (complements CUSUM).

## Sequencing (compounding order)

A1 → A2 (floor first — everything else stands on it) → B2 (background
self-learning daemon — the compounding engine) → B1 (new axis) → C2 (earned
proactivity) → C1 / C3 / C4 / C5 as capacity allows. Do NOT batch the floor
changes (A1c, A2) into one commit — each needs its own live false-refusal check.

## Companion direction — "Muse admits its mistakes + a sparring partner" (Whetstone)

Two of Jinan's asks are already the Whetstone axis, deepened:
- **Admits its own mistakes** — the [Whetstone](../strategy/whetstone.md) ledger
  (records refusals + unbacked-action claims) + the knowledge-gap nudge. Next:
  surface a brief honest "I got this wrong before" beat at the relevant moment.
- **A sparring partner (agent-to-agent reinforcement)** — feasible as an
  automated PROBER, not free-form chat: a background harness where Claude Code (or
  a sub-agent) fires a battery of adversarial probes at the running Muse, scores
  each (hallucination? wrong tool? bad abstention?), and writes the misses to the
  Whetstone weakness ledger — so Muse compounds. Tracked as a Whetstone slice
  ("Whetstone sparring harness"); bounded per session (token + local-latency cost).
