# Frontier research pass — 2026-06-10 (3-track, fresh)

> Jinan's ask: "아예 새롭게 탐구해서 — 논문 포함 — 에이전트 성능을 올릴 것들; 코드 개선인지
> 알고리즘 개선인지 분류". Three parallel web-grounded tracks, deduped against
> [`agent-performance-levers.md`](agent-performance-levers.md), the backlog, and the
> cross-field catalog. Every citation fetch-verified by the researching agent.
>
> **Headline unlock (re-verified first-hand on this machine):** Ollama 0.30.6's native
> `/api/generate`·`/api/chat` return `logprobs` + `top_logprobs(≤20)` for gemma4:12b —
> token-level confidence is NO LONGER BLOCKED. (Caveat reproduced live: gemma4 emits
> `<|channel>` marker tokens; scorers must exclude them / run through the adapter's
> think-off path. OpenAI-compat endpoint still lacks them — irrelevant, Muse uses native.)

## 통합 톱 12 (impact × feasibility × Muse-edge fit)

| # | 후보 (트랙) | 분류 | 한 줄 | 첫 슬라이스 비용 |
|---|---|---|---|---|
| 1 | **Logprob 신뢰도 계측** (T3) | 코드 90% | 모든 답에 mean/min 토큰 logprob를 trace 라벨 옆에 기록 — 게이트의 두 번째 독립 축이자 #3/#7의 연료 | S — 어댑터 필드+순수 집계, 행동 무변경 |
| 2 | **BM25 하이브리드 (+Contextual Retrieval)** (T1) | 알고리즘+코드 | 검색 실패 −49%(Anthropic 측정); BM25 슬라이스는 추론 0회 — ID/에러코드류 exact-string 질의를 임베딩이 놓치는 갭 | S~M — 어휘 인덱스+RRF, embedder-ab 코퍼스로 A/B |
| 3 | **KnowNo conformal 도구 선택** (T3) | 알고리즘 | 도구 선택을 MCQA logprob + conformal set으로 — set>1이면 추측 대신 되묻기 (통계적 보장; 도움 요청 10-24%↓) | S — 오프라인: eval:tools 84케이스 캘리브레이션 리포트만 |
| 4 | **ACT-R base-level activation** (T2) | 알고리즘 | 회상 랭킹을 recency 단일 반감기 → 빈도×간격 활성화 `ln(Σt⁻ᵈ)`로 — "다음에 필요할 확률"의 실제 인지과학 모델 | S — 접근 로그는 이미 있음, 닫힌형 수식 |
| 5 | **ACE 결정론 플레이북 델타-머지** (T1) | 코드 | LLM 재작성 머지의 "context collapse"를 비-LLM 델타 머지로 제거 (+10.6% AppWorld); Muse 2번째 기둥 보호 | M — anti-collapse 불변식 단위테스트 포함 |
| 6 | **Sleep-time compute** (T1) | 코드 | 유휴 시간에 인용-포함 컨텍스트 브리프 사전계산 → test-time ~5× 절감; loop-v2 Sleep 데몬 설계의 실행 | M — 브리프의 모든 주장이 게이트 통과 필수 |
| 7 | **Discrete semantic entropy** (T3) | 알고리즘 | 경계 밴드에서 k≈5 샘플→함의 클러스터→엔트로피 (Nature 2024, 토큰확률 불필요) — 유창한 confabulation 검출 | M — 오프라인 AUROC 배터리 먼저 |
| 8 | **Mem0-식 UPDATE/dedup 통합** (T1) | 알고리즘+코드 | append-only 메모리에 supersede/dedup 연산 — 낡은 사실 인용(grounded lie 벡터) 제거; p95 −91% | M — UPDATE op만 먼저, 터미널-상태 테스트 |
| 9 | **Bayesian surprise + SDT 알림 기준** (T2) | 알고리즘 | 다이제스트는 "믿음을 바꾼 것"(KL) 순으로, 알림 임계는 사용자의 무시/수용 베이스레이트로 자동 조정 | S — 둘 다 닫힌형, action-log가 데이터 |
| 10 | **AWM 워크플로 채굴** (T1) | 알고리즘+코드 | 성공 trace에서 멀티스텝 도구 루틴을 템플릿화해 재주입 (+24.6~51.1% 웹에이전트) — trace 라벨 연료 필요 | M — 연료 게이트 (exemplar 배선과 동일) |
| 11 | **Reflection-schedule guard** (T1) | 코드 | "검증자 없는 reflection은 85.36% 같은 실수 반복"(2510.18254)을 정책+테스트로 고정 — 모든 재시도 루프에 검증자 필수 | S — 콜사이트 열거 테스트 1개 |
| 12 | **Conformal factuality back-off** (T3) | 알고리즘 | 문장단위 conformal 드롭 — 전체 거절 대신 못 받친 문장만 제거 (90% 사실성 보장, ICML 2024); per-sentence 라벨링 선행 필요 | L — 체인: backlog의 hallucinations_v1 뒤 |

**차단 기록 (재유도 방지)**: Semantic Entropy Probes·DoLa·contrastive decoding — hidden
states/디코딩 개입이 필요한데 Ollama는 관측용 logprobs만 노출 (인프라 교체 전 불가).
가장 가까운 우회: llama.cpp server / MLX (Apple-Silicon opt-in 경로).

## 코드 vs 알고리즘 — 분류 답

- **코드(하네스) 개선이 정답인 것**: logprob 계측(#1), ACE 머지(#5), Sleep 데몬(#6),
  reflection guard(#11), Zeigarnik/peak-end 멀티플라이어(T2-6·7), newsvendor 버퍼(T2-4).
  공통점: 결정론 코드가 모델의 약점을 우회하거나 봉인.
- **알고리즘 개선이 정답인 것**: ACT-R(#4), BM25/RRF(#2), conformal set(#3), semantic
  entropy(#7), MBR 합의 선택(T3-5), Bayesian surprise/SDT(#9), Mem0 ops(#8), Kalman(T2-5).
  공통점: 닫힌형 수식/통계 — 학습 불필요, 고정 모델 위에서 성립.
- **모델/인프라 한계라 지금 불가**: SEPs, DoLa, contrastive, grammar+tools(#6002).

## Track outputs (full)

The three ranked track lists (with measured numbers, verified links, smallest slices,
honest blockers) are preserved verbatim in the session record and summarized above;
key sources:

- T1 아키텍처: [ACE 2510.04618](https://arxiv.org/abs/2510.04618) · [Contextual Retrieval](https://www.anthropic.com/news/contextual-retrieval) · [Sleep-time 2504.13171](https://arxiv.org/abs/2504.13171) · [AWM 2409.07429](https://arxiv.org/abs/2409.07429) · [Mem0 2504.19413](https://arxiv.org/abs/2504.19413) · [A-MEM 2502.12110](https://arxiv.org/abs/2502.12110) · [DRAFT 2410.08197](https://arxiv.org/abs/2410.08197) · [HippoRAG2 2502.14802](https://arxiv.org/abs/2502.14802) · [TreeSearch 2407.01476](https://arxiv.org/abs/2407.01476) · [Illusions of Reflection 2510.18254](https://arxiv.org/pdf/2510.18254)
- T2 타분야: Anderson&Schooler 1991 (ACT-R) · Green&Swets 1966 (SDT) · [Itti&Baldi 2009 Bayesian surprise](http://ilab.usc.edu/publications/doc/Itti_Baldi09vr.pdf) · Arrow-Harris-Marschak 1951 (newsvendor) · Kalman 1960 · Redelmeier&Kahneman 1996 (peak-end) · Zeigarnik 1927 · Laibson 1997 (β–δ)
- T3 불확실성: [Ollama api logprobs](https://pkg.go.dev/github.com/ollama/ollama/api) · [Semantic entropy, Nature 2024](https://pubmed.ncbi.nlm.nih.gov/38898292/) · [KnowNo 2307.01928](https://arxiv.org/abs/2307.01928) · [Conformal factuality 2402.10978](https://arxiv.org/abs/2402.10978) · [CoCoA 2502.04964](https://arxiv.org/html/2502.04964v3) · [UniCR 2509.01455](https://arxiv.org/pdf/2509.01455) · [Verbalized confidence 2412.14737](https://arxiv.org/pdf/2412.14737)
