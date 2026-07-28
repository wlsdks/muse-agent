# Muse evidence index

Muse keeps evidence classes separate because volume is not validity. A software test, a controlled synthetic replay, a local retrieval-component run, a live agent task, and an organic personal outcome answer different questions and must not be averaged into one score.

The README publishes exactly two qualified controlled charts: [`readme-qualified-grounding-v1.svg`](readme-qualified-grounding-v1.svg) and [`readme-controlled-scale-v1.svg`](readme-controlled-scale-v1.svg), both closed by the [README evidence manifest](readme-qualified-evidence-v1.json). Historical dashboard and diagnostic charts remain available as frozen snapshots—[`evidence-effect-deltas.svg`](evidence-effect-deltas.svg), [`evidence-coverage.svg`](evidence-coverage.svg), [`recall-production-path.svg`](recall-production-path.svg), [`recall-freshness-ablation.svg`](recall-freshness-ablation.svg), [`recall-candidate-pool.svg`](recall-candidate-pool.svg), and [`evidence-project-surface.svg`](evidence-project-surface.svg)—but are not promoted into the README. Their tracked JSON/SVG bytes are unchanged; this README refresh does not regenerate them or re-attest their historical source provenance, and they are not qualification inputs for the two README charts. Panels, denominators, evidence classes, and units are explicitly **not comparable / not aggregatable**.

| Evidence class | Current evidence | Status and boundary |
| --- | --- | --- |
| Software assurance | `pnpm check`, focused deterministic contracts, privacy and timeout mutation tests | Demonstrates implementation contracts. Test counts are not agent-effect proof. |
| Controlled / synthetic evidence | [Continuity provenance isolation](../evaluations/continuity-evidence-provenance-2026-07-18.md) and its deterministic controlled pairs | Validates evidence-class separation, not usefulness or organic behavior. |
| Controlled graph-operator replay | [AWG-030 exact change report](attunement-graph-awg-030.json) over the immutable [`continuity-change-v1`](../../packages/attunement-graph/benchmarks/continuity-change-v1.json) generator spec | **QUALIFIED component result:** flat and graph change detection precision/recall were both 1.0; graph exact full-path coverage was 1.0 versus flat 0.75. Nine controlled synthetic families, seven metric-eligible; vector not applicable and no model/embedding calls. The report binds both the immutable generator spec and the exact executed observations. Proves deterministic bounded path assembly only—not a Capsule, organic usefulness, or generic graph superiority. |
| Controlled synthetic scale | [1K → 1M corpus integrity](eval-datasets-scale-v1.md) ([JSON](eval-datasets-scale-v1.json), [CSV](eval-datasets-scale-v1.csv)) | **1,111,000/1,111,000** records generated, serialized, parsed, and schema-validated across 96 family × locale × complexity cells; **768/768** stratified records passed named public Muse seams. Proves streaming, isolation, and sampled boundary execution only—not 1.111M agent runs, personal learning, held-out generalization, human outcomes, or organic effectiveness. |
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

## Controlled synthetic scale contract

The versioned `@muse/eval-datasets` harness creates four independent fixed-seed corpora—1K, 10K, 100K, and 1M—over six semantic families, four locales, and four complexity levels. All **1,111,000** JSONL records must generate, serialize, parse, satisfy the closed schema, remain semantically disjoint across tiers, and keep the 96 cells balanced within one record. A deterministic two-per-cell sample executes **192 named public Muse seams per tier**, or **768 total**. The bulk corpus remains ignored local data; only the closed canonical [JSON](eval-datasets-scale-v1.json), byte-derived [CSV](eval-datasets-scale-v1.csv), and readable [Markdown](eval-datasets-scale-v1.md) are tracked.

This class is always `dataOrigin=synthetic`, `organicEvidence=false`, `personalLearningEligible=false`, `humanOutcome=false`, and `heldOut=false`. It makes zero LLM, tool, and network calls and requires owner `~/.muse` state to remain byte-stable. Reproduce and reconcile it with:

```sh
pnpm eval:data:scale
pnpm eval:data:scale:validate
```

The qualified run used 1,338,728,855 bulk bytes, peaked at 1,795,116,293 total bytes including temporary collision/index data, stayed below 512 MiB RSS at 429,572,096 bytes, and completed in 51,644 ms. After the generator-fixture correction, a separately accounted fixed fresh-seed replay passed 1,000/1,000 schema checks and 192/192 named public seams, then cleaned its local bulk. It remains `robustnessReplay=true`, `heldOut=false`, and outside the 1,111,000 totals. These resource, integrity, and repeatability results are infrastructure evidence, not a claim that Muse learned from or usefully answered personal interactions or generalized to held-out data.

## Candidate-pool diagnostic contract

The local-live [candidate-pool diagnostic](recall-candidate-pool.md) ([JSON](recall-candidate-pool.json), [CSV](recall-candidate-pool.csv), [SVG](recall-candidate-pool.svg)) reuses the accepted 60-entry corpus and the 20 correction cases, then measures pair retention and raw/Muse correction pass at topK 4, 8, and 12. A correction pass means **the pair was retained and the current source ranked top-1** under the shared terminal scorer. Four allowlisted local embedders run twice with one 80-text cache per model-trial. Repeats establish reliability and collapse to one observation set; they are not independent truth. The tracked outputs are promoted only after all four models reproduce the accepted top-4 per-model baseline. This diagnostic makes zero generative requests and cannot promote the failed 10/11 agent aggregate or organic effectiveness.
