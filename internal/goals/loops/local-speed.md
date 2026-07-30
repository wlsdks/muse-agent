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

## fire 7 · 2026-06-21 · local-speed · 2dacfb99
meta: value-class=new-capability · pkg=@muse/model+@muse/autoconfigure · kind=adapter-wiring · verdict=PASS · firesSinceDrill=7
ratchet: (model+autoconfigure, adapter-wiring) 2/7 (fire 2 num_batch throughput vs fire 7 output cap = distinct lever) · fabrication 0 · default wire byte-identical
- 무엇: opt-in 생성-길이 디폴트 캡 `MUSE_OLLAMA_NUM_PREDICT` — maxOutputTokens 없는 요청에만 적용되는 num_predict 천장. env → autoconfigure → `OllamaProvider({numPredict})` → native options. 우선순위: request.maxOutputTokens > this.numPredict(디폴트) > omit. 어댑터가 검증 단일권위(>0·finite·trunc, 아니면 omit). 미설정 = 오늘의 무제한(-1) 그대로.
- 왜: Ollama 디폴트 num_predict=-1(무제한)이라 maxOutputTokens 안 거는 generate는 루핑 로컬모델이 폭주 가능 = 지연/리소스 blowup. ★실제 무제한 경로 = **메인 에이전트 런타임**(agent-runtime.ts:323,384 `this.defaults?.maxOutputTokens`, autoconfigure가 미설정 → 포그라운드 muse ask/chat 무제한) + orchestrate 워커(caller 미설정 시). [정정: 첫 모티베이션은 background 루프(proactive-notice·memory-auto-extract·followup-firing·knowledge-recall)를 무제한이라 잘못 지목 → ④ judge가 GROUNDED≠TRUE 슬립 적발, 실제 검증 결과 그것들은 전부 cap됨(512/200/200/24). 코드는 옳고 갭도 실재하나 예시가 틀렸어서 정정함].
- 리뷰지점: opt-in 기본-off(미설정 시 와이어 byte-identical, 기존 스냅샷 green), request maxOutputTokens가 항상 이김(명시 요청 N토큰은 글로벌 캡 무시), junk/0/neg/3.5 env → omit(parseInteger 정수정규식+>0 가드), 비-ollama 누수 없음(ollama case만 생성), generate+stream 양 경로 동일(buildNativeChatBody).
- 리스크: 낮음 — 기본 경로 불변(정확성 회귀 0 by construction). 캡 SET 시 긴 답 truncate 가능하나 (a) 이미 출하된 per-request maxOutputTokens와 동종 opt-in 트레이드오프, (b) grounding 게이트는 생성된 텍스트에 동작 → truncation은 completeness만 해치지 faithfulness/fabrication-rate 불변(④ judge 명시 확인). 정직한 한계: 미실측(Ollama down) — 캡의 지연 win 크기는 C3/bench로 후속.
  검증: model 382 pass + autoconfigure 623 pass(신규 4+1 OUTCOME, 와이어 body 채점) · MUTATION-FIRST(우선순위 반전 → "maxOutputTokens WINS" 1 RED; revert→green) · pnpm check rc=0(model 382 + api 888 + cli 2873) · smoke:broad 51/0 · lint rc=0 · 독립 Opus ④ judge PASS(코드 정확·갭 실재·게이트 그린; 단 모티베이션 misgrounding 적발 → 코드주석+저널 정정 완료).
  형제-감사: num_predict를 fire-6 doctor museSpeedEnvCheck에 노출 → backlog ◦(focused 유지차 defer). 어댑터 옵션 형제(num_ctx/num_batch/keep_alive)는 이미 디폴트 보유 — num_predict가 유일한 무-디폴트 폭주 노브였음.
lesson: generate() 콜사이트를 "maxOutputTokens 안 건다"고 grep만 보고 단정하지 말 것 — 각 콜의 인자를 실제로 읽어 확인하라(이번엔 background 루프 전부 cap돼 있었음). 진짜 무제한은 런타임 defaults가 비어있는 메인 경로였다. 모티베이션도 grounding 대상이다.

## fire 8 · 2026-06-21 · local-speed · 5971e7ae
meta: value-class=micro-fix · pkg=apps/cli · kind=doctor-discoverability · verdict=PASS · firesSinceDrill=8
ratchet: (cli, doctor-discoverability) 2/8 (fire 6 num_batch, fire 8 num_predict) · fabrication 0 · advisory-only 무런타임변경
- 무엇: fire-6 `museSpeedEnvCheck`/`readMuseSpeedEnv`에 `MUSE_OLLAMA_NUM_PREDICT`(fire-7 생성캡) 추가 — 이제 doctor가 Muse 속도 env 4종(num_batch/num_ctx/keep_alive/num_predict) 모두 보고. 일관성 수정.
- 왜: fire 7이 num_predict env를 출하했는데 fire-6 doctor 체크가 3종만 보고하고 num_predict를 조용히 누락 → "speed env" 줄이 불완전/오도. 출하된 레버를 discoverable화(fire 6 num_batch와 동일 근거).
- 리뷰지점: env명 실재(autoconfigure:197 read + adapter:385 num_predict 매핑, ④ judge grep 재확인), whitespace `.trim()` 가드(numPredict="  "→미보고), always "ok"(옵션 노브), num_predict 단독 set 시 num_batch 힌트 여전히 표시(num_batch는 unset이므로 coherent).
- 리스크: 없음 — doctor advisory만, 모델/런타임/grounding 무관 → 정확성 회귀 0.
  검증: cli 2875 pass isolated(신규 2 OUTCOME) · MUTATION-FIRST(num_predict push 제거 → 1 RED; revert→green) · smoke:broad 51/0 · lint rc=0 · 독립 Opus ④ judge PASS(env명 실재·env-flake 정직·value-first·ratchet OK·결함 0). ⚠️full pnpm check는 박스 메모리압박(동시루프)으로 OOM(SIGABRT)+무관 flake(@muse/model web-search-policy property-fuzz·@muse/cli document-reader PDF 5s 타임아웃) — 둘 다 isolated-green, 내 변경은 apps/cli string-only로 무관 → env flake로 판정(fire 3·6 동일 클래스).

## fire 9 · 2026-06-21 · local-speed · efc944ab
meta: value-class=test(regression-guard) · pkg=@muse/model · kind=judge-drill+grounding-guard · verdict=PASS · firesSinceDrill=0
ratchet: (model) 3,7,9 but kind=regression-guard distinct from 2,7 adapter-wiring · fabrication 0 · TEST-ONLY 소스 무변경
- ★JUDGE-DRILL (연속 allPASS=8 트리거, 미루기 불가): 가짜 나쁜-슬라이스 → ④ judge FAIL 확인 → 롤백 → 진짜 fix.
- 드릴: 고의 나쁜 슬라이스 = opt-in `MUSE_OLLAMA_LEAN_PROMPT`가 긴 턴(>8000자)에 system 메시지를 드롭("속도"). 결정론 게이트는 GREEN(opt-in·happy-path 테스트만). 독립 Opus ④ judge가 **정확히 FAIL** — system 메시지가 grounding/citation/honesty 계약 + 근거증거 자체를 운반(commands-ask.ts:2008-2089)하므로 드롭=fabrication, >8000 트리거가 정확히 grounded 턴에 발화, opt-in은 구제 못함(플래그 목적이 floor를 깸), 테스트가 tell(드롭 콘텐츠를 "grounding rules"로 명명하고 제거를 성공으로 채점). → ④ 게이트가 rubber-stamp 아님 입증(8 fire가 의존한 게이트 검증). git restore 롤백.
- 진짜 fix(shipped): grounding-preservation 회귀 가드 2종(@muse/model adapter-ollama.test.ts) — (1) 큰 프롬프트에도 system 메시지 ALWAYS 와이어 전달(roles==["system","user"]), (2) configured num_ctx는 프롬프트 길이 무관 불변(절대 silent 축소 안 함). 드릴이 노출한 불변식을 "judge가 잡음"에서 "결정론 스위트가 잡음"으로 격상(fabrication=0 floor 방어 심화).
- 리뷰지점: 와이어 body 채점(declaration-only 아님), MUTATION-FIRST 양 가드(judge가 자체 재현: filter system→test1 RED; num_ctx Math.min(,4096)→test2+기존스냅샷 6 RED; revert→green), 소스 byte-clean(test-only→정확성 회귀 0 trivially), 불변식 실재(system=grounding 계약·num_ctx 축소=silent truncation, 어댑터 주석 문서화).
- 리스크: 없음 — test-only, 런타임 무변경.
  검증: model 384 pass(신규 2 가드) · MUTATION-FIRST 2종(독립 judge가 재현 RED) · smoke:broad 51/0 · lint rc=0 · 독립 Opus ④ judge PASS(가드 슬라이스, 자체 mutation 재현·불변식 실재 확인·env-crash 정직·결함 0). ⚠️full pnpm check는 박스 OOM(SIGABRT, packages/runtime-state 무관)으로 abort하나 packages/model은 그 run 내 384 pass(fire 8 동일 env 클래스).
lesson: judge-드릴은 가짜-슬라이스를 *결정론 게이트는 통과*하되 *불변식만 위반*하게 설계해야 JUDGE를 시험한다(소스변경으로 기존 테스트를 깨면 ③이 잡아 judge 미검증). grounding 계약은 system 메시지에 탑재 → "프롬프트 다이어트/lean" 류 속도최적화는 거의 항상 floor 위반. 드릴의 부산물(불변식 회귀가드)을 진짜-fix로 출하하면 드릴이 영구 방어로 전환됨.

## fire 10 · 2026-06-21 · local-speed · 792a408a
meta: value-class=wiring · pkg=@muse/agent-core · kind=runtime-logprobs-plumbing · verdict=PASS · firesSinceDrill=1
ratchet: @muse/agent-core FRESH (fires 1-9 미접촉) · fabrication 0 · default wire byte-identical
- 무엇: 에이전트 런타임에 opt-in 토큰 logprobs 배선. `AgentRunInput.logprobs`/`topLogprobs` → 양 request-build seam(loopRequest generate + streamLoopRequest stream)에서 `ModelRequest.logprobs`로 전달, `AgentRunResult.response.logprobs`로 round-trip 복귀. `logprobsFromInput()` 헬퍼(미설정→{} = byte-identical, 두 seam 동기화). 이제 AGENT run을 `summarizeTokenConfidence`로 confidence 채점 가능.
- 왜: cascade C2b의 분해된 FIRST 스텝(DECOMPOSE-ON-DEFER). 에이전트 경로가 logprobs를 forward 안 해서 confidence-gated cascade 불가였음(직접 ask 경로 commands-ask.ts:2870은 이미 logprobs 보유). 이게 그 prerequisite 갭을 닫음. 소비자(runCascade 배선)=C2b-wiring backlog.
- 리뷰지점: 양 seam 다 배선(stream 경로 누락 시 silent drop — sibling-audit; cache/prepareModelRequest seam은 모델콜 아님 → 불필요), 기본(logprobs 미설정)=ModelRequest에 logprobs 필드 없음 byte-identical(preparedRequest.request는 messages|metadata|model만 → {} spread가 clobber 불가, judge 확인), logprobs는 observational-only(decoding 불변), 비-capable provider는 무시(throw 안 함).
- 리스크: 낮음 — opt-in 기본-off → 정확성 회귀 0 by construction. logprobs는 관측전용(생성 토큰 불변). dead-layer? round-trip 완결+오늘 summarizeTokenConfidence로 소비가능+분해된 prerequisite(fire 3/5 substrate 선례) → ④ judge가 ACCEPTABLE 명시(filler 아님, 실제 prerequisite 갭 닫음).
  검증: agent-core 2571 pass(신규 3 round-trip OUTCOME — captureProvider로 request.logprobs + response.logprobs + meanLogprob≈-0.3 채점) · MUTATION-FIRST(헬퍼 게이트 반전 → 3/3 RED 기본-off byte-identical 가드 포함; revert→green) · pnpm check rc=0(agent-core 2571 + api 888 + cli 2878) · smoke:broad 51/0 · lint rc=0 · 독립 Opus ④ judge PASS(자체 mutation 재현·양seam 완전성 감사·byte-identical airtight 확인·dead-layer crux ACCEPTABLE 판정·결함 0).
  decompose: C2b-plumbing DONE(이 fire); C2b-wiring(runCascade를 ask --tiered/orchestration에 실연결) + C3(live eval) backlog 잔존.

## fire 11 · 2026-06-21 · local-speed · 5f4df275
meta: value-class=new-capability · pkg=apps/api · kind=cascade-live-wiring · verdict=PASS · firesSinceDrill=2
ratchet: apps/api FRESH (fires 1-10 미접촉) · fabrication 0 · default(env off) plan byte-identical
- 무엇: FrugalGPT(arXiv:2305.05176) cascade를 멀티에이전트 오케스트레이션에 LIVE 배선. `createCascadeWorker`(apps/api multi-agent-routes.ts)가 fire 5(runCascade)+fire 10(agent-run logprobs)+summarizeTokenConfidence를 다리: FAST-분류 워커가 fast 모델을 `logprobs:true`로 실행→confidence 채점→낮으면 heavy로 ONCE escalate(바운드). `buildTieredOrchestration`에 `MUSE_TIERED_CASCADE` opt-in 배선(기본 off → plan byte-identical).
- 왜: fire 3(decision)·5(execution primitive)·10(logprobs plumbing)이 깐 prerequisite를 실제 소비 = cascade가 드디어 LIVE. runCascade의 dead-layer 상태 해소. confident lookup은 fast만 치름(지연 win), weak fast 답은 heavy로 업그레이드(정확성 POSITIVE — fire 9 드릴의 나쁜 슬라이스와 정반대).
- 리뷰지점: 진짜 배선(buildTieredOrchestration→createCascadeWorker, env set+fast tier+!collapsed일 때만), opt-in 기본-off(plan byte-identical, "OFF by default" 테스트가 fast 1회·logprobs 없음·escalate 없음 pin), grounding 계약 보존(spec.systemPrompt를 prependSystem으로 유지 — drill 나쁜슬라이스처럼 드롭 안 함), 바운드(runCascade 최대 2 콜), collapsedToHeavy면 cascade skip.
- 리스크: 낮음 — opt-in 기본-off → 정확성 회귀 0; on이면 weak 답 업그레이드(floor 강화). logprobs 관측전용.
  검증: apps/api 892 pass(신규 4 OUTCOME — confidenceRuntime로 escalate[fast,heavy]·keep[fast]·logprobs:true·OFF-default 채점) · MUTATION-FIRST 2종(confidenceOf→()=>0 escalation RED; gate→true OFF-default RED; revert→green) · pnpm check rc=0 후 web-search-policy property-fuzz flake만(isolated 384/384, fires 6/8 동일 클래스, 내 변경 무관) + 내 패키지 다 green · smoke:broad 51/0 · lint rc=0 · 독립 Opus ④ judge PASS(양 mutation 재현·cascade LIVE 확인·floor 강화 확인·NUL fix 정당 판정·결함 0).
  발견+수정(별도 커밋): packages/memory/src/recently-learned.ts가 raw NUL(\x00) 구분자 3개로 byte-hygiene 게이트 깨뜨림(learning-surfacing fire 11 6df61b98가 origin/main에 올림 → 머지로 유입, 전 루프의 pnpm check 블록). \x00 escape로 치환(런타임 NUL 동일, 소스만 escape) → 공유 게이트 언블록. [별도 fix(memory) 커밋]
  decompose: C2b-wiring(orchestration) DONE; ask --tiered single-query path 배선 + C3(live eval) backlog 잔존.

## fire 12 · 2026-06-21 · local-speed · 1e32082a
meta: value-class=new-capability · pkg=@muse/model+@muse/autoconfigure · kind=adapter-wiring · verdict=PASS · firesSinceDrill=3
ratchet: (model, adapter-wiring) 2/8 윈도우(fire 7,12) — 임계 미만; fire-2 sibling 가족 완결 · fabrication 0 · default wire byte-identical
- 무엇: 마지막 미배선 Ollama 어댑터 속도노브 2종 opt-in 배선 — `MUSE_OLLAMA_NUM_THREAD`(CPU 스레드)+`MUSE_OLLAMA_NUM_GPU`(GPU 레이어 오프로드). num_batch/num_predict 검증된 패턴 미러. ★KEY: `num_gpu=0`(CPU-only)은 VALID opt-in(num_batch와 달리) → 어댑터 `>= 0` 검증 + autoconfigure `parseNonNegativeInteger`(num_gpu=0 테스트가 `parseInteger`는 0 거부하는 실제 버그를 잡음). num_thread는 `> 0`.
- 왜: fire 2 sibling-audit가 enumerate한 마지막 2 노브 → Ollama 어댑터 속도노브 가족 완결(num_ctx/num_batch/num_predict/keep_alive/num_thread/num_gpu). merge fire라 완결·저위험 슬라이스 선택; 더 높은가치 ask --tiered cascade는 monolithic/multi-fire라 정당 defer(backlog).
- 리뷰지점: num_gpu=0 와이어 도달(CPU-only, drop 금지 — 테스트가 parseInteger 0-거부 버그 적발→parseNonNegativeInteger 수정), num_thread `>0`/num_gpu `>=0` 검증 차이, opt-in 기본-off(미설정 시 둘 다 omit=byte-identical), generate+stream 양 경로(단일 buildNativeChatBody), 비-ollama 누수 없음(ollama case만), junk/edge(thread 0/neg/junk→omit; gpu 0→keep, neg/junk→omit, 33→keep).
- 리스크: 낮음 — opt-in 기본-off → 정확성 회귀 0. 하드웨어/배치 노브지 생성 토큰 불변. num_gpu=0=CPU-only는 정직한 메모리/속도 tradeoff(OOM 회피용), 무료 속도 win 아님으로 표기.
  검증: model 387 + autoconfigure 624 pass(신규 4 OUTCOME — num_gpu=0 와이어 포함) · MUTATION-FIRST(num_gpu `>=0`→`>0` num_gpu=0 RED; ④ judge가 num_thread spread 제거 + autoconfigure parseInteger 미스파서까지 3 mutation 재현 RED) · pnpm check rc=0(model 387 + api 946 + cli 2887) · smoke:broad 52/0 · lint rc=0 · 독립 Opus ④ judge PASS(num_gpu=0 의미 웹검증·3 mutation 재현·ratchet/value-first 판정·결함 0; merge-sound).

## fire 13 · 2026-06-21 · local-speed · 35b8fb07
meta: value-class=test(eval-harness) · pkg=scripts · kind=measurement-infra(C3 cascade proof) · verdict=PASS · firesSinceDrill=4
ratchet: (scripts, measurement-infra) 1/8 윈도우(fire 1 이후 처음) · fabrication 0 · 패키지 소스 0줄(scripts+package.json 1줄)
- 무엇: cascade C3 proof `eval:cascade` — 순수 코어 `scripts/lib/cascade-eval.mjs`(meanMs·escalationRate·scoreCascadeEval: latencyWin + gateCorrect[escalate iff low-confidence]) + node:test 8케이스(self-eval:test glob 자동편입) + 라이브 러너 `scripts/eval-cascade.mjs`(raw Ollama /api/chat logprobs, LOCAL-OLLAMA-ONLY skip, model-call 타임아웃→clean skip). package.json `eval:cascade`.
- 왜: cascade 벤(fire 3 decision·5 execution·10 logprobs·11 orchestration live)의 마지막 = C3 증명. 헤드라인 기능이 실제로 지연 절약하는지 측정.
- ★LIVE 측정(Ollama up): fast=qwen3:8b/heavy=qwen3.6:35b-a3b → cascade **23.9% faster**(12970ms vs 17045ms). 정직한 caveat(④ judge): escalation 0%(qwen3:8b가 set 전체에 confident, threshold -1.0) → 라이브로 *confident-query 지연win arm만* 실증, escalate→heavy arm은 미발화; 러너의 라이브 gateCorrect는 self-consistency(escalation을 scorer가 재확인하는 동일 predicate로 도출)지 독립측정 아님 — gate의 적대증명은 UNIT 테스트. → "PROVEN" 과장 안 함, latencyWin 측정 + gate logic unit-proven으로 정직 표기.
- 리뷰지점: 순수코어 OUTCOME 채점(verdict 값), confidence proxy = content-token logprob 평균(<|마커 제외) = summarizeTokenConfidence와 동일, scripts/는 eslint-ignored·패키지 무관(런타임 byte-identical), 러너 model-call AbortSignal.timeout→clean skip(judge defect1 수정).
- 리스크: 없음 — 패키지 소스 0줄 → 정확성 회귀 0. eval:cascade는 standalone(어떤 aggregate gate에도 없음, opt-in/manual).
  검증: cascade-eval.test 8/8 · MUTATION-FIRST(gate `!==`→`===` 4 RED; revert→green) · LIVE 23.9% latency win 측정 · 러너 load시 clean skip(exit 0) 확인 · smoke:broad 52/0 · lint rc=0 · pnpm check는 web-search-policy property-fuzz "Test timed out 5000ms" load-flake만(isolated 1/3 green, 박스 load 35 = Ollama 35B resident+동시루프, 내 변경 scripts-only로 무관) · 독립 Opus ④ judge PASS(자체 mutation 재현, 0%-escalation 정직성·load-flake nuance·value-first 판정; defect 2건[fetch timeout·gateCorrect 자기일관성] 지적 → fetch timeout 수정+claim 정직화 완료).
  decompose: 라이브 escalate-arm 실증(hard prompt/낮은 threshold) → backlog ◦. ask --tiered single-query cascade도 잔존.

## fire 14 · 2026-06-21 · local-speed · 4a2c4587
meta: value-class=new-capability · pkg=apps/api · kind=startup-latency(warmup) · verdict=PASS · firesSinceDrill=5
ratchet: (apps/api) 2/8 윈도우(fire 11 cascade-wiring vs 14 startup-warmup = distinct kind) · fabrication 0 · default-off startup byte-identical
- 무엇: opt-in 모델 워밍업 `MUSE_WARMUP_MODEL`(apps/api `warmUpModelIfConfigured`) — 서버 시작 시 작은 fire-and-forget generate(maxOutputTokens:1)로 모델을 Ollama에 미리 로드 → 첫 사용자 요청이 warm. server.ts 시작 훅(데몬들 옆)에 1줄 배선.
- 왜: keep_alive(어댑터 디폴트)는 요청 *사이*에만 모델 resident 유지 → 서버 start 후 *첫* 요청은 풀 cold load(12B 수십초) 부담. always-on 컴패니언(Muse 정체성)에서 첫-요청 cold-start가 체감 최악 지연. cascade 벤 완료 후 남은 다른 종류의 지연 레버.
- 리뷰지점: opt-in 기본-off(미설정→generate 호출 0 = startup byte-identical), fail-soft(`Promise.resolve().then(()=>generate).catch()` — sync throw + async rejection 둘 다 삼킴, unhandled rejection 없음, server start 절대 안 깸 — ④ judge가 3 mutation으로 .catch/wrapper 둘 다 load-bearing 확인), void 반환(listen 지연 안 함), 워밍업 결과 discard(어떤 요청 답/grounding에도 안 닿음), 비-cloud(기존 provider 재사용, 새 egress 경로 없음).
- 리스크: 없음 — 기본-off → 정확성 회귀 0. 워밍업은 모델 로드만(생성 토큰 discard), grounding/tool 무관.
  검증: apps/api 959 pass isolated(신규 5 OUTCOME — fires-when-enabled/default-off/guard/fail-soft sync+async) · MUTATION-FIRST(enabled=true → default-off RED; ④ judge가 bare-void→sync-throw escape RED, .catch 제거→unhandled-rejection leak 추가 확인) · build rc=0 · lint rc=0 · 독립 Opus ④ judge PASS(자체 3 mutation 재현, fail-soft 정확성·box-saturation 정직성·value-first 판정, 결함 0). ⚠️pnpm check + smoke:broad는 박스 극단 saturation(6 동시루프 + Ollama 35B resident)으로 TIMEOUT(autoconfigure runtime-assembly-e2e 18× "Test timed out 5000ms", smoke >300s) — 내 변경 apps/api-only이고 autoconfigure는 apps/api 의존 안 함(역방향) → 깰 수 없음, 박스-포화 flake로 판정(apps/api isolated 959 + build + lint green).
  형제-감사: MUSE_WARMUP_MODEL을 museSpeedEnvCheck(doctor)에 노출 + per-box cold-start delta 측정 → backlog ◦.
