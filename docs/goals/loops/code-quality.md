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
| packages/multi-agent | – | 미방문 |
| packages/shared | – | 미방문 |
| apps/api | – | 미방문 |
| apps/web | – | 미방문 |
| 기타 packages/* | – | 미방문 |

## 대기 발견 큐

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
- ⚠ 사전존재 red: packages/domain-tools test/event-reminder-link.test.ts "delete removes the linked reminder…" — dueAt 2시간 오프셋, 머신 TZ/DST 의존 단언. 테스트를 TZ 고정으로 결정론화하는 수리 후보 (fire 2에서 발견, 무관 확인)
- 루프 운영 교훈: sonnet 워커 프롬프트에 "git stash 금지" 명시할 것 (fire 2 워커가 사전존재 확인에 stash 사용 — 잔여물 없이 끝났지만 규칙 위반; fire 3부터 명시 적용됨)
- packages/recall present.ts:23 date-sort가 feeds-store의 compareFeedEntriesNewestFirst와 불일치 (unparseable date를 0 취급) → 동작 변경이라 이 루프 범위 밖, 별도 버그픽스 후보로 기록
- packages/recall select.ts 514줄 (memory/contacts/evidence 혼재) → 분리 후보
- packages/recall parse-bounded-int.ts·mime.ts는 범용 유틸이 recall에 배치됨 → 크로스패키지 이동 후보 (무거움, 신중히)
- packages/memory memory-token-trim.ts 806줄 (토큰 추정+트림 패스+컴팩션 요약 3책임) → trim-passes/compaction-summary 분리 후보 (haiku "riskiest" 경고 — 순수 이동으로만)
- packages/memory pattern-detector.ts 412줄 (time-of-day + weekly-task 두 신호) → 분리 후보
- packages/memory 두 store의 upsert 파이프라인(collectFactSupersessions/appendFactHistory 흐름)도 유사 반복 → forget 통합과 같은 패턴으로 후속 후보

## Fire 로그

| # | 대상 | 출하 | 검증 |
|---|---|---|---|
| 1 | packages/model | provider-openai.ts 546줄 → Chat(324줄) + provider-openai-responses.ts(234줄) 행위-보존 분리, 공개 API 불변; 미사용 import 제거 + goal-마커 테스트 제목 정리 | @muse/model build ✓ · 457 tests ✓ · lint 0 ✓ (fable 재검증) |
| 2 | packages/domain-tools | 토큰-동일 중복 judge-출력 파서 2벌(parseNotesJudgeOutput/parseLlmJudgeOutput) → judge-output.ts parseJudgeStringArray로 통합 + 직접 단위테스트 7건 신설 | build ✓ · 신규 7/7 ✓ · related 322/323 (red 1건은 사전존재 TZ-의존, 무관 확인) · lint 0 ✓ |
| 3 | packages/recall | present.ts 967→771줄: build*ContextBlock 10개+safeField를 context-blocks.ts(199줄)로 순수 이동(index 재export로 공개 API 불변, 임포터 12파일 갱신) + chunk-lookup 3벌을 chunks.ts findChunkByNote로 통합 | recall build ✓ · 607/607 ✓ · cli build ✓ · lint 0 ✓ (fable 재검증) |
| 4 | packages/memory | in-memory/file 두 store가 중복하던 forget() 결정 로직(키 canonicalize 해석+kind 네임스페이스 스코핑)을 순수 헬퍼 resolveForgetTarget로 통합, WHY 주석 한 벌화 + 직접 단위테스트 8건 | memory build ✓ · 685/685 ✓ · lint 0 ✓ (fable 재검증) |
| 5 | apps/cli + domain-tools | 이력-마커 sweep 34건(goal/P-번호, 테스트 제목·docstring·--help 텍스트) — WHY 보존 재작성, 파일 rename 2건(p11-email-contacts-seam→email-contacts-seam, p8-seam→situational-briefing-seam); 외부 업스트림 레퍼런스(ollama#13337/PR#6279)와 ReConcile round 시맨틱은 정당 판정 유지 | cli build ✓ · dt build ✓ · cli 1019/1019 ✓ · dt 451/452(red=알려진 TZ flake) · lint 0 ✓ |
