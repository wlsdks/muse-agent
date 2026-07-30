---
title: The grounding gate — Muse's trust floor, as one flow
audience: [AI agents, developers]
purpose: How the grounding + citation gate handles a single question, end to end — a mental model
updated: 2026-06-20
related: [feature-catalog/02-knowledge-rag.md, glossary.md, SYSTEM-MAP.md]
---

# The grounding gate — as one flow

> Grounding is Attunement's **trust floor**. Claims about work rhythm, friction and resumption
> context must follow the same evidence discipline. For product direction, see
> [Attunement](strategy/attunement.md).

Muse's product identity is Attunement, but the deterministic trust floor that stops it inventing
claims about a person — and reasons to intervene — is the **grounding gate**. This document shows
*how a single question passes through that gate*, as one flow, for the mental model. Symbol- and
test-level evidence lives in [feature-catalog/02](feature-catalog/02-knowledge-rag.md); terms live
in the [glossary](glossary.md).

> The key point: on this path the gate is **deterministic code, not a model call**
> (`verifyGrounding`, `packages/agent-core/src/knowledge-recall.ts`). When retrieval evidence is
> weak or a citation is wrong, the answer is downgraded or dropped. This document does not claim
> that every uncited sentence of free-form chat is verified.

## The flow (the seven steps one question goes through)

```
question ─▶ ① retrieve ─▶ ② confidence ─▶ ③ draft ─▶ ④ four-criterion rubric
                                                        │
                                          ⑤ three-way verdict (fail-close)
                                          ├─ grounded   ─▶ ⑥ answer with citations (receipts)
                                          ├─ weak       ─▶ ⑥ framed as "I'm not sure"
                                          └─ ungrounded ─▶ ⑦ dropped (never leaves)
```

1. **Retrieve** — pull chunks close to the question out of the knowledge corpus (notes + tasks +
   calendar + memory + episodes …) by cosine similarity. Every chunk carries a source tag
   (`note/2026-06-01`, `task/42` …).
2. **Classify confidence** — `classifyRetrievalConfidence` assigns `confident` (1) / `ambiguous`
   (0.5) / `none` (0) from absolute cosine, CRAG-style. Threshold: `DEFAULT_CONFIDENT_AT`.
3. **Draft** — the local model writes a draft answer using *only the retrieved evidence*.
4. **Score the four-criterion rubric** (deterministic):
   - `confidence` — the retrieval confidence above.
   - `coverage` — the share of the answer's content tokens that actually appear in the evidence
     (floor `0.5`).
   - `answerability` — the share of the question's tokens the evidence covers (floor `0.34`).
   - `citationValidity` — whether the sources the answer cites were *actually retrieved* (a single
     forged citation fails immediately).
5. **Three-way verdict** (fail-close order, `knowledge-recall.ts`):
   1. retrieval `none` → **ungrounded** ("no evidence")
   2. a forged citation → **ungrounded** ("cited a source that was never retrieved")
   3. `coverage < 0.5` → **ungrounded** ("claim the evidence does not support")
   4. `confident` AND `answerability ≥ 0.34` → **grounded**
   5. otherwise → **weak**
6. **Present** — grounded answers ship with their citations (receipts). Weak answers are downgraded
   into an "I'm not sure" framing.
7. **Drop** — an ungrounded answer *is never emitted*. The invented answer does not reach the user.

## Example A — grounded (enough evidence → answer with citation)

- **Note** (`note/2026-06-10`): "Dentist appointment June 22, 3pm, White Dental in Gangnam."
- **Question**: "When was the dentist?"
- **Scoring**: retrieval confident, high coverage (the answer's "June 22, 3pm" is verbatim in the
  evidence), answerability met, citation valid → **grounded**.
- **Output**: "June 22 at 3pm, White Dental in Gangnam. [source: note/2026-06-10]"

## Example B — ungrounded (beyond the evidence → dropped)

- Same note, **question**: "What was the dentist's name?"
- **Scoring**: the evidence contains no *name*. Even if the model invents a plausible one,
  `coverage` falls below the floor → **ungrounded** ("claim the evidence does not support").
- **Output**: the invented name is **dropped**. Downgraded to "that isn't in your notes, so I'm not
  sure."

## The supporting layers under the gate (all deterministic, agent-core/recall)

- **best-of-N** (`selectBestGroundedDraft`) — among several drafts, only **grounded survivors** are
  eligible ("weak" is not) → a higher answer rate without fabrication. `muse ask --best-of`.
- **Sentence-level diagnosis** (`reportSentenceGroundedness`) — per-sentence supported/unsupported
  plus **polarity, numeric and hedge-overclaim** mismatch guards (token overlap alone misses a
  negation contradiction).
- **Chat-path parity** (`gateChatAnswer`) — the same gate on chat, plus citation precision/recall
  (ALCE), `untrustedOnly` (a warning when an answer rests solely on external `trusted:false`
  sources), and value-drift rejection (emails, IDs, IPs).
- **Reverification** (`verifyGroundingWithReverify`) — optional model-based k-sample
  self-consistency (unanimous PASS required).

## Why this is the edge (grounded ≠ true)

The gate checks *claim against source* — **not whether the source is true.** A poisoned note makes a
"confident grounded lie" possible (a known limit; see `grounded ≠ true` in the
[glossary](glossary.md)). That is why Muse *additionally* flags source trust (`trusted:false`),
contradictions between notes (`semanticConflict`) and value drift. Every new surface (recall,
proactivity, reflection, vision) has to pass under this gate, and the number of grounded surfaces
never decreases (release gate: `precheck:grounding`).
