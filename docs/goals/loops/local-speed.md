# Loop journal — `local-speed`

Theme: 로컬모델 속도/효율 라우팅(KV-quant env·cascade·spec-decode) — 정확성·grounding floor 보존.
Worktree `/tmp/muse-local-speed` · branch `loop/local-speed` · Tier2 push + 3-fire main merge.
Convention: [README](README.md).

## fire 1 · 2026-06-21 · local-speed · 5b6078cd
meta: value-class=new-capability · pkg=scripts(bench harness) · kind=measurement-infra · verdict=PASS · firesSinceDrill=1
ratchet: testFiles 1075 (+1 scripts node:test) · fabrication 0 · no eval delta (measurement substrate, no runtime touch)
- 무엇: `bench:local` 하니스 신설 — 로컬 Ollama 모델의 지연/처리량 반복측정 + 회귀-가드. 순수 코어 `scripts/lib/bench-metrics.mjs`(nsToMs·tokensPerSecond·sampleFromOllamaTimings·percentile·mean·summarizeSamples·detectRegression) + node:test 10케이스(`scripts/bench-metrics.test.mjs`, `self-eval:test` glob에 자동 편입) + 라이브 러너 `scripts/bench-local.mjs`(raw Ollama `/api/generate` stream:false, server-authoritative 타이밍, LOCAL-OLLAMA-ONLY skip). `package.json` "bench:local", 베이스라인 json gitignore.
- 왜: 스펙대로 "속도를 *측정*할 반복가능 bench가 아직 없으면 첫 슬라이스로 bench:local을 짓는다." 기존 `dogfood-local-llm.mjs`는 단발·수동·통계/회귀가드/테스트가능코어 없음 → 이후 속도 슬라이스(cascade·spec-decode·KV-quant)가 회귀-가드로 쓸 결정론 substrate가 필요. `detectRegression`이 그 게이트.
- 리뷰지점: 타이밍 단위(ns→ms÷1e6, tok/s=count/(ms/1000)), TTFT=load+prompt_eval, detectRegression drop/rise 방향 + base>0 가드(첫-실행 무-베이스라인 → 가짜 회귀 안 냄), percentile 보간 엣지(n=1/empty/p0/p100), 베이스라인 머신-특정 → gitignore.
- 리스크: 낮음 — 런타임/패키지 소스 0줄 변경(scripts/는 eslint-ignored, 어느 패키지에도 속하지 않음) → grounding/tool-selection 바이트 불변 → 정확성 회귀 0 by construction. 라이브 러너는 Ollama down 시 skip(exit 0, smoke:live 관례).
  검증: bench-metrics.test 10/10 + MUTATION-FIRST 2종(tok/s 공식·회귀 방향 반전 → RED, revert → green) · pnpm check rc=0(api 864 + cli 2857) · smoke:broad 51/0 · lint rc=0 · 독립 Opus ④ judge PASS(자체 mutation 재현, 결함 0).
  발견(backlog 기록): `scripts/reflection-guard.test.mjs`가 origin/main에서 pre-existing FAIL — `apps/cli/src/chat-repl.ts`의 false-done re-run 마커 `'const actNow'` 드리프트. 이 슬라이스와 무관(retry/reflection 표면 추가 없음) → 스코프 밖, backlog ◦.

## fire 2 · 2026-06-21 · local-speed · <commit>
meta: value-class=new-capability · pkg=@muse/model+@muse/autoconfigure · kind=adapter-wiring · verdict=PASS · firesSinceDrill=2
ratchet: pkg/kind DIFFERS from fire 1 (scripts/measurement-infra → model+autoconfigure/wiring) · fabrication 0 · default wire byte-identical
- 무엇: Ollama `num_batch`(프롬프트 처리 배치 크기, Ollama 기본 512) opt-in 배선 — 큰 배치 = 프롬프트-eval 처리량↑(긴 프롬프트의 지배적 지연). `MUSE_OLLAMA_NUM_BATCH` env → autoconfigure → `OllamaProvider({numBatch})` → native `/api/chat` `options.num_batch`. 어댑터가 검증 단일권위(>0·finite·trunc, 아니면 undefined→omit). 미설정 시 와이어 today와 바이트 동일.
- 왜: KV-quant(doctor가 이미 탐지/권고)·prefix-reuse(이미 출하) 다음의 미배선 어댑터 속도 레버. 백로그 line 2326 "10K-token prompt eval ≈ 40s"를 직접 공략. fire 1의 bench:local로 실측 가능(박스 Ollama up 시).
- 리뷰지점: opt-in 기본-off(정확성 회귀 0 by construction), num_batch는 처리량 노브지 샘플링 파라미터 아님(생성 토큰 불변), junk/0/neg/NaN env → omit(broken option 와이어 안 감), generate+stream 양 경로 동일(단일 buildNativeChatBody), 비-ollama 누수 없음.
- 리스크: 낮음 — 기본 경로 불변. 미실측 = 속도 win의 *크기*만 미지(슬라이스는 "측정된 숫자"가 아닌 "배선된 opt-in 레버"를 주장; 실측 튜닝은 backlog 후속).
  검증: model 366 pass + autoconfigure 622 pass · MUTATION-FIRST 2종(A: num_batch 절대-미방출→2 RED; B: 항상-512→5 RED 기존 와이어 스냅샷 포함; revert→green) · pnpm check rc=0(api 864 + cli 2857) · smoke:broad 51/0 · lint rc=0 · 독립 Opus ④ judge PASS(자체 mutation 재현, 전 edge값 omit 추적, 결함 0).
  형제-감사: num_thread/num_gpu(하드웨어-오프로드 노브)는 enumerate 후 backlog ◦ defer(하드웨어-특정·Ollama 자동탐지 보통 정확·박스별 bench 필요).
