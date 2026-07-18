# builder-evolution loop journal

> 테마: Builder/자동화 트랙 지속 개선 + 사용자 체감 기능 갭 발굴. cron `55ad6e29`(세션, 매시 :23),
> Tier2+(진안 2026-07-18 명시 승인: green일 때만 origin/main push). 중단: CronDelete 55ad6e29.

## fire 1 · 2026-07-18 · skill v2.1.1 · 454c3f797
meta: value-class=reliability · pkg=@muse/cli · kind=reliability · verdict=PASS · firesSinceDrill=1
ratchet: serve-core tests 22->45 · fabrication 0 · self-eval green(envInventory 등록시 수리 0ff19cd3c)
- 무엇: muse serve 수퍼비전 — 자식 예상외 사망시 지수백오프 재기동(1s..30s, 10분창 5회 서킷브레이크, 60s 생존시 리셋), 시그널이 sleep 갭에 와도 재기동 중단+클린 종료. 순수 policy(nextRestartDecision) 주입시계로 완전 유닛테스트.
- 왜: 2026-07-17/18 라이브에서 3회 문 실결함 — 자식 죽어도 수퍼바이저가 포트 빈 채 대기(좀비 클래스의 뿌리 절반).
- 리뷰지점: exit 0(정상 종료)은 재기동 안 함(restart: on-failure 의미론) — admin/shutdown 우회 방지.
- 리스크: give-up 후 수퍼바이저 종료 코드 = 마지막 자식 코드; launchd/systemd 래핑시 이중 재기동 가능성(외부 수퍼바이저와 조합 시 관찰 필요).
- 라이브: kill -9 자식 -> 1s 재기동 실측(새 pid, health 재서빙, 정직 로그) · TERM -> 자식 포함 클린 종료 · 고아 0.

## fire 2 · 2026-07-18 · skill v2.1.1 · 8ca40ba1c
meta: value-class=new-capability · pkg=@muse/scheduler+@muse/web+@muse/api · kind=capability-wiring · verdict=PASS(opus) · firesSinceDrill=2
ratchet: scheduler tests 169(+9) · web 529+browser16 · api e2e 신규 1(outcome-graded) · fabrication 0
- 무엇: Builder "도구 실행" 흐름 — 스케줄 잡(jobType mcp_tool)이 루프백 MCP 도구를 실제 실행하도록 `extraTools` 시임 배선(scheduler-runtime + runtime-assembly 주입), 웹 생성/편집 패널에 서버·도구 피커(`readRiskToolOptions`로 risk==="read"만), flow-edit-compile 도구 페이로드 컴파일, dynamic-scheduler 에러 메시지 실메시지 기록 픽스.
- 왜: 기존엔 mcp_tool 잡이 저장만 되고 실행 불가(외부 MCP 연결만 지원) — 빌더의 "도구 호출" 노드가 데드 표면이었음.
- 리뷰지점: write 도구는 실행 가능 집합(createLoopbackMcpToolsFromEnv)에 아예 미구성 — 조작 POST로 muse.messaging.send를 등록해도 not-connected로 FAILED, 무인 send 불가(opus 검증). toolArguments는 projection 비투영 유지.
- 리스크: 무인 write/execute 도구 정책은 [decision]으로 진안에게 — v1은 read-only fail-close.
- 라이브: 실브라우저(격리 HOME 데모서버) — 피커 14서버, messaging=providers/inbox만·reminders=list/search만(음성 케이스 실증), muse.time/now 흐름 생성→테스트 실행→실행 기록 SUCCESS+실타임스탬프 JSON 렌더.

## fire 3 · 2026-07-18 · skill v2.1.1 · b2b680b78
meta: value-class=new-capability · pkg=@muse/web · kind=ui-capability · verdict=PASS(opus) · firesSinceDrill=3
ratchet: web SSR 542(+7) · browser 18(+1) · unit +7 · fabrication 0
- 무엇: 빌더 출력 노드 알림 채널 피커 — raw `provider:destination` 타이핑 대신, 연결·페어링된 메시징 채널을 골라 정확한 값을 채움. deriveNotifyChannelOptions(순수, configured&&registered&&pairedOwner만) + NotifyChannelQuickPick(react-query /api/messaging/setup, 없으면 null). create+edit 양 패널 배선(형제 감사).
- 왜: 사용자가 telegram:12345 형식을 알고 타이핑해야 했던 실 UX 부담 — 실행 러너가 이미 parseNotificationChannel로 파싱하는 값이라 runner-지원·결정론.
- 리뷰지점: registered:false(저장됐지만 non-live)·unpaired는 send 시 실패하므로 절대 미노출(false-positive 0); schedulerDeliveryValue가 matrix double-prefix 처리; 에러/localOnly 403은 null로 우아하게 강등(텍스트필드 유지).
- 리스크: 없음(피커는 편의 레이어, 텍스트필드가 source of truth). 라이브 POSITIVE는 실 Telegram 등록 필요라 vitest 실Chromium으로 증명, 라이브는 무회귀 케이스 측정.
- 참고: 인터랙티브로 랜딩된 빌더 슬라이스 2건(fire 2 이후) — tool-execution flows(f2e539321, scheduler+web+api/wiring)·fullscreen+LNB(b2f9652ec, web/ui-affordance) — 다양성(pkg,kind) 카운트에 포함.

## fire 4 · 2026-07-18 · skill v2.1.1 · 4642f1cc8
meta: value-class=new-capability · pkg=@muse/scheduler+@muse/api+@muse/web · kind=capability · verdict=PASS(opus, 2차) · firesSinceDrill=4
ratchet: scheduler 177(+8) · api scheduler-routes 12(+4) · web browser 19(+1) · fabrication 0
- 무엇: 흐름 복제 — POST /api/scheduler/jobs/:id/duplicate + FlowHeaderActions "복제" 버튼. buildDuplicateJobInput(순수)이 20개 config 필드 전부 복사, id·실행 lifecycle·타임스탬프 제외, enabled:false(draft-first), name 접미사(" (copy)"/" (사본)").
- 왜: n8n/Zapier에 다 있는 기본 빌더 역량 부재 — 기존 흐름을 출발점으로 재사용 불가였음. 실행 러너가 이미 지원하는 create 경로 재사용이라 runner-지원·결정론.
- 리뷰지점: 복제본 enabled:false로 복제된 스케줄이 몰래 발화 안 함; notificationChannelId+webhookUrl 둘 다 복사해 `channelId ?? webhookUrl` 배달 해석 그대로 보존; 404-before-create로 부분 부작용 0.
- 리스크: 이름 유니크 제약 없음(중복 "X (copy)" 허용) — 의도된 동작.
- lesson: config-복사 매퍼는 필드-바이-필드 감사 필수 — Opus 1차가 webhookUrl 누락(green 스위트가 못 잡은 silent divergence, 배달 타깃 소실) 검출; 원본 인터페이스 열거→매퍼 대조로 20/20 확인 후 PASS. 이후 이런 매퍼엔 "모든 config 필드" 테스트를 처음부터.
- 라이브: 실브라우저 e2e(격리 데모) 복제 클릭→새 흐름 "Daily brief (사본)" 별 id·enabled=false·원본 무변경, API list 2건 확인.

## fire 5 · 2026-07-18 · skill v2.1.1 · d3482e441
meta: value-class=ux-fix · pkg=@muse/web · kind=ui-legibility · verdict=PASS(opus) · firesSinceDrill=5
ratchet: web SSR 549(+7) · compile unit +6 · component +1 · fabrication 0
- 무엇: 실행 기록 카드가 FAILED 실행의 계산된 failureReason(깨끗한 이유)을 danger 톤으로 표시. resolveExecutionDisplay(순수)가 FAILED+비어있지않은 reason→error 톤, 그 외→output. raw "Job 'X' failed:" 접두는 배지와 중복이라 제거.
- 왜: 실패 이유(failureReason)가 API엔 계산돼 오는데 UI가 안 써서 dead data였고, FAILED 결과가 성공 출력과 같은 muted 스타일로 묻혀 실패 이유가 안 읽혔음.
- 리뷰지점: 정보 손실 없음 — schedulerFailureReason은 접두만 스트립, 나머지 전부 reason에 남고 show-more로 전문 노출. 전 status/field 조합 유닛 커버.
- 리스크: 없음(순수 표시 로직).
- lesson: 실브라우저 측정이 CSS specificity 버그 검출 — bare `.exec-error`(0,1,0)가 `.row .row-meta`(0,2,0)에 짐→grey. SSR 테스트는 클래스 존재만 확인(계산 색상 못 봄). 2-class `.row-meta.exec-error`로 수정. 교훈: 기존 색을 오버라이드하는 새 클래스는 대상 셀렉터의 specificity를 매칭+뒤 순서, 그리고 실브라우저로 computed color 측정 필수.
- 라이브: 격리 데모 실패 tool run — .exec-error가 "MCP server ... not connected" (접두 없음) rgb(229,83,75)=danger로 렌더.

## fire 6 · 2026-07-18 · skill v2.1.1 · 715c2be2f
meta: value-class=new-capability · pkg=@muse/web · kind=ui-capability · verdict=PASS(opus) · firesSinceDrill=6 · consecutiveAllPASS=6
ratchet: web SSR 550(+1) · browser 20(+1) · compile unit +1 · fabrication 0
- 무엇: 빌더 에이전트 액션 노드에 "시스템 프롬프트" textarea(create+edit 양 패널). ActionEditForm/FlowDraft/바디 타입에 agentSystemPrompt 배선, patch=trim→null(비우면 clear), create=trim→undefined(생략).
- 왜: 스케줄 실행 러너(runtime-wiring.ts:70-72)가 이미 agentSystemPrompt를 system 메시지로 주입하는데 빌더는 prompt+model만 노출 — runner-지원 노브가 도달 불가였음.
- 리뷰지점: runner-support 규칙 — agentSystemPrompt는 실행기가 실제 소비(확인). agentMaxToolCalls/personaId는 실행기가 무시하므로 의도적으로 미노출(유효-비실행 방지). tool 브랜치는 필드 생략. copilot 리비전은 agentModel과 동일하게 리셋(기존 패턴 일치).
- 리스크: 없음.
- 라이브: 실브라우저 라운드트립 — 액션 노드 시스템 프롬프트 편집→저장→GET job에 agentSystemPrompt 영속(agentPrompt 무변경).

## fire 7 · 2026-07-18 · skill v2.1.1 · 06813eefc
meta: value-class=ux-fix · pkg=@muse/web · kind=ui-legibility · verdict=PASS(opus) · firesSinceDrill=7 · consecutiveAllPASS=7
ratchet: web SSR 550 · browser 22(+2) · fabrication 0
- 무엇: 빌더 create+edit 패널의 검증 경고 4곳(cron 무효·툴 JSON 무효)이 `color: var(--err)`로 렌더됐는데 `--err`가 미정의 변수라 무색(muted grey)이었음. `.field-error{color:var(--danger);font-size:var(--text-xs)}` 클래스로 4곳 전부 교체.
- 왜: 사용자가 잘못된 cron/JSON 입력해도 피드백이 중립 힌트처럼 보여 에러로 안 읽혔음(빌더 핵심 검증 UX 결함).
- 리뷰지점: fire 5의 형제 클래스 — 안 먹는 색. `.subtle` 대신 전용 `.field-error`(specificity 경쟁 없음, edit 패널도 동일 마크업이라 빨강). `.subtle`은 색만 제공하므로 손실 없음. Opus가 edit 패널 미-라이브 컨텍스트도 오버라이드 없음 확인.
- 리스크: 없음(폰트 12→11px 의도적).
- lesson: 새 색 클래스는 실브라우저 computed color 측정으로 검증(SSR/DOM 테스트는 클래스 존재만 확인). undefined CSS var(`--err` 등)는 조용히 무색 폴백 — 코드베이스 색 토큰(`--danger`)만 사용.
- **NOTE(fire 8용): consecutiveAllPASS=7. 다음 fire(8)에서 8 도달 → JUDGE-DRILL(고의 나쁜 슬라이스 주입→평가자 FAIL 확인→롤백) 실행 후 카운터 리셋.**
- 라이브: 격리 데모 create 패널 invalid-cron → .field-error rgb(229,83,75)=danger.

## fire 8 · 2026-07-18 · skill v2.1.1 · 1f9978270 · JUDGE-DRILL + real slice
meta: value-class=new-capability · pkg=@muse/web · kind=ui-capability · verdict=PASS(opus) · firesSinceDrill=0(reset) · consecutiveAllPASS=0(reset)
ratchet: web SSR 552(+2) · browser 23(+1) · fabrication 0
- JUDGE-DRILL(consecutiveAllPASS≥8 트리거): 고의 결함 슬라이스 주입 — `agentMaxToolCalls`를 fire6 agentSystemPrompt와 동일하게 빌더에 배선(전 게이트 green: SSR 551·browser 22·tsc/lint/build 0). 독립 Opus 평가자가 **정확히 FAIL** 판정: runtime-wiring.ts createScheduledAgentExecutor가 job.agentMaxToolCalls를 agentRuntime.run에 안 넘김 + AgentRunInput에 maxToolCalls 슬롯 자체 없음(공유 런타임 생성자 옵션 default 10만) + scheduler/autoconfigure에 소비 경로 0 → 유효-비실행. 새 unit 테스트가 "web가 값 컴파일함"만 증명하는 false-confidence임도 지적. **rubber-stamp 아님 확인 → git restore 롤백.** maker=judge 보상통제 작동.
- 진짜 슬라이스: 흐름 timezone 편집 — 트리거 노드가 tz를 read-only로만 보여줬는데, curated IANA select(+job 자체 zone 항상 포함)로 편집 가능. TriggerEditForm/patch에 timezone 배선(schedule setForm은 ...form 스프레드로 tz 보존).
- 왜: 스케줄러가 computeNextRunAt에서 job.timezone을 cron-parser tz로 실제 사용 — Seoul 9am이 UTC 9am과 다름. 러너-소비 검증(드릴과 정반대).
- 리뷰지점: 러너-소비 라이브 증명 — tz UTC→Asia/Seoul 변경 시 nextRun 09:00Z→다음 00:00Z 이동. 폼상태 버그(setForm ...form 누락) 뮤테이션-RED로 방어 확인. curated select라 무효 tz 신규 벡터 없음.
- 리스크: 없음.
- lesson: JUDGE-DRILL은 maker=judge 천장에서 필수 보상통제 — 평가자가 runtime-wiring.ts를 실제로 읽어 runner-소비를 검증함을 확인(고정 체크리스트 아닌 적응형). 새 빌더 필드는 항상 실행기 소비 경로를 grep으로 검증 후 노출.
- 라이브: 격리 데모 tz 편집 라운드트립 + nextRun 이동 실측.

## fire 9 · 2026-07-18 · skill v2.1.1 · 43f28951c
meta: value-class=ux-fix · pkg=@muse/api+@muse/web · kind=correctness · verdict=PASS(opus) · firesSinceDrill=1 · consecutiveAllPASS=1
ratchet: api flow-projection 15(+1) · web SSR 553(+1) · fabrication 0
- 무엇: 비활성 흐름이 리스트+트리거 캔버스 노드에 "다음 실행 9:00" 표시(안 도는데) — 정직-상태 위반. 수정: flow-projection이 enabled일 때만 nextRunAtIso 계산(disabled→null), 리스트는 "Paused/일시정지됨" 라벨. cron/timezone은 유지(paused여도 스케줄 설정 보임), 노드는 next-run chip 자동 생략.
- 왜: 제품 honest-state floor — disabled 흐름은 발화 안 하므로 "다음 실행 X"는 거짓 상태. 단일 서버 프로젝션 변경으로 두 빌더 표면(리스트+캔버스) 동시 수정.
- 리뷰지점: compareFlows null 양측 안전(disabled는 이미 enabled 뒤 정렬), 모든 nextRunAtIso 소비자(Work·Autonomy) truthy-guard라 파손 없음(opus 검증). formatMetaValue null→chip 필터.
- 리스크: 없음.
- 라이브: 격리 데모 흐름 disable→API nextRun null·리스트 "일시정지됨"·트리거 노드 cron+tz만(next-run chip 없음) 실측.

## fire 10 · 2026-07-18 · skill v2.1.1 · 162846891
meta: value-class=new-capability · pkg=@muse/api+@muse/web · kind=llm-capability · verdict=PASS(opus) · firesSinceDrill=2 · consecutiveAllPASS=2
ratchet: api 1327(+18: compile 32·routes 15) · web SSR 554 · browser 24(+2) · eval:flow-draft 5케이스 5/5×3 STABLE · fabrication 0
- 무엇: 코파일럿이 TOOL 흐름 초안 — FlowDraftPayload에 action/toolServer/toolName, 라우트가 런타임 레지스트리의 read-risk muse.* 루프백 도구를 허용목록으로 주입(4개 parse 경로 전부 멤버십 fail-close, 목록 밖 쌍=422), 웹은 tool 초안을 tool 모드로 프리필+컴포저 tool 모드 활성화+diff ack 확장, eval:flow-draft에 tool 골든+오발화 가드.
- 왜: 이전에 DECOMPOSE로 이연된 최대 빌더 갭 — 자연어로 도구 흐름을 못 만들었음. 허용목록=스케줄러 extraTools가 실제 실행하는 집합이라 유효-비실행 불가(구성으로 보장, fire 8 드릴 교훈).
- 리뷰지점: 신뢰불가 모델 출력이 write/execute 잡을 만들 경로 없음(opus가 빈-목록 fail-close·stray-pair 정규화·이름 regex 11엣지 직접 실행 검증). 리비전은 action echo 필수(tool→agent 침묵 플립 불가). 레거시 5필드 클라이언트 하위호환.
- 리스크: 런타임 도구 목록(~25)이 eval의 6개 서브셋보다 큼 — 라이브 e2e는 실제 전체 목록으로 성공했으나 선택 품질은 eval이 계속 감시.
- 라이브: 실 gemma4 e2e 완주 — 컴포저 "매시간 정각에 현재 시각 기록해줘"→tool 초안(muse.time/now, 0 * * * *)→TOOL 모드 프리필→만들기→테스트 실행→실행 기록 성공+실 타임스탬프.

## fire 11 · 2026-07-18 · skill v2.1.1 · 7461df407 + 7454f7830
meta: value-class=regression-fix+ux-fix · pkg=@muse/api+@muse/web · kind=repair+ui-capability · verdict=PASS(opus) · firesSinceDrill=3 · consecutiveAllPASS=3
ratchet: self-eval promptSeam fail→pass · web SSR 560(+6) · browser 25(+1) · fabrication 0
- 무엇 A(회귀): fire 10의 로컬 헬퍼명 buildSystemPrompt가 check:prompt-seam의 금지-이름 프록시와 충돌 → buildDraftSchemaSystemPrompt로 개명. behavior 매처는 안 걸림(identity 텍스트 0) — opus가 "시임 경유가 오히려 D5 위반, 개명이 정직한 수리(회피 아님)" 확인.
- 무엇 B(오너 스크린샷 실결함): 캔버스 전 노드 y=0 한 줄 + 드래그 위치 비영속 → 겹침 재발. 스태거 초기행(120/0/220, 수직간격≥노드높이) + flow-node-positions(스토리지 주입·fail-safe) localStorage 영속: 시딩→병합(in-memory→saved→default)→드래그 종료시만 저장.
- 왜: 진안 2026-07-18 명시 요구("겹쳐지는건 없어야하고! 박스는 마우스로 움직일 수 있어야함") — 리디자인 시안 확정과 무관하게 어느 안에서든 필요한 기반.
- 리뷰지점: flow-scoped 노드 id라 흐름 전환시 교차 오염 불가; NaN/손상 JSON/스토리지 예외 전부 기본 레이아웃 강등; 삭제된 흐름의 고아 키(~100B)는 non-blocking 노트.
- lesson: ①self-eval을 fire 시작뿐 아니라 **커밋 전에도** 재실행할 것 — fire 10이 promptSeam 회귀를 남긴 채 push됨(시작 시점 green만 확인). ②격리 워크트리서 guard-writeback 우회용 git stash --keep-index 사용했음 — 다음부턴 커밋 순서를 먼저 계획(신규 테스트 파일과 같이 스테이징).
- 라이브: 실마우스 드래그→localStorage {x:568.79,y:147.2} 저장→풀 리로드→transform translate(568.792px,147.208px) 정확 복원 + 스태거 겹침검사 false 실측.

## fire 12 · 2026-07-18 · skill v2.1.1 · 7b32ca45b + f76295948
meta: value-class=gate-integrity+ux-fix · pkg=scripts+@muse/web · kind=eval-wiring+ui-dedup · verdict=PASS(opus) · firesSinceDrill=4 · consecutiveAllPASS=4
ratchet: eval:agent 배터리 11→12(flow-draft 편입) · skip-as-pass 1건 해체 · web SSR 563 · fabrication 0
- 무엇 A: 리디자인 직후 라이브 프로브 5종(빈 상태·코파일럿 초안 프리필(실 gemma4)·생성·탭·Work/Scheduled·패딩 복원) — **결함 0**. EXHAUSTION 규칙로 kind 전환.
- 무엇 B: eval:flow-draft를 eval:agent 번들에 편입 — 편입 과정에서 **SKIP-AS-PASS 실버그** 발견·수리: skip 문구("unavailable")가 classifySkip vocabulary와 안 맞아 스킵이 'ok'로 집계되던 것(데드-URL 재현→수정 후 'skip (ollama-unreachable)'). 형제 감사: 타 11개 배터리는 전부 호환.
- 무엇 C(오너 스크린샷): 토프바 뷰 제목 제거 — 전 뷰가 자체 제목(eyebrow+h1) 보유라 토프바 제목은 상시 중복("오늘" 2번). 라이브 실측: 토프바에 검색만.
- 왜: 미배선 배터리는 썩는다(§5) + 오너 즉시 지적.
- 리뷰지점: opus가 classifySkip을 양쪽 메시지로 직접 실행해 버그 서사 검증(generic 'skipped' 코드 부재 확인). W3 잔여분은 FRESHNESS 적중 — CLI/웹/API outcome은 기출하, "다음 pack 반영"만 attunement 설계 필요.
- **오너 큐(2026-07-18, 최우선 반영)**: ①Scheduled 뷰를 빌더급으로(사용법이 안 보임 — 빌더 워크스페이스와 정합) ②Work 뷰를 빌더급으로. 다음 fire들의 (a)순위.
- 리스크: eval-council-floors가 데드-URL 런에서 FAIL(embed-model-missing) 노출 — pre-existing 분류 정책, 실환경(모델 설치됨)에선 통과.

## fire 13 · 2026-07-18 · skill v2.1.1 · 6c19b6e80
meta: value-class=new-capability · pkg=@muse/web · kind=ui-capability(owner-directed) · verdict=PASS(opus) · firesSinceDrill=5 · consecutiveAllPASS=5
ratchet: web SSR 572(+3) · browser 31(+5) · unit +6 · fabrication 0
- 무엇: Scheduled 빌더급 격상(오너 큐 ①) — 흐름당 운영 행(상태점·이름·무슨 일(프롬프트 머리/서버.도구)·언제(사람말 cadence+다음 실행)·마지막 실행 배지·행 위 컨트롤: 켜기/끄기·지금 실행·빌더에서 열기) + 켜짐/일시정지 요약 + 빌더 지향 빈 상태. 기존 다이제스트/예산 요약은 하단 보조로 강등. "빌더에서 열기"는 1회성 sessionStorage 힌트로 핸드오프(빌더가 마운트 시 소비·삭제, 삭제된 id는 기본 선택으로 강등).
- 왜: 진안 "스케쥴은 어떻게 쓰는건지도 모르겠고" — 읽기 전용 요약이라 조작 대상이 없었음.
- 리뷰지점: opus 후속권고 즉시 반영 — paused 행 지금 실행 허용(dynamic-scheduler 검증: enabled 게이트는 automatic 실행만 스킵, 수동 trigger는 실행) + 회귀테스트. busy 플래그가 양 뮤테이션 더블클릭 flip-flop 방지. mergeScheduleRows는 잡 행 누락 시 stats 공란으로 렌더(드롭 없음).
- 리스크: jobs limit=100 초과 시 꼬리 행 stats 공란(개인 스케일 무해). SSR "1" 카운트 어설션 약함(요약 문자열이 실질 방어) — opus 노트.
- 라이브: 격리 데모 2흐름(에이전트+도구/실행 1회) — 행에 muse.time.now·매시간·SUCCESS·실행된 적 없음 렌더, 끄기→paused, 이름 클릭→빌더가 그 흐름으로 열림 실측.
- 오너 큐 잔여: ②Work 빌더급 — 다음 fire.

## fire 14 · 2026-07-18 · skill v2.1.1 · 2287757ee
meta: value-class=new-capability · pkg=@muse/web · kind=ui-capability(owner-directed) · verdict=PASS(opus) · firesSinceDrill=6 · consecutiveAllPASS=6
ratchet: web SSR 575(+3) · browser 34(+3) · unit +3 · fabrication 0
- 무엇: Work 링크 UX 빌더급(오너 큐 ②) — raw id 타이핑(LinkPicker) → 이름 선택 피커(EntityLinkPicker, 미링크 후보만·없으면 숨김), 연결 흐름은 미니 운영 행(상태점·이름 클릭=빌더 포커스 핸드오프(fire 13 시임 재사용)·다음실행/일시정지·연결 해제), 태스크 행+해제. ApiClient.del에 옵셔널 body(works unlink 계약 DELETE+body; 기존 12개 콜사이트 무영향 검증).
- 왜: 진안 "work도 마찬가지야" — id를 알아야 링크되는 표면은 빌더급이 아님.
- 리뷰지점: 스레드 링크는 raw id 유지(threads 목록 API 부재 — 정직한 스코프 컷, 후속 기록). SSR "unrelated 미누출" 어설션은 삭제 아닌 정제(행엔 없음+옵션엔 정확 마크업 양방향). 참조-부패 시 undercount는 pre-existing(store가 삭제 시 prune).
- 리스크: 없음.
- 라이브: 격리 데모 전 사이클 — 피커 링크→행(다음 실행 표시)→이름 클릭→빌더가 그 흐름으로→언링크→행 소멸+피커 후보 복귀 실측.
- 오너 큐 상태: ①Scheduled(f13)·②Work(f14) 완료. 잔여 후속: threads 목록 API+스레드 피커, Work 헤더의 새 흐름 직생성(빌더 프리필 핸드오프).

## fire 15 · 2026-07-18 · skill v2.1.1 · 380812f91 (인터랙티브 "한번에 크게" 지시)
meta: value-class=new-capability · pkg=@muse/api+@muse/web · kind=integration · verdict=PASS(opus, 2차) · firesSinceDrill=7 · consecutiveAllPASS=7*
ratchet: api attunement 13(+1) · web SSR 577(+2) · browser 38(+4) · unit +2 · fabrication 0
- 무엇: Work↔Builder 통합 — ①GET /api/attunement/threads(피커 피드) + Work 스레드 피커/행/해제(마지막 raw-id 입력 소멸) ②"이 Work용 새 흐름" 원샷 핸드오프: 빌더가 create 패널 열고 생성 흐름을 Work에 자동 링크(베스트-에포트).
- 왜: fire 14의 기록된 후속 2건을 한 번에(진안 "이어서 한번에 크게").
- 리뷰지점: **opus 1차 FAIL이 실결함 검출** — Work 바인딩이 Cancel을 살아남아 이후 무관한 흐름도 자동 링크(놀람 뮤테이션). 수리=취소/흐름전환/수동 새흐름 전부 바인딩 해제, pre-fix에 red인 회귀 테스트. 재게이트가 코파일럿-after-Cancel 엣지까지 traced PASS.
- 리스크: 링크 실패는 무피드백 침묵(사용자가 빌더에 있고 수동 링크 가능해 수용, opus 판단). Autonomy 중복 의혹은 조사 결과 무근(탭 구성 상이) — C 슬라이스 불요 확인.
- 라이브: 스레드 시딩→피커 링크→행 / 새 흐름 핸드오프→자동 링크 행 복귀 전 사이클 실측.
- *consecutiveAllPASS 계산 노트: 1차 FAIL은 게이트가 작동한 것(출하 전 검출·수리·재PASS)이라 출하 기준 PASS 연속으로 집계하되, 다음 fire(16)에서 8 도달 시 JUDGE-DRILL 실행.

## fire 16 · 2026-07-18 · skill v2.1.1 · 96bb7d1b8 (인터랙티브 "전부다" 지시)
meta: value-class=new-capability · pkg=@muse/api+@muse/web · kind=llm-capability · verdict=PASS(opus) · firesSinceDrill=0(드릴 완료) · consecutiveAllPASS=1
ratchet: api compile 40(+8) · routes 15 · web flow-edit-compile 59(+3) · browser 38 · eval:flow-draft 6/6(+1케이스) ×3 · fabrication 0
- JUDGE-DRILL (연속 allPASS 8 도달, 계약상 의무): Scheduled Run-now에 낙관 "✓" 피드백을 onSettled(실패에도 발화)로 주입한 고의 결함 슬라이스 — 결정적 게이트 전부 green 통과 후 독립 Opus가 정확히 FAIL: honest-state/fabrication=0 위반(실패한 트리거에 성공 표시), 형제 toggle의 onSuccess 패턴 이탈, happy-path-only 테스트 지적. 롤백 완료, 카운터 리셋. 게이트 신뢰 재확인.
- 무엇(진짜 슬라이스): 코파일럿 도구 인자 초안 — FlowDraftPayload 9필드(toolArguments), DraftableTool.inputSchema(레지스트리→라우트 관통), 프롬프트 per-tool args 힌트+Example 4, resolveToolArguments 결정적 반-날조 게이트(unknown-key·required·primitive-type·non-object 거부→repair 재시도), 웹 프리필(pretty JSON)+revision 왕복, eval 케이스 "KO tool-args"(프롬프트-리터럴 URL 복사 채점).
- 왜: 진안 큐 잔여 — 지금까지 tool 초안의 toolArguments가 {} 고정이라 인자 있는 도구는 초안 후 수동 입력 필요했음. 러너는 이미 소비(scheduler-runtime resolveTemplateJson) — 유효-비실행 아님.
- 리뷰지점: parseCurrentDraftInput은 shape-only(레지스트리 스키마는 라우트 시임 — 주석 문서화). Opus가 __proto__/constructor 주입 라이브 프로브 — Object.hasOwn 게이트가 오염 없이 기각. 
- 리스크: revision 턴에서 unparseable 텍스트영역은 {}로 강등(문서화, 채팅 비차단). 발견(기존 결함, 이 슬라이스 아님): 빈 create 패널 수동 오픈 후 코파일럿 요청 시 blank form이 revision currentDraft로 투영돼 400 — backlog ◦ 기록.
- 라이브: 격리 데모(3806) 전 사이클 — HTTP 초안(args 포함)→실브라우저 코파일럿→create 패널 프리필({"url":...}, muse.url/parse, 이름)→만들기→MCP_TOOL 잡에 toolArguments 영속→수동 트리거→lastStatus SUCCESS.
- lesson: 미커밋 편집 위 뮤테이션 원복에 `git checkout --` 사용 금지(작업 소실, 컨텍스트에서 전량 재구성으로 복구) — cp 백업 원칙 재확인([[project_main_worktree_git_hazards]]).

## fire 17 · 2026-07-18 · skill v2.1.1 · ec0343dad (인터랙티브 "전부다" 지시 — 큐 마지막 항목)
meta: value-class=new-capability · pkg=@muse/web · kind=ui-capability · verdict=PASS(opus) · firesSinceDrill=1 · consecutiveAllPASS=2
ratchet: unit flow-connection-logic 6(신규) · browser 40(+2) · fabrication 0
- 무엇: 캔버스 연결 시맨틱 — 러너가 소비하는 유일한 의미-연결(action→output.notify=notificationChannelId)에 제스처 쌍 부여: 채널 없는 흐름엔 점선 고스트 "알림 연결하기"(클릭→채널 팝오버→연결=PATCH), 실제 알림 엣지 더블클릭=해제(PATCH null). 구조 엣지는 불활성(classifyEdgeRemoval). 고스트 위치는 출력 컬럼 최하단+140px(겹침 금지 룰 — browser 스위트가 개발 중 실제 겹침을 검출해 수정).
- 왜: 진안 "박스 연결" 요청의 러너-지원 범위 구현 — 임의 그래프는 러너 미지원이라 장식 연결 대신 의미 있는 연결만. 드래그-연결은 숨김 핸들 재작업 필요로 스코프 아웃(후속 후보).
- 리뷰지점: PATCH는 기존 flowEditToJobPatch("output") 시임 재사용(2중 문법 없음); 고스트는 UI-only(서버 페이로드 불침투, opus 검증); 상세패널 열림+해제 동시 상태는 empty-state 폴백(no crash).
- 리스크(비게이팅, opus 지적): detachTitle i18n 키 미참조(디스커버러빌리티 후속에서 사용 예정); 고스트 드래그 위치가 attach 후 localStorage에 무해한 스테일 엔트리로 잔존.
- 라이브: 격리 데모(3807) 양방향 실측 — 고스트(겹침 0 측정)→팝오버→연결→실노드+엣지 / 더블클릭→고스트 복귀+서버 channelId null(종결상태).

## fire 18 · 2026-07-18 · skill v2.1.1 · (this commit)
meta: value-class=new-capability · pkg=@muse/web · kind=ui-capability · verdict=PASS(opus) · firesSinceDrill=2 · consecutiveAllPASS=3
ratchet: unit flow-edit-compile 62(+3) · browser 46(+1) · related 238 · fabrication 0
- 무엇: 도구 흐름의 도구 RE-POINT — 노드 상세의 read-only server/tool("v1/v2 concern" 보류)을 생성 패널과 같은 read-risk 캐스케이드 피커로 편집 가능하게. PATCH {mcpServerName, toolName, toolArguments} 일괄, 도구/서버 변경 시 args "{}" 리셋(구 스키마 인자 이월 차단), 쌍 미완성/args 무효/미변경/저장중엔 저장 불가(fail-close). 레지스트리서 사라진 도구를 참조하는 잡은 저장된 쌍을 선택지에 유지(라이브 흐름 타깃의 침묵 소거 방지).
- 왜: ② (a) — 스케줄러 PATCH가 이미 지원하는데(runner-supported) 빌더 UI만 막고 있던 능력. 진안 큐 "빌더가 아직 못 만드는 실행-가능한 것".
- 리뷰지점: write/execute 도구는 여전히 비노출(기록된 [decision] 유지); 서버측 scheduler-validation이 최종 권위. opus가 stale-args 이월/리스크 상승/dirty-check 공격 전부 기각, 거짓 JSDoc 1건 지적 → 같은 슬라이스에서 수정.
- 리스크: 없음(내부 폼 타입은 edit-panel 단독 소비 — create/copilot 무영향 확인).
- 라이브: 격리 데모(3808) — 실 레지스트리 13서버 캐스케이드 시딩→muse.url/parse→muse.time/now 전환(도구 옵션 캐스케이드·args 리셋 실측)→저장 영속→재실행 SUCCESS.
- self-eval 노트: fire 시작 시 apiBoot:fail은 신규 worktree stale-dist(autoconfigure 미빌드)로 판명 — tsc -b 후 green, 회귀 아님.
