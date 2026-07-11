# code-quality loop — 소스코드 구조/퀄리티 개선

브랜치 `loop/code-quality`, 워크트리 `/tmp/muse-code-quality`, cron `dc08dcdc` (20분).
모델 티어링: 분석 haiku · 계획 fable · 구현 sonnet · 난제만 opus.
행위-보존 리팩터/정리/테스트 보강만 — 기능 추가 없음. main 직접 push 금지.

## 커버리지 (한 fire = 한 영역, 전 패키지 순회)

| 영역 | 최근 fire | 상태 |
|---|---|---|
| packages/agent-core | – | 미방문 |
| packages/domain-tools | fire 2 | 방문 |
| packages/model | fire 1 | 방문 |
| packages/cli (apps/cli) | fire 5 | 방문 |
| packages/memory | fire 4 | 방문 |
| packages/recall | fire 3 | 방문 |
| packages/multi-agent | fire 8 | 방문 |
| packages/shared | – | 미방문 |
| apps/api | fire 9 | 방문 |
| apps/web | fire 18 | 방문 |
| packages/autoconfigure | fire 11 | 방문 |
| packages/shared | fire 11 | 방문 (사실상 CLEAN — 고아 docstring 1건만 큐) |
| packages/stores | fire 13 | 방문 |
| packages/mcp | fire 15 | 방문 |
| packages/tools | fire 16 | 방문 (병합 후보는 기각) |
| packages/proactivity | fire 17 | 방문 |
| packages/fs·calendar·scheduler | fire 22 | 방문 |
| packages/voice·browser·skills | fire 23 | 방문 (browser 슬라이스는 큐) |
| packages/observability·policy·a2a·mcp-shared | fire 25 | 방문 (a2a CLEAN) |
| 잔소형 8종 (secrets·cache·resilience·runtime-*·db·auth·prompts) | fire 28 | 방문 (5 CLEAN) |
| packages/macos·mascot·agent-specs·apps/desktop | fire 31 | 방문 (mascot=데이터 응집 정상, desktop=소스 없음) |
| packages/messaging | fire 32 | 방문 — **전 워크스페이스 스캔 100% 완료** |
| 기타 packages/* | – | 미방문 잔여: messaging(main 활발 — 보류)·voice·browser·skills·macos·소형 유틸들 |

## 대기 발견 큐

- ~~🚨 mcp red 7건~~ → fire 27 해결. 판별: 제품 결함 아님 — main 4eccd9971(evidence-gated met, 그라운딩 강화로 정당)의 새 fail-close 백스톱(무증거 met→unmet 강등)이 seam 테스트들의 증거-없는 met 스텁을 삼킨 것. 수리: main 자체-테스트 패턴대로 evidence 픽스처 주입 — **원래 증명하던 게이트(consent/veto/refusal-log)가 다시 실제로 시험되도록** 복원, 외부효과-0 spy 단언 무약화
- ~~consent 게이트 특정성~~ → fire 28 완료 (실조사 결과 잔존 1건뿐 — p5-seam 2번째 케이스; 나머지는 fire 27이 이미 커버)
- ~~barrel 정리 3건~~ → fire 29 일괄 완료 (identity-비교 0 확인으로 {} 인라인 deviation 승인). 큐 실질 소진 — 잔여: messaging 스캔(main 잠잠해지면), skills consolidate 106줄(신중), mcp-shared 시간파서(보류 판정), dev-순환 해소(대형·저긴급)
- 모듈화 감사 노트 (fire 26): prod 의존 그래프 비순환 ✓ (기존 순환 진단은 내 스크립트가 devDeps 합산한 과장), phantom 의존 0 ✓, 벤더 SDK 누출 검사 필요(다음 감사 fire), domain-tools↔mcp dev-순환은 통합테스트 설계상 잔존(pnpm 경고) — 해소하려면 통합테스트 별도 패키지 분리 (대형, 저긴급)

(분석에서 나왔지만 아직 집행 안 된 발견)

- packages/model/adapter-ollama.ts 707줄 — OllamaProvider / schema 정규화 / context-window 프로브 3책임 혼재 → 분리 후보 (fire 1 haiku 발견)
- packages/model/adapter-ollama.ts `safeParseToolArgs` — provider-shared `recoverToolArgsJson`의 얇은 래퍼 → 통합 후보
- 기각된 오탐 기록: gemini/anthropic stream() "중복"은 이미 synthesizeStreamEventsFromResponse 공유 헬퍼 위임이라 비중복 (재제안 금지)
- ~~packages/domain-tools P-번호 마커 15건~~ → fire 5에서 집행 완료 (cli 19건과 함께)
- apps/cli commands-ask.ts registerAskCommand 내부 1322줄 핸들러 → 단계별 함수 추출 후보 (internal-hardening M1의 후속; 대형)
- apps/cli commands-daemon-register.ts 내부 중첩 tick 함수 18개 → tick 모듈 분리 후보 (대형)
- apps/cli `resolveNotesDir(process.env as ...)` 동일 캐스트 18회 반복 → 래퍼 헬퍼 후보
- apps/cli program-helpers.ts 886줄 45+ exports (HTTP/config/auth/출력 혼재) → 분리 후보
- agent-core는 미머지 agent-core-enhance 브랜치(~22슬라이스)와 충돌 위험 → 그 브랜치가 정리될 때까지 이 루프에서 보류
- packages/domain-tools loopback-notes.ts 736줄 (6도구+judge+walk 혼재) / loopback-calendar.ts 576줄 / loopback-reminders.ts 509줄 → 분리 후보
- ~~사전존재 red: event-reminder-link.test.ts~~ → fire 6에서 해결. 정정: TZ-의존이 아니라 **시한폭탄 테스트**였음 (절대날짜 픽스처 2026-06-10이 리졸버의 now-30d 창을 07-10에 벗어남; update가 event-not-found 에러를 반환하는데 테스트가 미단언 → 하류 assert에서 엉뚱하게 실패)
- ~~시한폭탄 패턴 저장소-폭 스캔~~ → fire 7에서 완료: 실시계 seam 전수(캘린더 리졸버·CalDAV/macOS 창·routine/api cutoff·recency-decay) 역추적 결과 **추가 폭탄 0** — now-주입/fake-timers 규율이 전반적으로 건강 (fire 6 건이 유일했음)
- 침묵-실패(버린 execute) 99사이트 전수 분류 완료 (fire 7): 94 안전 / 5 수리 — 남은 잔여 위험 낮음. 새 테스트 작성 시 규칙: execute 결과를 버리고 부정 단언만 하지 말 것
- multi-agent orchestration-fan-in buildOrchestrationResponse 144줄 — lead-worker와 같은 패턴으로 분해 후보
- ~~orchestrator runSequential/runParallel 중복~~ → fire 16 집행 완료 (runWorkerStep 통합)
- 기각 (fire 16): tools workspaceHints/mutationTargetHints 병합 — sonnet의 전제-검증이 "완전 부분집합" 판정을 **반증** (실파싱: mutation 고유 14개 존재 → 병합=게이트 확장=동작 변경). 두 상수는 의도적 별도 어휘일 가능성 — 재제안 금지. 교훈: 상수 집합 비교는 regex가 아니라 실파서로 (내 검증 오류를 워커가 잡음)
- multi-agent worker-result.ts:99 parseHandoffPart가 검증은 trimmed로 하고 반환은 원본 — validateWorkerHandoff와 불일치. 동작 변경이라 루프 범위 밖, 별도 fix 후보 (하류가 trim 의존하는지 조사 필요)
- ~~tick-daemons factory~~ → fire 19에서 **범용 factory는 기각**(guard/옵션이 데몬마다 실제로 달라 투기적 추상화 — architecture.md 위배), 정직한 공통분모 3헬퍼만 추출 완료. 재제안 금지 (다시 오면 이 사유)
- apps/api multi-agent-routes.ts 불리언 필드 파싱 4벌 중복 → parseOptionalBoolean 헬퍼 후보
- apps/api server-helpers.ts 544줄 3책임(chat runner/입력 파서/HTTP plumbing) → 분리 후보
- ~~autoconfigure 격리 결함~~ → fire 12에서 해결 (크리덴셜 파일을 빈 tmp로 고정 — 정확한 누수원은 ~/.muse/messaging.json의 실등록 토큰)
- 같은 클래스 의심: resolveDotMusePath 폴백(~/.muse)을 기본으로 읽는 다른 "빈 env" 테스트가 더 있는지 스캔 후보 (autoconfigure/api 전반)
- ~~recall-hits RMW race~~ → fire 14 검증 결과 **오탐** (recordRecallHits는 이미 recordQueues per-file 직렬화 완비, prior.then(op,op) 패턴). 재제안 금지
- ~~multi-agent buildOrchestrationResponse 144줄 분해~~ → fire 14 집행 완료 (indexOf O(n²) 제거 보너스 포함)
- ~~🔒 mcp 보안성 2건~~ → fire 21(배치)에서 처리: ①redactMcpSecrets 확장 출하 (Basic/Authorization 일반형/api-key 헤더/token= 파라미터, 과잉가림 허용·누출 불허 + 직접 테스트 10) ②fingerprint null-가드는 **전제 오탐** — 시그니처 non-optional + 전 반환경로 리터럴 + fs 전부 try/catch라 undefined 불가능, 죽은 가드 미추가 (재제안 금지)
- ~~McpManager 클래스 분리~~ → fire 21에서 **opus 자문으로 기각**: 4개 Map(statuses/connections/health/tools)이 단일 name 키스페이스의 한 상태머신이라 어떤 클래스 분리도 가변 별칭 공유로 귀결. 최소안(순수 계산기 3개 추출+직접 테스트 12)만 출하, 상태 전이 코어 불가침 (재제안 금지 — 다시 오면 이 사유)
- ⚠ repo 공유 stash 잔존: stash@{0} autostash (context-aux-summary 작업 사본 — main에 8ed66e2b3로 이미 안착 확인, 팝 안 된 잔여물). 이 루프는 건드리지 않음 — 드랍은 진안 판단
- ~~stores 대형 파일 분해~~ → fire 21 완료 (weakness 485→251+analytics 270 / playbook 413→337+rewards 88; adjustPlaybookReward·decay는 I/O라 저장 파일 잔류 — 워커의 원칙적 deviation, 순환 value-의존 회피)
- ~~minutesUntil 5벌~~ → fire 21 완료 (situational-briefing의 private 중복 정의 삭제 포함)
- ~~web i18n 고아 키~~ → fire 21 완료: 실측 고아 3개만 제거 (~151 주장은 동적 접근 오인 — 동적 prefix 4종 보호)
- ~~shared 고아 docstring~~ → fire 21 완료
- fire 21 부가 발견·수리: main 커밋 0477d981이 macos-contacts-import.ts에 raw 제어바이트(RS/US/GS) 반입 → shared 바이트-위생 게이트 red였음 → \uXXXX 이스케이프로 수리 (문자열 값 바이트-동일; fire 22 머지에서 main의 자체 \x 표기 수정과 경합 → main측 채택)
- 기각 기록 (fire 22, 재제안 금지): fs asString 2벌은 trim 유무가 다른 비-중복 (write 쪽 no-trim은 공백-유의미 content 보호) / scheduler delay()는 `options.sleep ?? delay` 무괄호 참조로 실사용 (괄호-grep의 함정) / renderTemplateVariables는 직접-단위테스트 대상이라 export 정당 / fs refusal 2형은 도구별 출력 계약 가능성 — 병합은 동작 변경
- fs-write-tools 도구 생성기 5개의 approval-gate 보일러플레이트 → 후속 후보 (fs-edit-engine 분리로 파일은 533줄로 감소)
- ~~browser approval-gate 패턴~~ → fire 24 완료: haiku 조사로 게이트-증명 테스트(5사이트 전부 deny=controller호출0 spy 단언) 확인 후, 판정 공통분모만 resolveGateDecision 헬퍼로 추출 — 도구별 반환 shape·key의 부재-semantics·게이트 전후 로직 전부 불변. 잔여: 12 도구 팩토리 자체의 응답 봉투 보일러플레이트 (후속 후보, 저가치)
- browser puppeteer-controller captureSnapshot 116줄 → 성능-크리티컬 경로, 불가침 판정 (재제안 금지)
- skills AuthoredSkillStore.consolidate() 106줄 다중 관심사 → 코어 큐레이터 연산이라 신중 후보
- mcp-shared loopback-relative-time.ts 645줄 파서 → tool-calling 크리티컬 seam(시간 해석)이라 분리는 저가치·고위험 — 보류 판정
- stores 동시성 스트레스 테스트 3파일(consent/veto/objectives-concurrent)은 머신 부하시 false-timeout — 알려진 클래스, 부하 낮으면 green (fire 13 확인)
- autoconfigure buildLoopbackTools 207줄·buildRuntimeToolRegistry 279줄 → runtime-assembly와 같은 패턴 분해 후보
- packages/shared index.ts 고아 docstring (truncateErrorBody 설명이 함수와 144줄 분리) → 이동 후보 (소형)
- apps/web 후속 후보 (fire 18 스캔): i18n strings 고아 키 ~151개 의심(동적 lookup 오탐 위험 — 실파서 검증 필수), Notes/Integrations 뷰 훅 밀도(브라우저 검증 필요), ui.tsx 아이콘 상수 분리
- 루프 운영: haiku 스캔 에이전트가 워크트리에 잔여 파일(i18n_keys.txt 등)을 흘림 — 스캔 프롬프트에 "파일 생성 금지(스크래치는 /tmp)" 명시할 것 (fire 18에서 정리함)
- 루프 운영: sonnet 워커 stash 금지 위반 2회째 (fire 11) — 잔여물은 없었으나 프롬프트에 대안(git show HEAD:path) 강제 + "stash 사용시 보고서에 사유 명시" 요구 추가할 것
- ~~apps/api 사전존재 red 2파일~~ → fire 10에서 해결. 정정: 플레이크가 아니라 **낡은 테스트** — src 진화(데몬 플래그 6→8, 텔레그램 typing 표시 추가)를 테스트가 못 따라간 것. 교훈: main의 full-suite red가 방치되고 있었음 — 기능 커밋이 관련 테스트 갱신 없이 들어옴
- 루프 운영 교훈: sonnet 워커 프롬프트에 "git stash 금지" 명시할 것 (fire 2 워커가 사전존재 확인에 stash 사용 — 잔여물 없이 끝났지만 규칙 위반; fire 3부터 명시 적용됨)
- packages/recall present.ts:23 date-sort가 feeds-store의 compareFeedEntriesNewestFirst와 불일치 (unparseable date를 0 취급) → 동작 변경이라 이 루프 범위 밖, 별도 버그픽스 후보로 기록
- packages/recall select.ts 514줄 (memory/contacts/evidence 혼재) → 분리 후보
- packages/recall parse-bounded-int.ts·mime.ts는 범용 유틸이 recall에 배치됨 → 크로스패키지 이동 후보 (무거움, 신중히)
- packages/memory memory-token-trim.ts 806줄 (토큰 추정+트림 패스+컴팩션 요약 3책임) → trim-passes/compaction-summary 분리 후보 (haiku "riskiest" 경고 — 순수 이동으로만)
- packages/memory pattern-detector.ts 412줄 (time-of-day + weekly-task 두 신호) → 분리 후보
- packages/memory 두 store의 upsert 파이프라인(collectFactSupersessions/appendFactHistory 흐름)도 유사 반복 → forget 통합과 같은 패턴으로 후속 후보

## S2 (시즌2: main-유입 감시 + CLI 분해 — 2026-07-12, PR#53 main 안착 후)

| # | A파트 (유입 감시) | B파트 (CLI 분해) | 검증 |
|---|---|---|---|
| 33 | PR#53 후 유입 점검: api related 38-fail은 회귀 아닌 **대형 머지 후 stale dist** (agent-core·stores·proactivity·autoconfigure 리빌드로 전부 해소 — 커밋 불요); main의 honest-action guard·MCP 액션파킹 건강 유입 확인, main이 우리 fs 리팩터에 자체 정렬한 커밋도 확인 | commands-ask.ts 1557→1328줄: 옵션 체인 30개→ask-command-options.ts(189줄, applyAskOptions+AskOptions) + 입력-조합 단계→ask-input.ts(84줄, composeAskInput — stdin first-byte 계약 무수정, exitCode는 핸들러 잔류); NOTES_ONLY 상수는 핸들러 전용이라 억지 이동 배제 | cli related 55파일 784/784 ✓ · build ✓ · lint 0 ✓ |
| 34 | veto 채널 기능(un-veto·one-touch·silence — 안전-seam) 자체 테스트 동반 유입 확인; inbound 25-fail은 또 stale dist(autoconfigure) — 리빌드로 48/48 ✓. main이 우리 fire-33 산출물 자동 흡수(양방향 수렴 작동). 관례화: 대형 유입 후 루트 tsc -b 1회 | commands-ask.ts 1328→1202줄: 전처리 구간(userKey/topK/재색인/인덱스 로드·마이그레이션/코퍼스-개요 조기반환/온보딩 힌트)→ask-context-setup.ts(189줄, prepareAskContext — 3-kind discriminated result, exitCode 핸들러 잔류); 워커가 미사용 반환 필드를 lint로 잡아 원행위 정확 보존 | cli related 55파일 784/784 ✓ · build ✓ · lint 0 ✓ |
| 35 | 한국어 canned reply·register-mirroring(prompts+agent-core)·delegation-ack at-most-once(messaging) 유입 — 전부 자체 테스트 동반, 루트 tsc -b + messaging 445/proactivity 206 green (수리 불요); main이 우리 분리 파일(notice-synthesis)을 직접 편집해 유입 = 구조 완전 채택 신호 | commands-ask.ts 1202→1076줄: --with-tools 도구 배선 130줄(actuator/브라우저/fs+web_download/메시징 draft-first 게이트)→ask-tool-wiring.ts(170줄, buildAskToolWiring); 워커가 지시의 구간 추정을 정독으로 반증하고 실응집 단위를 특정, screenVision 홀더 참조·동기 onController를 codegraph로 확증 | cli related 55파일 784/784 ✓ · build ✓ · lint 0 ✓ |
| 36 | 알림 품질 기능(check-in 약속시점·ambient 매칭사유) 자체 테스트 동반 유입 — proactivity 211 green, 수리 불요. PR 동기화 fire (S2 첫 4-fire 주기) | commands-ask.ts 1076→765줄: 컨텍스트/시스템프롬프트 조립 347줄(dedup→LitM 재배열→stale 재강등→CRAG framing→가치충돌→개인정보·메모리·cross-lingual·활동 그라운딩→playbook→인용 화이트리스트)→ask-context-assembly.ts(516줄, assembleAskContext) — 바이트-동일 이동(들여쓰기만), prompt-block 스냅샷성 테스트(litm/crag/stale-demotion)가 byte-identity 증거; 잔여 후보=생성 블록 ~260줄 | cli related 55파일 784/784 ✓ · build ✓ · lint 0 ✓ |

## Fire 로그

| # | 대상 | 출하 | 검증 |
|---|---|---|---|
| 1 | packages/model | provider-openai.ts 546줄 → Chat(324줄) + provider-openai-responses.ts(234줄) 행위-보존 분리, 공개 API 불변; 미사용 import 제거 + goal-마커 테스트 제목 정리 | @muse/model build ✓ · 457 tests ✓ · lint 0 ✓ (fable 재검증) |
| 2 | packages/domain-tools | 토큰-동일 중복 judge-출력 파서 2벌(parseNotesJudgeOutput/parseLlmJudgeOutput) → judge-output.ts parseJudgeStringArray로 통합 + 직접 단위테스트 7건 신설 | build ✓ · 신규 7/7 ✓ · related 322/323 (red 1건은 사전존재 TZ-의존, 무관 확인) · lint 0 ✓ |
| 3 | packages/recall | present.ts 967→771줄: build*ContextBlock 10개+safeField를 context-blocks.ts(199줄)로 순수 이동(index 재export로 공개 API 불변, 임포터 12파일 갱신) + chunk-lookup 3벌을 chunks.ts findChunkByNote로 통합 | recall build ✓ · 607/607 ✓ · cli build ✓ · lint 0 ✓ (fable 재검증) |
| 4 | packages/memory | in-memory/file 두 store가 중복하던 forget() 결정 로직(키 canonicalize 해석+kind 네임스페이스 스코핑)을 순수 헬퍼 resolveForgetTarget로 통합, WHY 주석 한 벌화 + 직접 단위테스트 8건 | memory build ✓ · 685/685 ✓ · lint 0 ✓ (fable 재검증) |
| 5 | apps/cli + domain-tools | 이력-마커 sweep 34건(goal/P-번호, 테스트 제목·docstring·--help 텍스트) — WHY 보존 재작성, 파일 rename 2건(p11-email-contacts-seam→email-contacts-seam, p8-seam→situational-briefing-seam); 외부 업스트림 레퍼런스(ollama#13337/PR#6279)와 ReConcile round 시맨틱은 정당 판정 유지 | cli build ✓ · dt build ✓ · cli 1019/1019 ✓ · dt 451/452(red=알려진 TZ flake) · lint 0 ✓ |
| 6 | domain-tools (큐 집행) | 시한폭탄 테스트 해체: event-reminder-link 통합 케이스가 절대날짜 픽스처로 리졸버 창(now-30d)을 벗어나 침묵 실패 — Date-only fake timer로 고정 + update/delete 반환값 단언 3곳 보강 (제품 코드 불변) | UTC/KST/NY 3-TZ 5/5 ✓ · domain-tools 전체 791/791 최초 완전 green ✓ · lint 0 ✓ |
| 7 | 저장소-폭 결함클래스 감사 | fire-6 결함의 두 클래스를 전수 감사: ①시한폭탄(절대날짜×실시계 seam) 추가 0 확인 ②침묵-실패(버린 execute+부정 단언=가짜통과) 99사이트 분류→5건 수리(notes-save-mirror 2·contacts-tool 1·fs-read-tools 2, 결과 캡처+에러 단언) + mutation 드릴로 새 단언이 RED 됨을 증명 | 터치 스위트 34+64 green ✓ · 드릴 RED→원복 green ✓ · lint 0 ✓ |
| 8 | packages/multi-agent | runLeadWorkerTask 173줄 7책임 → module-private 3헬퍼(executeSubtasks/synthesizeWithRetryGate/detectCoordinationIssues)로 순수 재배치, 공개 API·파일 경계 불변, WHY 주석 동반 이동 | multi-agent 334/334 ✓ · api build ✓ · lint 0 ✓ (fable 재검증) |
| 9 | apps/api | server-routes.ts 670→31줄: 10 exports를 도메인 5파일(core-chat/admin-run/auth/agent-tools/session-runtime)로 순수 이동, 재export 배럴로 임포터 무변경; AdminGate는 admin-run 소유+타입 import | api build ✓ · related 32파일 163/163 ✓ (전체 스위트 red 3건은 그래프 밖 사전존재 플레이크 확증) · lint 0 ✓ |
| 10 | apps/api (큐 집행) | 낡은 테스트 2파일 갱신: settings-routes(데몬 플래그 6→8 고정목록 갱신, 변경-감지기 방식 유지) + p1-seam(sendChatAction 등장에 맞춰 sendMessage 필터 단언 + endpoint 집합 단언 보강) — 둘 다 src 무변경 | api 전체 130파일 793/793 완전 green ✓ · lint 0 ✓ |
| 11 | packages/autoconfigure (+shared 스캔) | createMuseRuntimeAssembly 397→209줄: 조립을 6개 module-private 단계 헬퍼(관측스택/모델·스토어/개인스토어/툴링/훅·컨텍스트/에이전트런타임)로 순수 재배치, 배선 순서·lazy-closure 계약 보존, 공개 표면 불변 | autoconfigure build ✓ · 어셈블리 e2e+wiring 83/84 (red 1건=diff 밖 사전존재 격리결함 확증) · lint 0 ✓ |
| 12 | autoconfigure (큐 집행) + 머지 | ①main 충돌 해소: settings-routes(9플래그 main측)+p1-seam(main측+우리의 강한 endpoint-집합 단언 보존 — 양쪽이 같은 낡은 테스트를 각자 고친 경합) ②buildInboxContextProvider 테스트 격리: 크리덴셜 파일을 빈 tmp로 고정, 실머신 ~/.muse/messaging.json 토큰 누수 차단 | 충돌 2파일 5/5 ✓ · autoconfigure.test 62/62 ✓ (실토큰 있는 머신에서 green) · build ✓ · lint 0 ✓ |
| 13 | packages/stores | 15벌 토큰-동일 quarantineCorruptStore를 store-quarantine.ts 한 벌로 통합(파일 15개 수정, fs 죽은 import 3건 동반 제거) + 직접 단위테스트 4건; 부수리 main발 lint error(messaging-setup-routes 죽은 매개변수) 제거 | stores build ✓ · quarantine 4/4 ✓ · messaging 15/15 ✓ · 동시성 3파일 저부하 8/8 ✓(고부하 flake=알려진 클래스) · lint 0 ✓ |
| 14 | multi-agent (큐 집행) + 머지 | ①recall-hits RMW race NO-SHIP(오탐 — 이미 직렬화 완비) ②main 충돌 해소(messaging-setup-routes lint 수정 경합 — main측 _options 채택, 분기 최소화) ③buildOrchestrationResponse 144→48줄: 4 헬퍼(projectWorkerOutputs/buildCompletedParts/synthesizeAndVerify/detectFanInIssues) 순수 재배치 + indexOf O(n²)→O(n) | multi-agent 334/334 ✓ · lint 0 ✓ (fable 재검증) |
| 15 | packages/mcp | toErrorMessage 3벌(manager/transport/index) → error-utils.ts 통합 + index.ts 408→343줄(createMcpMuseTool·redactMcpSecrets를 mcp-tool-factory.ts로 순수 이동, 재export로 공개 표면 불변); 보안성 발견 2건은 동작 변경이라 큐로 | mcp build ✓ · 779/779 ✓ · lint 0 ✓ (fable 재검증) |
| 16 | tools 스캔 → multi-agent (큐 집행) | tools 힌트 병합은 워커 전제-검증이 반증해 NO-SHIP(위 기각 기록); 대체로 orchestrator runSequential(38)·runParallel(26)의 worker당 중복 흐름을 runWorkerStep 헬퍼(33줄)로 통합 — publish fire-safe 자세·에러 구분(원본 vs new Error(reason)) 보존, 소비부가 errorMessage만 쓰므로 non-Error 래핑도 문자열-동일 | multi-agent 334/334 ✓ · build ✓ · lint 0 ✓ (fable 재검증) |
| 17 | packages/proactivity | proactive-notice-loop.ts 899→621줄: 수집/포맷을 notice-imminent.ts(168줄), 합성/그라운딩을 notice-synthesis.ts(152줄)로 순수 이동, 이동 공개심볼 재export로 소비자(cli 데몬·api tick·테스트) 무변경; @muse/stores 4중 import 통합 | proactivity 113/113 ✓ · cli+api build ✓ · api notice 3파일 6/6 ✓ · lint 0 ✓ (fable 재검증) |
| 18 | apps/web | SSE 프레임 파싱 3벌 통합(sse-frames.ts — chat/notice의 last-data-line 인라인 파서를 ask의 join-all 헬퍼로; 실트래픽 JSON 단일라인이라 관찰-동일, 잠재 divergence 제거) + readToken 2벌 → lib/token-storage.ts; 레이아웃/JSX 무변경이라 브라우저 검증 불요 | web vitest 39파일 249/249 ✓ · tsc+vite build ✓ · lint 0 ✓ |
| 19 | apps/api (큐 집행) | tick-daemons.ts 719→664줄: 범용 factory 기각(투기적 추상화) 후 정직한 3헬퍼 — stopOnClose ×10 · optionalNumber ×23 · resolveMessagingTarget ×9(registry 동반 반환으로 타입-내로잉 보존); 다른 semantics 사이트(daily-cap 0-폴백, ?? "90")는 의도적 보존 | api build ✓ · 데몬 테스트 9파일 31/31 ✓ · lint 0 ✓ (fable 재검증) |
| 20 | packages/stores (큐 집행) | personal-episodes-store.ts 554→286줄: 분석 계층(retention/themes/absence/consolidation, 275줄)을 episode-analytics.ts로 순수 이동 — vacuum→analytics 단방향 value import, 역참조는 type-only(런타임 순환 0), 재export로 소비자 무변경; 떠돌던 vacuum docstring 제자리 복귀 | stores build ✓ · episode 스위트 29/29 ✓ · mcp 7/7·proactivity·cli build ✓ · lint 0 ✓ |
| 21 | 배치 (진안 지시 "큐 한번에") | sonnet 4병렬(stores 2분해·mcp 보안·proactivity+shared 소형·web i18n) + opus 설계자문(McpManager — 분리 기각·최소안) + sonnet 구현 + fable 직접수리(macos raw 제어바이트). 오탐 2건 추가 기각(fingerprint·i18n 151), 원칙적 deviation 1건 승인(playbook I/O 잔류) | stores 116/116(격리)+flake 트리오 8/8 ✓ · mcp 800/800 ✓ · proactivity 113/113 ✓ · shared 47/47 ✓(위생 게이트 복구) · web 249/249 ✓ · macos 215/215 ✓ · lint 0 ✓ |
| 22 | fs·calendar·scheduler (2회차) + 머지 | fs-write-tools 748→533줄: 순수 텍스트-편집 엔진(fuzzy 매칭·유니코드 폴딩·적용, 224줄)을 fs-edit-engine.ts로 이동(바이트-동일 diff 확인, 재export로 임포터 무변경) + calendar 죽은 공개 export 축소; scheduler delay는 워커 전제-검증이 실사용 발견해 미착수 (위 기각 기록) | fs 184/184 ✓ · calendar 164/164 ✓ · scheduler 117/117(무변경 확인) ✓ · autoconfigure build ✓ · lint 0 ✓ |
| 23 | voice·browser·skills | authored-skill-store 740→563줄: 독립 유틸 계층(리스크 스캔·유사도·eviction 랭킹·잡 참조, 216줄)을 skill-analysis.ts로 순수 이동(데이터-흐름 기준 경계 조정 — 클래스 전용 타입/상수/IO는 잔류), 재export로 소비자 무변경 + voice safeReadText 2벌(바이트-동일 확인) → http-utils.ts | skills 85/85 ✓ · voice 145/145 ✓ · autoconfigure build ✓ · lint 0 ✓ (fable 재검증) |
| 24 | browser (신중-큐 집행) | 게이트-증명 테스트 존재를 haiku 조사로 선확인(5사이트 deny=spy 0효과) 후 approval-gate 판정 공통분모만 resolveGateDecision으로 추출(문자열 바이트-동일, shape·부재-semantics·전후 로직 불변); 게이트-증명 테스트 무수정 green이 행위-보존의 증거 | browser 120/120 ✓ (테스트 diff 0) · build ✓ · lint 0 ✓ |
| 25 | observability·policy (+a2a·mcp-shared 스캔) | policy toGlobal 토큰-동일 3벌(injection/pii/sanitizer — 보안 결정론 코드의 desync 위험) → regex-utils.ts 한 벌 + 직접 테스트 5; observability index.ts 457→297줄(FollowupSuggestionStore·StartupDoctor 구현체를 별도 모듈로, 인터페이스 계약은 index 잔류, 기존 type-only 역참조 패턴 준수) | policy 170/170 ✓ · observability 141/141(+2skip) ✓ · autoconfigure build ✓ · lint 0 ✓ |
| 26 | 모듈화 감사 (진안 지시) | 전 워크스페이스 기계 감사(순환·phantom·tsconfig 정합) → mcp-split 잔재 오배치 테스트(mcp/src의 messaging-retry.test가 mcp-shared 모듈을 테스트) mcp-shared/test/messaging-retry-ladder.test.ts로 이전(5케이스, 기존 4케이스와 상호보완 확인); 진단 정정 2건(prod 그래프는 이미 비순환 — 스크립트 과장 / deps는 이미 devDeps) + 🚨 mcp red 7건 신규 발견(위 큐) | mcp 788/795(red 7=사전존재, baseline worktree로 동일재현 확증) · mcp-shared 73/73 ✓ · domain-tools build ✓ · lint 0 ✓ |
| 27 | mcp seam 테스트 (🚨 큐 집행) | evidence-gate 회귀 7건 수리: main 4eccd9971의 무증거-met→unmet 백스톱이 seam 테스트의 met 스텁을 선점 — evidence 픽스처 주입으로 원래 게이트(consent fail-close·veto 지속·refusal 로깅)가 다시 실제 시험되게 복원, 제품 코드 diff 0, 안전 단언 무약화 (p6/undo는 tick2까지 고쳐 veto 경로가 가면 아닌 실경로로) | 5파일 22/22 ✓ · mcp 전체 795/795 완전 green 복귀 ✓ · lint 0 ✓ (fable 재검증) |
| 28 | prompts + mcp (잔소형 마감) | 잔소형 8패키지 스캔(5 CLEAN, 정합성 버그 0)으로 1차 전수 순회 완성; prompts index.ts 609→405줄(exemplar retriever 계층 210줄 분리, regex 이스케이프 바이트-보존 확인) + p5-seam 잔존 1케이스 consent-게이트 특정성 복원(evidence 주입, 단언 무변경) | prompts 41/41 ✓ · mcp seam 4파일 14/14 ✓ · agent-core build ✓ · lint 0 ✓ |
| 29 | cache·resilience·runtime-state (큐 일괄) | barrel 정리 3건: cache-metrics 192줄(가격표까지 — 메트릭 전용 확증) / fallback-strategy 109줄(공유 에러분류는 error-classifier로, CircuitBreakerRegistry는 상태결합이라 잔류 판단) / run-history 641→364줄(구현 2파일 분리, 재export를 index로 올려 역참조 0) — 전 분리가 단방향 의존 달성 | cache 22 · resilience 58 · runtime-state 50 전부 ✓ · autoconfigure+api build ✓ · lint 0 ✓ (identity-비교 0 확인) |
| 30 | 의미 병합 (main identity-core 낙하) | 루프-분해 3파일과 main 신기능(composeIdentityPrompt 전면 캐스케이드·persona 배선·prompt lab) 경합 해소 — 구조=HEAD·행위=main 원칙: ①runtime-assembly 스케줄러 이중화 제거 + **git 자동-머지가 persona 배선을 buildObservabilityStack에 죽은 코드로 오배치한 침묵 버그 발견·교정**(promptLayerRegistry를 buildAgentRuntime까지 관통 배선) ②notice-synthesis에 composeIdentityPrompt 이식 ③prompts 중복 선언 제거+comparePromptLayers export 보완; identity-core 상시 ~290tok로 인한 테스트 캡 2건 실측 조정 | prompts 72/72 ✓ · autoconfigure 97파일 701/701 ✓ · proactivity 136/136 ✓ · api build ✓ · lint 0 ✓ |
| 31 | packages/macos (스캔 마감) | 미러 2벌 공통화: TRUTHY_ENV_VALUES+WHY 주석·env 게이트·exec후 에러-매핑(timeout/exitCode/권한힌트/catch)을 mirror-shared.ts로 — 라벨 치환로 출력 문자열 바이트-동일(기존 toContain 단언 무수정 통과가 증거), 각 미러는 preamble만 유지; 기각 1(escapeNoteBodyHtml dead-export 주장 — 테스트 직접 import라 정당), 큐 추가(macos-app-read-tool 480줄 switch 2개·agent-specs evictOverflow 저긴급) | macos 215/215 ✓ · build ✓ · lint 0 ✓ |
| 32 | packages/messaging (보류 해제 — 스캔 100%) | 충돌-안전 2건만 채택(활성 영역 회피): after-store 커서 사이드카 2벌(함수명·주석만 다른 동일 구현) → channel-cursor-store.ts 제네릭 한 벌 + 기존 파일 얇은 위임(79/76→20/19줄, 소비자 무변경) + clampLongPollSeconds 2벌 → provider-helpers(max 명시 매개변수, 호출부 50/60); telegram/matrix의 활성 영역(HTTP 에러 보일러·비대화)은 main 안정화 후 후보로 큐 | messaging 39파일 431/431 ✓ · build ✓ · lint 0 ✓ |
