# CRAG for Muse — confidence-gated knowledge retrieval

Status: design / approved-direction (scope: verdict + graded framing, no web)
Date: 2026-05-28
Paper: Corrective Retrieval-Augmented Generation (CRAG), arXiv 2401.15884
(ICLR 2024) — a lightweight retrieval evaluator scores retrieved
evidence as correct / ambiguous / incorrect and frames/corrects
accordingly instead of trusting every retrieval.

## Why (honest scope)

`rankKnowledgeChunks` ALREADY drops sub-threshold chunks via a
per-chunk cosine floor (`minScore`, default 0.1) — so CRAG's
"incorrect → drop the junk chunk" baseline is partly covered. The
genuinely-missing piece is a **graded confidence verdict**: today a
chunk at cosine 0.12 clears the floor and is injected under the
confident framing "Relevant passages — cite the [source]", which tells
the small local model to TRUST weak grounding (exactly CRAG's failure
mode). There is no "ambiguous" tier.

This slice adds the verdict and frames retrieval by it. The web-search
corrective fallback (CRAG's other half) is DEFERRED — it adds a model
round (costly/less-reliable on the local Qwen) and is a separate slice.

## Constraints honoured

- Deterministic, local, no new dep, NO extra model round.
- Cited in code (CRAG, arXiv 2401.15884) + in the CAPABILITIES line.
- Threshold calibrated on real nomic-embed evidence (like the P24-2 MMR
  λ calibration), not guessed.

## Key wrinkle

In **hybrid** mode `KnowledgeMatch.score` is the RRF-fused (rank-based)
score, ~0.01–0.03 — NOT an absolute relevance. The confidence verdict
needs the absolute cosine of the top match, so we surface it
separately.

## Design

1. **`KnowledgeMatch.cosine?`** (agent-core, `knowledge-recall.ts`):
   optional absolute cosine, populated in BOTH paths — hybrid
   (`cosByKey`) and cosine (where `score` already IS the cosine).
   Back-compat (optional).

2. **`classifyRetrievalConfidence(matches, options?)`** → `"confident"
   | "ambiguous" | "none"`:
   - `none` when empty.
   - else `top = max(m.cosine ?? m.score)`.
   - `confident` when `top >= confidentAt` (default calibrated, ~0.45);
     else `ambiguous`.

3. **`renderKnowledgeMatches`** picks the header by verdict:
   - confident → "Relevant passages — cite the [source] you use:"
     (today's framing).
   - ambiguous → "Possibly-related passages (LOW confidence — verify
     before relying; do not cite as established fact):".
   - none (empty) → "No matching passages found in the personal
     corpus." (today's empty behaviour).
   Passage list unchanged (`reorderForLongContext`). Covers the agent
   `knowledge_search` tool and the notes corpus-search tool, which both
   render through this function.

4. **`createKnowledgeEnricher`** (autoconfigure): emit the ambient /
   briefing "Related:" line ONLY when the verdict is `confident` —
   weak grounding should not ride into ambient notices. (Returns
   undefined otherwise.)

Out of scope this slice: the `muse ask` inline notes block (separate
self-assembled rendering — a follow-up), and the web-search corrective
fallback.

## Verification

- `knowledge-recall.test.ts`: `cosine` populated in both paths;
  `classifyRetrievalConfidence` none/ambiguous/confident by top cosine;
  `renderKnowledgeMatches` header changes by verdict (and stays
  citation-framed when confident).
- `knowledge-recall-sources.test.ts` (autoconfigure): enricher returns
  undefined when only weak (ambiguous) matches exist; a strong match
  still yields the Related line.
- **Live calibration (done) — honest finding.** Measured on real
  nomic-embed-text. Realistic personal corpus: query "what did I say
  about the Q3 budget?" → relevant note **0.61**, personal distractors
  (dentist / gift / car-insurance) **0.44–0.51**. So `confidentAt =
  0.55` splits them. BUT nomic's cosine space is COMPRESSED: even an
  unrelated encyclopedic fact ("capital of France is Paris") scored
  ~0.54, and Muse embeds raw text (no `search_query:` / `search_document:`
  prefixes). So this is a **best-effort** low-confidence flag — it
  correctly down-frames weak PERSONAL grounding, but it is NOT a hard
  relevant/irrelevant separator and absolute thresholding is fragile
  (same honesty class as the P24-2 MMR "best-effort nudge"). Default
  `0.55`; tune via the function option if a corpus needs it.
- Gates: `pnpm --filter @muse/agent-core test`, autoconfigure test,
  `pnpm lint`.

## CAPABILITIES.md line (on delivery)

`- [Knowledge] knowledge_search grades retrieval confidence and frames
weak grounding as low-confidence instead of telling the model to cite
it (CRAG, arXiv 2401.15884) — classifyRetrievalConfidence over the top
absolute cosine; renderKnowledgeMatches + the ambient enricher gate on
it — knowledge-recall.test.ts + knowledge-recall-sources.test.ts —
research-applied slice`
