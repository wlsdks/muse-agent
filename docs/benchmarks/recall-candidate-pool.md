# Recall candidate-pool diagnostic

**COMPLETE** — local-live retrieval component diagnostic; zero generative requests.

| Model | topK | Pair retained | Raw correction pass | Muse correction pass |
| --- | ---: | ---: | ---: | ---: |
| nomic-embed-text | 4 | 1/20 | 1/20 | 1/20 |
| nomic-embed-text | 8 | 8/20 | 6/20 | 6/20 |
| nomic-embed-text | 12 | 11/20 | 7/20 | 7/20 |
| nomic-embed-text-v2-moe | 4 | 5/20 | 4/20 | 4/20 |
| nomic-embed-text-v2-moe | 8 | 13/20 | 10/20 | 10/20 |
| nomic-embed-text-v2-moe | 12 | 17/20 | 13/20 | 13/20 |
| embeddinggemma | 4 | 1/20 | 1/20 | 1/20 |
| embeddinggemma | 8 | 6/20 | 5/20 | 5/20 |
| embeddinggemma | 12 | 13/20 | 10/20 | 10/20 |
| qwen3-embedding:0.6b | 4 | 1/20 | 1/20 | 1/20 |
| qwen3-embedding:0.6b | 8 | 5/20 | 5/20 | 5/20 |
| qwen3-embedding:0.6b | 12 | 12/20 | 10/20 | 10/20 |

**Correction pass = pair retained + current top-1 under the shared terminal scorer.**

Accounting: 480 raw rank calls · 644 total embedding requests (4 preflight + 640 benchmark) · 480 case-K trial observations · 960 arm verdicts.

This is a controlled local-live retrieval diagnostic over synthetic correction cases. Repeats prove reliability and are collapsed, not counted as independent truth. It does not improve the 10/11 agent aggregate and does not prove organic personal effectiveness.

**agent capability remains aggregate FAILED · organic effectiveness = NOT_PROVEN · generative requests = 0**
