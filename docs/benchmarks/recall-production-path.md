# Recall production-path evaluation

**COMPLETE** — local-live execution through `packages/recall/dist#prepareGroundedRecall`; zero generative requests.

| Model | Ordinary confident + correct | Absent abstention | Correction pair retained | Correction current top-1 |
| --- | ---: | ---: | ---: | ---: |
| nomic-embed-text | 17/20 | 10/20 | 0/20 | 0/20 |
| nomic-embed-text-v2-moe | 19/20 | 20/20 | 0/20 | 0/20 |
| embeddinggemma | 18/20 | 20/20 | 1/20 | 0/20 |
| qwen3-embedding:0.6b | 19/20 | 20/20 | 1/20 | 0/20 |

Production configuration: CLI default `topK=3`, `refineChunks=true`, real note files, v2 JSON + Float32 sidecar, two identical-condition trials per model.

Frozen synthetic v1 is not held-out or organic evidence. Repeats are collapsed. This does not improve the 10/11 agent aggregate.

**agent capability remains aggregate FAILED · organic effectiveness = NOT_PROVEN · generative requests = 0**
