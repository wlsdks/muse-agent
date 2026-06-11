# Agent-performance levers — ranked (fixed gemma4:12b, Ollama, local-only)

> Compiled 2026-06-10 from a web-grounded research pass (sources at each lever),
> cross-checked against the repo so already-built / already-rejected work is not
> re-derived. Ranked by impact × feasibility. Axes: **Q** quality/groundedness ·
> **T** one-shot tool-calling · **L** latency · **C** compounding on a fixed model.
> Standing constraints: local-only absolute; leaderboard-chasing rejected
> (2026-06-08); `format`+`tools` not composable on Ollama (#6002).

**Status 2026-06-10**: #1 SHIPPED (KO hit@1 50%→100%, default flipped + legacy migration) ·
#3 SHIPPED (doctor `ollama-perf` + stable-prefix prompt ordering) · #2 mechanism+A/B SHIPPED
(`selectToolExemplars`, eval:tools arm 14/14 — golden set saturated, production wiring gated
on real-trace failures).

| # | Lever | Axis | Feasibility today | Smallest verifiable slice |
|---|---|---|---|---|
| 1 | **Multilingual embedder default** — `nomic-embed-text`(v1, EN-centric)이 한국어 질의의 조용한 recall 천장; `nomic-embed-text-v2-moe`/`embeddinggemma`/`qwen3-embedding` 후보 | Q (대) | High — embed.ts는 모델 파라미터화 끝; 인덱스 재임베드 1회 | KO 10케이스 recall셋 + grounding 배터리 A/B, pass^3 측정승격 |
| 2 | **Few-shot tool exemplars from labeled traces** — 유사한 과거 성공 tool-call 2-3개를 프롬프트에 주입 (LangChain 16%→52%; arXiv 2508.15214) | T+C (대) | High — trace 라벨(6/10 출하)+embed 재사용; 컨텍스트 예산 주의 | confusable 시간도구 1패밀리만, eval:tools REPEAT=3 전후 비교 |
| 3 | **KV quant + flash attention + stable-prefix 프롬프트 순서** — `OLLAMA_FLASH_ATTENTION=1`, `KV_CACHE_TYPE=q8_0`; 안정 부분(시스템/도구)을 앞에, 휘발 부분(시간/노트)을 뒤에 → prefill 재사용 | L (중대) | High — env+순서 감사; 코드 리스크 0 | REPL 2턴째 TTFT 측정 + doctor posture 체크 |
| 4 | **Local cross-encoder reranking top-K** (qwen3-reranker/bge-v2-m3 류) | Q (중대) | Medium — Ollama에 rerank API 없음(yes/no 로짓 우회, K≤8) | ask recall에 플래그 rerank-top-8, 배터리 A/B |
| 5 | **`format` 스키마 구속을 모든 judge/분류기 경로로 확장** (reverify verdict, llmJudge, polarity, preference) — 4/~7 경로 이미 적용 중 | Q (중) | High — 인-레포 패턴 복제 | reverify judge에 responseFormat + malformed 회귀 테스트 |
| 6 | **Error-analysis 플라이휠** — 라벨된 실패 클러스터→Pareto가 일을 고름 (문헌상 최대 단일 레버) | C (대) | 연료 게이트 — ~20-30 라벨 실패 모일 때까지 보류(기록된 기각) | grounded 라벨 카운트-by-surface 출력 스크립트, 첫 20개 손으로 읽기 |
| 7 | **Tool-selection self-consistency 투표** (k=3, 에스컬레이션 시에만; 이름은 이산값이라 exact-vote) | T (중) | High — --best-of 패턴의 도구 경계 적용 | 시간도구 confusable셋에 플래그 투표, eval:tools Δ |
| 8 | **Speculative decoding (gemma4 MTP, Ollama PR #15980, MLX)** — `DRAFT` Modelfile, `--experimental` | L (중, 실험) | Medium — 머지됐으나 실험 플래그; int4 이득 불확실 | DRAFT 변형 빌드, muse ask ×10 벽시계 비교, 이득 시만 채택 |
| 9 | **REPL 질의 재작성 후 검색** (Rewrite-Retrieve-Read; HyDE는 의도적 제외 — 12B 가짜 토큰을 게이트 상류에 주입) | Q (중) | High — 구속 호출 1회 추가 | /recall류 턴에 플래그, KO 멀티턴 10케이스 A/B |
| 10 | **반복 의도의 결정론 코드 증류** (resolveRelativeTimePhrase 패턴의 일반화; 12-Factor) | L+C (중) | High — 패턴 3회 이상 출하됨; #6 데이터 필요 | 최빈 결정론 의도 1개에 파서 fast-path + 터미널 테스트 |
| 11 | **Plan-cache 유사도 Jaccard→임베딩** (한국어 조사에 약함) | C (소) | High — playbook ranker가 인-레포 템플릿 | 패러프레이즈 쌍 단위테스트 + 스왑 |
| 12 | **문장단위 groundedness 라벨** (ADK hallucinations_v1; 이미 backlog ◦) | Q-측정 (소중) | High — 루브릭 재사용, eval-시간 비용만 | eval:self-improving 리포트에 문장 verdict만 추가 |

## Sources (primary)

- Ollama: [structured outputs](https://ollama.com/blog/structured-outputs) · [FAQ/KV](https://docs.ollama.com/faq) · [PR #15980 MTP](https://github.com/ollama/ollama/pull/15980) · blocker [#6002](https://github.com/ollama/ollama/issues/6002)
- [smcleod — K/V context quantisation](https://smcleod.net/2024/12/bringing-k/v-context-quantisation-to-ollama/)
- [LangChain — few-shot tool-calling](https://www.langchain.com/blog/few-shot-prompting-to-improve-tool-calling-performance) · [arXiv 2508.15214](https://arxiv.org/pdf/2508.15214)
- Self-consistency: [arXiv 2502.18581](https://arxiv.org/pdf/2502.18581) · [arXiv 2505.10772](https://arxiv.org/abs/2505.10772)
- [arXiv 2305.14283 — Query Rewriting for RAG](https://arxiv.org/abs/2305.14283)
- Embedders/rerankers: [nomic-embed-text-v2-moe](https://ollama.com/library/nomic-embed-text-v2-moe) · [qwen3 reranker on Ollama](https://www.glukhov.org/rag/embeddings/qwen3-embedding-qwen3-reranker-on-ollama/) · [BentoML guide](https://www.bentoml.com/blog/a-guide-to-open-source-embedding-models)
- Method: [Hamel Husain — evals](https://hamel.dev/blog/posts/evals/) · [12-Factor Agents](https://github.com/humanlayer/12-factor-agents) · [Google ADK criteria](https://google.github.io/adk-docs/evaluate/)
