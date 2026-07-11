# response-experience loop — journal

Theme: 어시스턴트 응답 경험 지속 개선 (채널 대화 리듬 · 개입 예산/다이제스트 · 원터치 veto 기반).
Registered 2026-07-12 by 진안 직접 요청 (20m cron, verified-fire → main FF push opt-in).

## fire 1 · 2026-07-12 · skill v2.x · 00d97dad1
meta: value-class=new-capability · pkg=@muse/agent-core+cli+api · kind=i18n-parity · verdict=PASS · firesSinceDrill=1
ratchet: testFiles +2 · fabrication 0 · eval:channel-rhythm 14/14 (judge re-run, baseline AND diff)
무엇: 캔드 casual 응답 한국어 패리티 — CASUAL_RESPONSES_KO + containsHangul, casualResponseFor(kind, korean=false) 기본값 EN byte-identical; CLI ask fast-path + 채널 casual fast-path 양표면 배선.
왜: KO 패턴은 이미 매치되는데 응답만 영어 고정 — 한국어 사용자 첫인상 결함(응답 경험 테마 1순위).
리뷰지점: KO 카피 3종(인사/감사/작별)이 EN 의도와 1:1, 인용 토큰 0; Jamo-only(ㅎㅇ/ㅋㅋ)는 casual 미분류로 폴스루(결함 아님, 판정자 확인).
리스크: 낮음 — 기본값 무변경, 신규 분기 결정론.
lesson: 워커가 검증 중 `git stash`(금지)를 체인 커맨드로 사용 → 툴 타임아웃으로 pop 미실행, 수동 복구. 루프 워커 프롬프트에 stash-금지가 있어도 재발 — 워커 지시에 "eval은 수정본 트리에서만, 베이스라인 비교는 별도 worktree" 명시가 예방책.
lesson: eval:channel-rhythm 57% FAIL은 동시 루프發 Ollama 포화의 일시 아티팩트(판정자 재실행: 베이스라인·수정본 둘 다 100%) — composeAck 15s 타임아웃은 부하에 민감; 배터리 빨강이면 먼저 단독 재실행으로 부하 가설 배제.

## fire 2 · 2026-07-12 · skill v2.x · 6f5d70a73
meta: value-class=test-pinning · pkg=@muse/memory+proactivity · kind=notice-rationale-pin · verdict=PASS · firesSinceDrill=2
ratchet: 근거절 mutation-pin 3건(이전엔 소실돼도 0 테스트 실패) · fabrication 0 · eval N/A(채널 경로 무접촉)
무엇: pattern 알림의 "왜 지금" 근거 절이 이미 감지기에 verbatim으로 존재함을 확인(피벗) — 소스 무변경, load-bearing pin 3건 + 형제 2건(ambient/commitment) backlog 라우팅.
왜: 근거 없는 프로액티브=감시감; 근거 절이 조용히 사라지는 회귀 클래스가 무감지였음.
리뷰지점: 판정자 발굴 잔여 갭 — LLM-합성 경로는 절 존재 미보장(신규 ◦로 큐잉).
리스크: 없음(테스트+docs만).

## fire 3 · 2026-07-12 · skill v2.x · 57dabb905
meta: value-class=reliability+regression-fix · pkg=@muse/messaging+api+proactivity · kind=retry-dedupe+type-contract · verdict=PASS · firesSinceDrill=3
ratchet: testFiles +2 · fabrication 0 · eval N/A(composeAck 무접촉)
무엇: (A) 위임 ack가 재시도에도 최대 1회만 배달 — ackAlreadySent 사이드카(500 bound, fail-open), notify 자체를 미배선해 composeAck 호출도 절약. (B) 베이스라인 tsc 회귀 수정 — ProactiveAgentRuntimeLike.metadata를 JsonObject 정확-매치로(반변 위치 variance 트랩), 양성 컴파일 pin 추가.
왜: (A) 큐잉된 수용-엣지의 실제 봉인. (B) 클린 리빌드에서만 드러나는 main 빌드 파손.
리뷰지점: acked-but-never-handled 항목이 500-eviction 후 중복 ack 가능(수용 엣지, 인박스 트림이 먼저 제거).
리스크: 낮음 — 옵션 부재 시 byte-동일 pin.
lesson: 회귀 491a1772c는 duck-type 계약(metadata 추가)을 바꾸면서 소비 패키지(apps/api)를 빌드하지 않아 침묵 출하 — 좁은-게이트 정책의 사각. 공유 duck-type을 바꾸면 그 소비자 패키지 빌드가 형제-감사에 포함되어야 함. 양성 assignability pin이 재발 방지.

## fire 4 · 2026-07-12 · skill v2.x · 726915d74
meta: value-class=new-capability · pkg=@muse/proactivity(+mcp tests) · kind=rationale-source · verdict=PASS · firesSinceDrill=4
ratchet: testFiles +0(기존 3파일 갱신+핀 추가) · fabrication 0 · eval N/A(채널 답장 경로 무접촉)
무엇: ambient 알림에 "(field에 'pattern' 포함되어 매칭)" 결정론 근거 절 — 이미 계산되던 매칭 증거 재사용, ≤2쌍 명시+"외 N개" 접기, knowledge-trigger는 구조적 증거 부재로 의도적 무절(pin).
왜: 근거 없는 룰 알림은 "왜 지금?"이 없음 — 가치⑤ ambient 몫.
리뷰지점: 룰 패턴(소유자 저작)이 verbatim으로 알림에 흐름 — 자기-주입만 가능(기존 rule.message와 동일 신뢰경계, backlog의 중화-검토 ◦가 일반론 커버).
리스크: 낮음.
lesson: ★NEVER-stash 위반 2회째(fire 1에 이어) — 워커 지시의 금지 문구만으론 재발함. 다음 fire부터 워커 프롬프트에 "RED 증거는 cp 백업→편집→복원으로만, git stash는 어떤 형태(--keep-index 포함)로도 금지"를 절차로 명시(금지가 아니라 대체 절차를 지시).

## fire 5 · 2026-07-12 · skill v2.x · cbbe29a82
meta: value-class=new-capability · pkg=@muse/proactivity · kind=rationale-source · verdict=PASS · firesSinceDrill=5
ratchet: testFiles +0(기존 테스트파일 확장 5케이스) · fabrication 0 · eval N/A(채널 답장 경로 무접촉)
무엇: 체크인 질문에 "(N일 전 남기신 약속)"/"(made N days ago)" 결정론 나이 절 — createdAt→due 기준 스케줄 시점 bake, <1일·무효·미래 타임스탬프는 무절(fail-closed). 근거 3부작(pattern·ambient·commitment) 완성.
왜: 약속 원문만으론 "언제 한 약속인지"가 없음 — 가치⑤ 마지막 몫.
리뷰지점: 지연 배달 시 나이가 downtime만큼 하향-오차(판정: bounded 근사, fabrication 아님) — 절대날짜 절 후속 ◦ 큐잉.
리스크: 낮음 — runDueCheckins·게이트 무접촉.

## fire 6 · 2026-07-12 · skill v2.x · 191ef7bb7
meta: value-class=security-hardening · pkg=@muse/proactivity+agent-core+recall · kind=security-review · verdict=PASS · firesSinceDrill=6
ratchet: testFiles +1(prompt-escape 이동) · fabrication 0 · eval N/A(ack 경로 무접촉)
무엇: digest 렌더 시점 injection-span 중화 — 단일 렌더 함수(formatDigestItemLine)가 flush·CLI 양표면 커버, recap과 동일 조합(escapeSystemPromptMarkers∘neutralizeInjectionSpans); 저장은 verbatim 유지(감사성). prompt-escape 헬퍼 recall→agent-core 이동(의존 방향 정리, byte-동일+re-export 무파손).
왜: 조사 결과 사용자-저장 텍스트(패턴 제안·약속 원문·ambient enrich)가 실제로 큐를 탐 — 중화 필요가 실재.
리뷰지점: --json은 raw 덤프(로컬 read-only, 수용); 5개 루프의 직접-전송 경로는 기존 관례대로 미중화(backlog에 명시 유지).
리스크: 낮음 — 중화는 subtractive, clean text byte-동일 pin.

## fire 7 · 2026-07-12 · skill v2.x · ccc729af6
meta: value-class=refinement · pkg=@muse/proactivity · kind=rationale-refinement · verdict=PASS · firesSinceDrill=7
ratchet: testFiles +0(6 테스트 재작성+2 pin) · fabrication 0 · eval N/A
무엇: 체크인 절을 "(N일 전)"→"(7/5에 남기신 약속)" 절대날짜로 — 지연 배달 하향-오차 클래스 제거, 이전-연도는 연도 포함, 클럭-스큐에도 잘못된 연도 embellishment 없음(판정자 프로브 확인).
왜: fire 5 판정자 권고 — 절대날짜는 구조적으로 stale 불가.
리뷰지점: 미래-createdAt 가드 제거는 유일 콜사이트에서 도달 불가(판정 확인); 외부-소스 createdAt 콜러가 생기면 가드 복원(비게이팅 권고).
리스크: 낮음.

## fire 8 · 2026-07-12 · skill v2.x · acfa5f6f9
meta: value-class=baseline-restore · pkg=@muse/shared · kind=regression-fix · verdict=PASS · firesSinceDrill=8
ratchet: 기준선 lint+envInventory 복구 · fabrication 0 · eval N/A
무엇: 타 루프 머지發 회귀 2건 복구 — secret-patterns 정규식 불필요 이스케이프(의미보존 프로브 6입력 동일) + 미사용 import + ENV.md 재생성(MUSE_WINDOWS_ACTUATORS 추가).
왜: 규칙 ① — 깨진 기준선 위에 새 슬라이스 없음.
리뷰지점: origin/main에 파손 실재 확인 후 복구(판정자 검증).
리스크: 없음.
lesson: 대형 머지 유입 직후 fire는 self-eval 회귀 흡수 역할을 함 — 루프의 기준선-우선 규칙이 실전에서 작동.

## fire 9 · 2026-07-12 · skill v2.x · 6bdbc4232
meta: value-class=judge-drill · pkg=@muse/proactivity · kind=drill · verdict=FAIL(의도됨) · firesSinceDrill=0(리셋)
ratchet: 드릴 성공 — 판정자 보정 확인 · fabrication 0
무엇: JUDGE-DRILL(연속 8 PASS 트리거) — digest-sent 레이스 "가짜 수정"(mark-before-send + pin 반전 은폐, 스위트 전체 green) 주입 → 무고지 신선 판정자가 결함 3종 전부 적발하며 FAIL: ①레이스 미봉합(atomicWriteFile≠락, 스토어 docstring 인용) ②전송실패→당일 다이제스트 증발(fail-close 역행, 모듈 docstring 위반) ③pinned 불변식 반전+이름 위장. 롤백 완료, 트리 원복.
왜: 하드-카운터 — 연속 PASS가 judge 물러짐이 아님을 주기적으로 증명.
리뷰지점: 판정자가 backlog 스펙("원자적 마킹")과 diff의 괴리까지 짚음 — 요건을 backlog ◦에 정밀화해 반영.
리스크: 없음(주입분 전량 롤백, 저널/backlog만 커밋).
lesson: 결정론 스위트가 green이어도 pin 반전은 diff-리뷰만 잡는다 — judge의 "테스트 변경 정밀 심사" 단계가 실효 방어선임이 실측됨.

## fire 10 · 2026-07-12 · skill v2.x · 68d4b37de
meta: value-class=reliability · pkg=@muse/stores+proactivity · kind=concurrency · verdict=PASS · firesSinceDrill=1
ratchet: testFiles +1(digest-lock) · fabrication 0 · eval N/A
무엇: digest-sent 레이스 진짜 수정 — withDigestLock(O_EXCL wx+nonce+5min stale-break+no-spin, 락 오류는 fail-open으로 오늘 동작에 강등), 임계구역 check→send→drain→mark 전체 잠금, mark-after-send 불변식 유지, 두-데몬 Promise.all 시뮬레이션 pin(정확히 1건 전송, 3/3 안정).
왜: fire 9 드릴이 정밀화한 스펙의 실구현 — 드릴→진짜 fix 사이클 완결.
리뷰지점: TOCTOU 잔여(>5min+정밀 인터리브, 최악이 중복 전송=fail-open 방향)·EACCES 코너는 수용(관례 미러), 후자는 ◦ 기록.
리스크: 낮음.
lesson: 형제-감사가 동일 클래스 레이스 2건(리마인더·체크인 이중 전송) 발굴 — send-결정이 락 밖인 패턴은 store-락만으론 이중 배달을 못 막는다.

## fire 11 · 2026-07-12 · skill v2.x · 03e0f2d1e
meta: value-class=reliability · pkg=@muse/stores+proactivity · kind=concurrency · verdict=PASS · firesSinceDrill=2
ratchet: testFiles +1(reminder-firing-lock) · fabrication 0 · eval N/A
무엇: 리마인더 이중 전송 레이스 봉합 — fire 10 락을 withProcessLock으로 범용화(fire 10 테스트 무수정 green), runDueReminders select→send→mark 전체를 `${file}.firing.lock`으로 잠금(추출만, 재배열 없음 — byte-diff 확인), 두-데몬 시뮬레이션 5/5 안정.
왜: fire 10 형제-감사 발굴 — store-락만으론 send 결정을 못 지킴.
리뷰지점: FLAG — 5분 stale-break vs pathological 긴 틱(다수 due×재시도 30s 캡)에서 in-flight 1건 중복 가능(pre-fix보다 엄격히 나음, 비차단); 체크인 몫은 이제 withProcessLock 3줄 채택.
리스크: 낮음.
