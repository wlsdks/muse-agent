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
