---
title: Muse 정체성 — 단 하나의 강점과 그 이유
audience: [기획자, 개발자, AI 에이전트]
purpose: Muse의 포지셔닝(왜 Muse인가) — 모든 표면이 반영하는 기준
updated: 2026-05-30
related: [../SYSTEM-MAP.md, ../FEATURES.md, ../README.md]
---

# Muse identity — the one strength, and why

> Decided 2026-05-30 (with 진안), after three adversarial multi-agent passes
> grounding in the real Hermes/OpenClaw repos + Muse's own code. This is the
> standing positioning every surface (README, GitHub, CLAUDE.md) reflects.
>
> 이 문서는 "왜 Muse인가"(전략·포지셔닝)입니다. "무엇을 할 수 있나"는
> [기능 구조 지도](../SYSTEM-MAP.md)와 [기능 정의서](../FEATURES.md)를 보세요.

## The one line

> **Tell it everything. It can't tell anyone.**
>
> Muse is the AI assistant that's *actually yours* — it answers from your own
> notes and files (the exact source quoted), says "I'm not sure" instead of
> making things up, and runs entirely on your machine. Nothing leaves it.
> That's not a setting; it's enforced in the code.

Korean: **"다 털어놔도 되는 AI."**

> **The FUNCTIONAL edge (what makes Muse worth using, beyond local/private):
> "Muse shows its work" — one deterministic grounding gate under every surface,
> continuously measured. This document is the *positioning*;
> [`the-edge.md`](the-edge.md) is the *functional differentiator* the loop
> strengthens and verifies each iteration.**

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

1. **Wedge live (`muse ask --notes-only` / `knowledge_search`).**
   - [DONE] The refusal is now a TESTED first-class feature: `verify-cited-recall.mjs`
     drives the real path (rankKnowledgeChunks → classifyRetrievalConfidence →
     renderKnowledgeMatches) on LOCAL Ollama embeddings (nomic-embed-text) and
     is in the `eval:self-improving` gate — in-corpus → confident "cite the
     [source]" (cosine ~0.70); out-of-corpus → the LOW-confidence/no-match
     banner (cosine ~0.42, below the ~0.61 bar), never confabulation. The
     calibration "what must be true" is verified live (real hits ~0.70 separate
     cleanly from off-topic ~0.42). (Drives the functions directly, sidestepping
     the smoke:live API stall on the loop PC.)
   - [DONE — chat exports] `muse ingest <file>` eats the scattered pain corpus:
     it converts an exported ChatGPT/Claude `conversations.json` into markdown
     notes the existing `muse notes reindex` + cited-recall pipeline picks up
     unchanged. Pure tolerant parsers (apps/cli/src/chat-export-ingest.ts, 6
     unit tests); the export→ingest→citable chain is proven live in
     `verify-cited-recall.mjs` (an ingested Claude chat cites at cosine ~0.81).
   - [DONE — .mbox mail] `muse ingest` now also eats an `.mbox` mail archive
     (lean dependency-free parser: split → headers → text/plain body, QP/base64
     decoded, multipart text part picked, HTML stripped, RFC-2047 subjects) →
     markdown notes. The email→ingest→citable chain is proven live in
     verify-cited-recall.mjs (an ingested email cites at cosine ~0.82).
   - [DONE — ask gate] `muse ask` now applies the CRAG confidence gate to its
     notes grounding (`notesGroundingFraming`): a CONFIDENT hit is framed for
     citation; a WEAK near-miss set is flagged LOW-confidence and the model is
     told NOT to cite it as fact (+ a "⚠ LOW confidence — verify" banner). The
     headline command now embodies "says I'm not sure instead of making things
     up," not just `knowledge_search`.
   - [DONE — onboarding] `muse onboard` is the guided front door: a pure,
     tested `computeOnboarding` checks readiness (Ollama → chat model → embed
     model → corpus → index) and prints the SINGLE next command until
     `muse ask` returns a cited answer. README leads with it. Verified by 6
     unit tests + a live run (all-green → "Ready, ask your own machine").
   Phase 1 COMPLETE: the wedge is live-proven (cited recall + refusal), eats
   the pain corpus (chat-export + .mbox ingest), the headline command embodies
   the gate (`muse ask` CRAG), and a guided onboarding walks a new user to the
   first cited answer.
2. **Trust instrumentation** — DONE. Every delivered proactive notice is
   recorded to `~/.muse/proactive-trust.json` (`proactive-trust-ledger.ts`); a
   one-command veto (`muse proactive veto <source>`) silences that source
   forever (learned avoidance); `muse proactive scoreboard` shows the precision
   (non-vetoed fraction of what Muse surfaced unasked); a 24h `dailyCap`
   (`MUSE_PROACTIVE_DAILY_CAP`) bounds bursts. Wired into the real loop +
   daemon (CLI + API). Verified: 10 ledger unit tests + 3 contract-faithful
   loop tests (record / vetoed-source-silenced / cap) + 2 scoreboard render
   tests + a live veto→scoreboard round-trip.
3. **Proactivity (the north star)** — DONE. The SAME deterministic CRAG gate
   that makes cited recall trustworthy now makes proactivity quiet:
   `decideProactiveRecall` / `createConfidenceGatedInvestigator`
   (`proactive-recall-gate.ts`) recall over the user's corpus on a deterministic
   trigger and append a cited "📎 Related in your notes — [source]" finding ONLY
   when confident; a weak/empty recall STAYS SILENT (never a guess). Wired into
   the local daemon over the pre-embedded notes index
   (`createIndexedProactiveInvestigator`, query-only re-embed per tick). State-
   changing third-party sends remain draft-first per `outbound-safety.md`.
   Proactivity is *earned*: the gate is live-proven (verify-proactive-recall-gate
   battery in the eval gate) to surface a cited finding in-corpus and stay silent
   off-topic; 8 gate unit tests + 4 indexed-investigator tests.

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
