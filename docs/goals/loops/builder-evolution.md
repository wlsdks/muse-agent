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
