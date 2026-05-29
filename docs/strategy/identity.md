# Muse identity — the one strength, and why

> Decided 2026-05-30 (with 진안), after three adversarial multi-agent passes
> grounding in the real Hermes/OpenClaw repos + Muse's own code. This is the
> standing positioning every surface (README, GitHub, CLAUDE.md) reflects.

## The one line

> **Tell it everything. It can't tell anyone.**
>
> Muse is the AI assistant that's *actually yours* — it answers from your own
> notes and files (the exact source quoted), says "I'm not sure" instead of
> making things up, and runs entirely on your machine. Nothing leaves it.
> That's not a setting; it's enforced in the code.

Korean: **"다 털어놔도 되는 AI."**

## The axis: OWNERSHIP / trust (not "proactivity", not bare "privacy")

The differentiator is **TRUST = (private by construction) × (honest — won't
make things up)**, framed as *ownership* ("actually yours"). It wins on every
angle we tested:

- **Differentiation.** The competitors' real slogans: Hermes = "the
  self-improving AI agent" (cloud/VPS-first; review forks inherit cloud
  credentials → your life goes to a third-party LLM). OpenClaw = "personal
  assistant you run on your own devices / EXFOLIATE" (cloud-flagship-leaning;
  no local-only egress gate). "Self-improving" and "on your devices" are taken
  and copyable. **A cloud product cannot claim "it can't tell anyone" without
  ceasing to be a cloud product** — that chair is empty and ours alone.
- **Honesty of the claim.** "Tell it everything. It can't tell anyone." is
  true TODAY in code (`MUSE_LOCAL_ONLY` default-on; `classifyProviderLocality`
  + `LocalOnlyViolationError`). It makes no reasoner-quality claim a local
  8B can't keep — "quotes the source / says I'm not sure" turns the weak local
  model into the selling point.
- **Emotion.** It removes the two universal flinches — "is this going to a
  server?" and "is it confidently wrong again?" — without saying "privacy"
  (which underperforms; the DuckDuckGo trap). The felt benefit is *relief*:
  you can finally use it on the work that actually matters.
- **It doesn't forfeit self-improvement or breadth.** Those stay as product
  layers (the background-review engine already learns you; MCP-neutral keeps
  the tool breadth). Trust is the *precondition* that makes them safe to adopt
  for your private life, not a competitor to them. We *lead* with the only
  un-copyable axis; the rest rides underneath.

Runner-up axis: bare "privacy by construction" (strongest moat, but a
guarantee people only feel in the negative). We make privacy the silent
enabler, not the headline.

## The wedge (front door): confidence-gated cited recall

The first thing to be undeniably great at — deliverable now, structurally
safe on an 8B, and a painkiller for the beachhead:

- **Beachhead:** people who literally *cannot* paste their work into ChatGPT —
  lawyers (privileged docs), therapists (session notes), clinicians (patient
  info), founders (unannounced financials). For them Muse isn't a weaker
  choice; it's the only one they can use on their real work.
- **The wow (first session):** point Muse at your notes/files → ask. (1) In
  your corpus → answer with the literal passage quoted + `[source]`, verifiable
  at a glance. (2) Not in your corpus → "LOW confidence — verify" / "no
  matching passages," NOT a confabulation. The felt moment: *it quoted my own
  words back with the receipt, and it refused to make something up.*
- **Why the 8B can't sink it:** the INTERRUPT/assert decision is DETERMINISTIC
  (`classifyRetrievalConfidence` grades the top match's cosine before the model
  speaks; hybrid retrieval hands it ranked, source-labelled passages). The 8B
  only phrases and cites what it was given — it is never the relevance judge.
  "Confidently wrong over your own corpus" is impossible by code, not by hope.

## Local-by-construction is enforced, not optional

`MUSE_LOCAL_ONLY` defaults **ON** (changed 2026-05-30). The model router throws
`LocalOnlyViolationError` before instantiating any cloud provider; the voice
registry ignores cloud STT/TTS keys. A cloud provider requires an explicit
`MUSE_LOCAL_ONLY=false` opt-out that visibly forfeits the zero-egress
guarantee. Open-source weights via Ollama or HuggingFace-run-locally are the
norm; a HuggingFace *hosted* API (remote host) is classified cloud and refused.
The slogan "It can't tell anyone… enforced in the code" is literally true.

## Phasing (build toward the identity; fine if not all built yet)

1. **Wedge live (`muse ask --notes-only` / `knowledge_search`)** — make cited,
   confidence-gated recall the headline surface; widen the ingestible corpus
   (an .mbox / exported-chat-history pile-ingester) so Muse eats the data that
   causes the pain. A `smoke:live` gate asserting the LOW-confidence/no-match
   banner fires (the refusal is a tested first-class feature).
2. **Trust instrumentation** — log every surfaced/recalled item's deterministic
   trigger + a one-tap veto; track precision; quiet-hours + caps.
3. **Proactivity (the north star)** — turn the SAME deterministic-retrieval +
   confidence-gate machinery proactive: a deterministic trigger (due date,
   calendar conflict, matched commitment) runs a confidence-gated recall and
   surfaces ONLY when confident, draft-first per `outbound-safety.md`.
   Proactivity is *earned* once the gate has proven it can stay quiet.

## What must be true (the bets)

- The confidence gate is calibrated on real personal corpora (a `smoke:live`
  calibration test, not just the unit split).
- The 8B stays inside the handed passages (cites a real `[source]`, no
  confabulation on a confident answer) — verified live.
- The corpus people actually want is ingestible with near-zero ritual.
- Onboarding (install + Ollama + first reindex) is a guided one-command path
  for a non-technical, privacy-bound user.

## Out of scope (deliberate)

Leading with "privacy" as the headline; making the 8B decide what to surface;
hard-removing the provider-neutral adapters (kept, but local is default-on);
cloud memory backends; banking/payments; any autonomous third-party send.
