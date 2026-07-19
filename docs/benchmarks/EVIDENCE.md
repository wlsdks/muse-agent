# Muse evidence index

Muse keeps evidence classes separate because volume is not validity. A software test, a controlled synthetic replay, a local retrieval-component run, a live agent task, and an organic personal outcome answer different questions and must not be averaged into one score.

The README retains exactly six charts: [`evidence-effect-deltas.svg`](evidence-effect-deltas.svg), [`evidence-coverage.svg`](evidence-coverage.svg), [`recall-production-path.svg`](recall-production-path.svg), [`recall-freshness-ablation.svg`](recall-freshness-ablation.svg), [`recall-candidate-pool.svg`](recall-candidate-pool.svg), and [`evidence-project-surface.svg`](evidence-project-surface.svg). Dashboard charts are rendered from the closed-schema [canonical evidence dashboard](evidence-dashboard.json); recall charts are rendered from their own canonical JSON. Panels, denominators, evidence classes, and units are explicitly **not comparable / not aggregatable**.

| Evidence class | Current evidence | Status and boundary |
| --- | --- | --- |
| Software assurance | `pnpm check`, focused deterministic contracts, privacy and timeout mutation tests | Demonstrates implementation contracts. Test counts are not agent-effect proof. |
| Controlled / synthetic evidence | [Continuity provenance isolation](../evaluations/continuity-evidence-provenance-2026-07-18.md) and its deterministic controlled pairs | Validates evidence-class separation, not usefulness or organic behavior. |
| Controlled local-model component | [Grounding delta](RESULTS.md) and [SQuAD slice](RESULTS-squad.md) | Same-model controlled corpora isolate the grounding gate's effect. These are not live personal retrieval or organic evidence. |
| Local-live retrieval component | [Recall freshness ablation](recall-freshness-ablation.md) ([JSON](recall-freshness-ablation.json), [CSV](recall-freshness-ablation.csv), [SVG](recall-freshness-ablation.svg)) | **UNCHANGED**: all four model deltas were 0. Both correction sources survived the raw top-4 in only 8/80 model-case observations; 72/80 were `PAIR_MISSING`, so MMR/retrieval pair retention—not stale reordering—was the measured bottleneck. Zero generative requests; not an agent evaluation. |
| Production-path recall component | [Production recall](recall-production-path.md) ([JSON](recall-production-path.json), [CSV](recall-production-path.csv), [SVG](recall-production-path.svg)) | Executes frozen synthetic v1 through `prepareGroundedRecall`. Correction pair retention is at most 1/20 per model and current top-1 is 0/20; not held-out, agent, or organic evidence. |
| Local-live agent capability | [11-axis qualified baseline](../development/agent-capability-baseline.md) | **10/11 axes passed, 1 failed, 0 unverified**. The aggregate remains failed; a component ablation cannot turn it into 11/11. |
| Organic personal effectiveness | Explicit real-user outcomes on consented personal use | **NOT_PROVEN**. No synthetic, controlled, component, or agent-capability count is promoted into this class. |

## Recall freshness A/B contract

The recall ablation compares `raw-retrieval` with `muse-freshness` on the same raw top-K for 60 versioned synthetic cases, four allowlisted local embedders, and two trials per model. The current qualified result is **UNCHANGED**: every model's correction delta is 0. Only **8/80** correction model-cases retained both current and stale sources in the diversified raw top-4; **72/80** were `PAIR_MISSING`. Because `demoteStale` only reorders retained candidates, it cannot repair a pair already removed by retrieval/MMR. Per-model and per-category non-regression is mandatory, so an average cannot hide a regression. Non-calibrated embedders use the conservative **0.55** fallback threshold.

The canonical JSON is the only truth; CSV, Markdown, and SVG are derived and reconciled by:

```sh
pnpm eval:recall-freshness-ablation
pnpm eval:recall-freshness-ablation:validate
```

Raw trial diagnostics are ignored local artifacts and are never published. The tracked result contains no prompts, outputs, paths, personal tokens, or organic evidence. Even an `IMPROVED` component result leaves the qualified live-agent baseline at **10/11**, and organic personal effectiveness at **NOT_PROVEN**.

## Candidate-pool diagnostic contract

The local-live [candidate-pool diagnostic](recall-candidate-pool.md) ([JSON](recall-candidate-pool.json), [CSV](recall-candidate-pool.csv), [SVG](recall-candidate-pool.svg)) reuses the accepted 60-entry corpus and the 20 correction cases, then measures pair retention and raw/Muse correction pass at topK 4, 8, and 12. A correction pass means **the pair was retained and the current source ranked top-1** under the shared terminal scorer. Four allowlisted local embedders run twice with one 80-text cache per model-trial. Repeats establish reliability and collapse to one observation set; they are not independent truth. The tracked outputs are promoted only after all four models reproduce the accepted top-4 per-model baseline. This diagnostic makes zero generative requests and cannot promote the failed 10/11 agent aggregate or organic effectiveness.
