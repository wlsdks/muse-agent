# Muse's functional edge — "Shows its work"

> Decided 2026-05-30 (with 진안). Local-by-construction and privacy are
> *table stakes*, not the pitch. THIS is the functional reason to use Muse —
> the capability competitors don't have. Every surface, every doc, and the
> reinforcement loop point back here.

## The one line

**Muse shows its work — for everything.** Every answer about your world cites
the exact source in your own notes. Every proactive nudge points to *why*.
Every insight Muse forms about you traces back to the real moments it came
from. A deterministic gate makes "confidently wrong" impossible **by code**,
and Muse continuously measures its own grounding — it would rather say
"I'm not sure" than guess.

## Why this, and why it's ours alone

- **It's functional, not a posture.** "Private / local" is the floor. The
  *capability* users feel is: you can trust what it says because it shows the
  receipt — and it refuses instead of bluffing.
- **The competitors can't claim it.** Hermes self-improves but can
  confabulate; OpenClaw "dreams" but its dreams aren't grounded or cited. Muse
  is the only one that is **proactive AND self-learning AND incapable of making
  things up** — every claim is verifiable. That chair is empty and ours.
- **The weak local 8B becomes the selling point.** The model never decides what
  is true or relevant — a deterministic confidence + citation gate does. So a
  small private model is *safe* to trust, because the honesty is in the code,
  not the model's good intentions.

## The invariant (what "the edge" means in code)

Across every grounded surface:

1. **Cite or stay silent.** A claim carries a real `[source]` that resolves to
   an actual item the user has, or it is not made.
2. **Uncertain → "I'm not sure", never a guess.** A weak match is framed as
   low-confidence, not dressed up as fact (CRAG-style confidence gate).
3. **No invented sources.** A citation/source id that isn't a real input is
   stripped deterministically; an under-supported claim is dropped. The model
   *cannot* ground a claim in something the user doesn't have.
4. **Fabrication rate = 0** is a release gate, not an aspiration.

## The grounded surfaces today (coverage grows each iteration)

| Surface | Gate | Live proof (in `eval:self-improving`) |
|---|---|---|
| **Recall** — `muse ask` / `knowledge_search` | `classifyRetrievalConfidence` + copy-ready `cite as:` tokens | `verify-cited-recall` |
| **Proactivity** — daemon nudges | `decideProactiveRecall` (surface only when confident; cite the note) | `verify-proactive-recall-gate` |
| **Reflection ("dreaming")** — idle insights about you | `parseReflections` strips invented source ids, drops under-supported | `verify-reflection-synthesis` |

Each new surface Muse gains MUST plug into the same gate and ship a live
battery asserting the invariant. That is how the edge widens.

## The reinforcement + verification loop (the core)

The autonomous loop doesn't just *add* features — it **strengthens this edge and
proves the strengthening is real**, every iteration:

1. **Strengthen** — extend the grounding gate to a new surface, or harden an
   existing one (better calibration, more sources, tighter refusal).
2. **Prove** — the slice's live battery asserts the invariant on the LOCAL
   model (no fabricated source survives); it joins `eval:self-improving`.
3. **Check it's actually improving** — `eval:self-improving` runs every tick;
   it must stay green (fabrication = 0 across all batteries) AND the grounded-
   surface count must be non-decreasing. A drop is a regression to fix first.

So "is the edge getting stronger?" is mechanical, not a vibe: more surfaces
gated, invariant never broken, measured on the real local model each loop.

## Out of scope (so the edge stays sharp)

Leading with "privacy" as the pitch (it's the floor); letting the 8B judge
relevance/truth (the gate does); a "grounded" claim whose source the user can't
actually open; growing surfaces faster than we can prove the invariant on them.
