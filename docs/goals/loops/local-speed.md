# Loop journal — `local-speed`

Theme: 로컬모델 속도/효율 라우팅(KV-quant env·cascade·spec-decode) — 정확성·grounding floor 보존.
Worktree `/tmp/muse-local-speed` · branch `loop/local-speed` · Tier2 push + 3-fire main merge.
Convention: [README](README.md).

## fire 1 · 2026-06-21 · local-speed · <commit>
meta: value-class=new-capability · pkg=scripts(bench harness) · kind=measurement-infra · verdict=PASS · firesSinceDrill=1
ratchet: testFiles 1075 (+1 scripts node:test) · fabrication 0 · no eval delta (measurement substrate, no runtime touch)
- 무엇: `bench:local` 하니스 신설 — 로컬 Ollama 모델의 지연/처리량 반복측정 + 회귀-가드. 순수 코어 `scripts/lib/bench-metrics.mjs`(nsToMs·tokensPerSecond·sampleFromOllamaTimings·percentile·mean·summarizeSamples·detectRegression) + node:test 10케이스(`scripts/bench-metrics.test.mjs`, `self-eval:test` glob에 자동 편입) + 라이브 러너 `scripts/bench-local.mjs`(raw Ollama `/api/generate` stream:false, server-authoritative 타이밍, LOCAL-OLLAMA-ONLY skip). `package.json` "bench:local", 베이스라인 json gitignore.
- 왜: 스펙대로 "속도를 *측정*할 반복가능 bench가 아직 없으면 첫 슬라이스로 bench:local을 짓는다." 기존 `dogfood-local-llm.mjs`는 단발·수동·통계/회귀가드/테스트가능코어 없음 → 이후 속도 슬라이스(cascade·spec-decode·KV-quant)가 회귀-가드로 쓸 결정론 substrate가 필요. `detectRegression`이 그 게이트.
- 리뷰지점: 타이밍 단위(ns→ms÷1e6, tok/s=count/(ms/1000)), TTFT=load+prompt_eval, detectRegression drop/rise 방향 + base>0 가드(첫-실행 무-베이스라인 → 가짜 회귀 안 냄), percentile 보간 엣지(n=1/empty/p0/p100), 베이스라인 머신-특정 → gitignore.
- 리스크: 낮음 — 런타임/패키지 소스 0줄 변경(scripts/는 eslint-ignored, 어느 패키지에도 속하지 않음) → grounding/tool-selection 바이트 불변 → 정확성 회귀 0 by construction. 라이브 러너는 Ollama down 시 skip(exit 0, smoke:live 관례).
  검증: bench-metrics.test 10/10 + MUTATION-FIRST 2종(tok/s 공식·회귀 방향 반전 → RED, revert → green) · pnpm check rc=0(api 864 + cli 2857) · smoke:broad 51/0 · lint rc=0 · 독립 Opus ④ judge PASS(자체 mutation 재현, 결함 0).
  발견(backlog 기록): `scripts/reflection-guard.test.mjs`가 origin/main에서 pre-existing FAIL — `apps/cli/src/chat-repl.ts`의 false-done re-run 마커 `'const actNow'` 드리프트. 이 슬라이스와 무관(retry/reflection 표면 추가 없음) → 스코프 밖, backlog ◦.
