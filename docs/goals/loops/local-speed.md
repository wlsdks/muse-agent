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

## fire 2 · 2026-06-21 · local-speed · dc6b7472
meta: value-class=new-capability · pkg=@muse/model+@muse/autoconfigure · kind=adapter-wiring · verdict=PASS · firesSinceDrill=2
ratchet: pkg/kind DIFFERS from fire 1 (scripts/measurement-infra → model+autoconfigure/wiring) · fabrication 0 · default wire byte-identical
- 무엇: Ollama `num_batch`(프롬프트 처리 배치 크기, Ollama 기본 512) opt-in 배선 — 큰 배치 = 프롬프트-eval 처리량↑(긴 프롬프트의 지배적 지연). `MUSE_OLLAMA_NUM_BATCH` env → autoconfigure → `OllamaProvider({numBatch})` → native `/api/chat` `options.num_batch`. 어댑터가 검증 단일권위(>0·finite·trunc, 아니면 undefined→omit). 미설정 시 와이어 today와 바이트 동일.
- 왜: KV-quant(doctor가 이미 탐지/권고)·prefix-reuse(이미 출하) 다음의 미배선 어댑터 속도 레버. 백로그 line 2326 "10K-token prompt eval ≈ 40s"를 직접 공략. fire 1의 bench:local로 실측 가능(박스 Ollama up 시).
- 리뷰지점: opt-in 기본-off(정확성 회귀 0 by construction), num_batch는 처리량 노브지 샘플링 파라미터 아님(생성 토큰 불변), junk/0/neg/NaN env → omit(broken option 와이어 안 감), generate+stream 양 경로 동일(단일 buildNativeChatBody), 비-ollama 누수 없음.
- 리스크: 낮음 — 기본 경로 불변. 미실측 = 속도 win의 *크기*만 미지(슬라이스는 "측정된 숫자"가 아닌 "배선된 opt-in 레버"를 주장; 실측 튜닝은 backlog 후속).
  검증: model 366 pass + autoconfigure 622 pass · MUTATION-FIRST 2종(A: num_batch 절대-미방출→2 RED; B: 항상-512→5 RED 기존 와이어 스냅샷 포함; revert→green) · pnpm check rc=0(api 864 + cli 2857) · smoke:broad 51/0 · lint rc=0 · 독립 Opus ④ judge PASS(자체 mutation 재현, 전 edge값 omit 추적, 결함 0).
  형제-감사: num_thread/num_gpu(하드웨어-오프로드 노브)는 enumerate 후 backlog ◦ defer(하드웨어-특정·Ollama 자동탐지 보통 정확·박스별 bench 필요).

## fire 3 · 2026-06-21 · local-speed · 3a038607
meta: value-class=new-capability · pkg=@muse/multi-agent · kind=cascade-routing(paper) · verdict=PASS · firesSinceDrill=3
ratchet: pkg/kind DIFFERS (scripts/infra → model/adapter → multi-agent/cascade) · fabrication 0 · 기본경로 byte-identical
- 무엇: FrugalGPT(arXiv:2305.05176) 캐스케이드 escalation 결정 프리미티브 C1. `shouldEscalateToHeavy(confidence, threshold=-1.0)` + `DEFAULT_CASCADE_ESCALATE_LOGPROB`(@muse/multi-agent tiering.ts) + `planTieredRun`에 optional `priorConfidence?: ReadonlyMap<id, number|undefined>`/`escalateThreshold` — fast로 분류됐고 priorConfidence에 존재하며 fast-pass mean-logprob이 낮은 task를 heavy로 escalate(plan assignment = 실제 terminal state 변화). confidence=mean token logprob(≤0, 높을수록 자신감), undefined/NaN/-Inf → escalate(안전방향, classifyTier의 default-to-heavy 미러).
- 왜: 기존 classifyTier는 텍스트로 tier를 *사전*결정만(lexical) — fast 답이 약해도 그대로 수용. 진짜 cascade(빠른모델 먼저→약하면 heavy로 승급)가 빠진 레버. summarizeTokenConfidence(@muse/agent-core)가 이미 confidence를 계산하지만(commands-ask.ts:2870) escalation 결정엔 안 씀 → 그 갭. 런타임 two-pass(C2)+실측(C3)은 backlog로 decompose(DECOMPOSE-ON-DEFER, 쉬운 걸로 안 내려감).
- 리뷰지점: 기본(priorConfidence 없음)=plan byte-identical(`.has(id)===true` 가드), heavy task는 절대 de-escalate 안 함(`tier==="fast"` 가드), classifyTier 불변(const→let만), 패키지 결합 없음(plain number, agent-core 타입 import 안 함), strict `<`(정확히 -1.0은 escalate 안 함).
- 리스크: 낮음 — 행동 inert by default. C1은 실제 planner(planTieredRun, apps/api multi-agent-routes.ts:460 호출)에 배선된 행동변화지 dead primitive 아님(④ judge가 declaration-only 아님으로 명시 판정). C2가 priorConfidence를 실제 logprob으로 채우는 런타임 루프.
  검증: multi-agent 215 pass · MUTATION-FIRST 2종(A: `<`→`>` 5 RED; B: `.has` 가드→`!==undefined` ABSENT-untouched 1 RED; revert→green) · pnpm check rc=0(api 880 + cli 2857; 첫 run의 messaging-webhooks 1-FAIL은 병렬 env-leak flake = isolated 880/880 + 내 변경은 api/messaging 무관, rerun rc=0) · smoke:broad 51/0 · lint rc=0 · 독립 Opus ④ judge PASS(자체 mutation 재현, declaration-only crux HONEST 판정, 결함 0).

## fire 4 · 2026-06-21 · local-speed · b60fbebb
meta: value-class=micro-fix · pkg=apps/cli · kind=correctness-hardening(doctor) · verdict=PASS · firesSinceDrill=4
ratchet: pkg/kind DIFFERS (scripts/infra → model/adapter → multi-agent/cascade → cli/correctness) · fabrication 0 · 런타임 무변경(doctor advisory string only)
- 무엇: `muse doctor`의 `ollamaPerfPostureCheck` 하드닝 — 양자화 KV 캐시(`OLLAMA_KV_CACHE_TYPE=q8_0/q4_0`)가 `OLLAMA_FLASH_ATTENTION=1` 없이는 **INERT**(Ollama가 조용히 f16 KV로 폴백, 이득 0)임을 전용 WARN으로 명시. 기존엔 (kv설정·flash꺼짐) 케이스가 일반 "set flash" 메시지로 떨어져 사용자의 KV 설정이 *아무것도 안 하고 있다*는 걸 숨겼음.
- 왜: 실제 silent 오설정 갭(ollama/ollama#13337이 "server silently falls back to f16 → 예상외 OOM"으로 제기). KV-quant는 named 레버. 출처검증(verify-then-apply): Opus scout가 Ollama FAQ + PR #6279(smcleod.net) + #13337로 확인 — KV-quant는 flash attention AND FA-capable 모델 arch 필요. 경고는 "needs a flash-attention-capable model"로 arch nuance 정직히 커버, 버전-취약 allowlist는 하드코딩 안 함(backlog defer).
- 리뷰지점: 4 케이스 분기 정확(flash+kv=ok / 둘다없음=set both / flash만=set KV(FLASH 미포함) / kv만=신규 INERT), `.toLowerCase()`로 "Q4_0" 처리, FA-capable-model 미달 케이스(flash+kv+non-FA-model→"ok"이나 실제 inert)는 backlog ◦ defer(런타임 arch-query 필요, 하드코딩 금지).
- 리스크: 없음 — doctor advisory string 한 케이스만 변경, 모델/런타임/grounding/tool 경로 무관 → 정확성 회귀 0 trivially.
  검증: cli 2861 pass(신규 2 OUTCOME 케이스) · MUTATION-FIRST(INERT 분기 제거 → 2 RED "expected … to contain INERT"; revert→green) · pnpm check rc=0(api 887 + cli 2861) · smoke:broad 51/0 · lint rc=0 · 독립 Opus ④ judge PASS(사실주장 정확성 웹검증 재확인, 자체 mutation 재현; 중복주석 결함 1건 지적 → 수정 완료).
  형제-감사: Muse-process 속도 env(MUSE_OLLAMA_NUM_BATCH 등) doctor 노출 + FA-capable-model-arch 경고 → backlog ◦ 2건.

## fire 5 · 2026-06-21 · local-speed · fe634ab8
meta: value-class=new-capability · pkg=@muse/multi-agent · kind=cascade-execution · verdict=PASS · firesSinceDrill=5
ratchet: (multi-agent, cascade) 2/5 fires, distinct kind from fire 3 (decision→execution) · fabrication 0 · additive(in-repo caller 0)
- 무엇: FrugalGPT 캐스케이드 EXECUTION 프리미티브 `runCascade<T>({fast,heavy,run,confidenceOf,threshold})` → `{result,tier,escalated,fastConfidence}` (@muse/multi-agent cascade-run.ts). fast 모델 먼저 실행 → confident면 그 답 수용(모델 1회 실행 = 지연 win), low/측정불가 confidence면 heavy로 ONCE escalate. 단일 escalation 바운드(루프 없음, MAST step-repetition/termination 가드). fire 3의 `shouldEscalateToHeavy` 재사용.
- 왜: fire 3은 cascade DECISION(승급 여부)+planner 배선이었고, 이건 그 결정을 실제 compute 절약으로 바꾸는 EXECUTION(confident lookup는 heavy 값 안 치름). model-agnostic = caller가 run/confidenceOf 주입(이 패키지 idiom: summarizeWorkerOutput/verifyFinalAnswer/detectConflicts 전부 주입식). 실제 model-run+summarizeTokenConfidence 주입은 C2b(autoconfigure, backlog).
- 리뷰지점: confident→run 1회만(`calls).toEqual([fast])`로 효율 주장 직접 검증), low→[fast,heavy] 순서·heavy 결과, 둘다-low여도 정확히 2회(재승급 없음), strict `<`(정확히 -1.0 keep), additive(tiering.ts 무변경, index.ts export 2줄만).
- 리스크: 없음 — 신규·in-repo 호출자 0 → 기존 행동 무변경 → 정확성 회귀 0 by construction. 정직한 한계: capability 출하지 *측정된* 지연 win 아직 아님(C2b/C3에서; backlog 명기).
  검증: multi-agent 221 pass(신규 5 OUTCOME 케이스, run-count/order/result 채점) · MUTATION-FIRST(게이트 `!` 반전 → 5/5 RED; revert→green) · pnpm check rc=0(api 887 + cli 2861) · smoke:broad 51/0 · lint rc=0 · 독립 Opus ④ judge PASS(declaration-only crux=NOT declaration-only 명시 판정, 자체 mutation 재현, 무루프 grep 확인, ratchet 2/5 OK, 결함 0).
  decompose: C2-core DONE; C2b(autoconfigure가 real run+confidenceOf를 ask --tiered/orchestration에 주입) + C3(live eval) backlog 잔존.

## fire 6 · 2026-06-21 · local-speed · 4ef37893
meta: value-class=new-capability · pkg=apps/cli · kind=doctor-discoverability · verdict=PASS · firesSinceDrill=6
ratchet: cli 2/6 (fire 4 correctness-hardening vs fire 6 capability, distinct kind) · fabrication 0 · advisory-only 무런타임변경
- 무엇: `muse doctor`에 `museSpeedEnvCheck`+`readMuseSpeedEnv`(apps/cli) 신설 배선 — Muse-PROCESS 속도 env(`MUSE_OLLAMA_NUM_BATCH` fire-2 레버·`MUSE_OLLAMA_NUM_CTX`·`MUSE_OLLAMA_KEEP_ALIVE`) 포스처를 매 doctor 실행마다 보고 + num_batch 미설정 시 구체 튜닝 힌트. `ollamaPerfPostureCheck`(서버 launchctl env)와 구분되는 별도 표면.
- 왜: fire 2가 num_batch 레버를 출하했지만 아무 데서도 사용자에게 안 알려줌 = 절반만 배달. doctor가 Muse 속도 포스처를 알리는 곳 → 레버 discoverable화. merge fire라 cascade C2b(live ask-path 배선, multi-fire·Ollama-gated)를 또 dead layer로 쌓는 대신 완결·무-dead-layer 슬라이스 선택(fire 5 judge가 runCascade 무-호출자 지적한 것 회피).
- 리뷰지점: doctor checks 배열에 실제 push(commands-doctor.ts 조립부, 매 실행 렌더), env 이름 3개 다 런타임이 실제 읽는 실명(autoconfigure num_ctx/num_batch·adapter keep_alive — judge 재확인), always "ok"(옵션 노브 미설정=안전기본이지 오설정 아님, warn은 노이즈), whitespace=.trim()로 unset 취급(broken `num_batch=` 안 나감), 힌트 비-과장(num_batch=프롬프트 배치크기, 큰값=throughput↑ VRAM 비용).
- 리스크: 없음 — advisory diagnostic만, 모델/런타임/grounding/tool 무관 → 정확성 회귀 0. always-ok라 worst 등급 못 올림(기존 verdict 불변).
  검증: cli 2865 pass(신규 4 OUTCOME 케이스) · MUTATION-FIRST(힌트 always-empty → 3 RED; revert→green) · pnpm check rc=0(api 888 + cli 2865) · smoke:broad 51/0 · lint rc=0 · 독립 Opus ④ judge PASS(env명 실재 grep재확인, wired-and-live 확인, value-first 판정, 결함 0, merge 안전).
