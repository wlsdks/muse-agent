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
| packages/cli (apps/cli) | – | 미방문 |
| packages/memory | – | 미방문 |
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
- packages/domain-tools P-번호 마커 주석 15건 (notes-investigator/situational-briefing/email-send/web-action/smart-home 등 헤더 + 테스트 제목) → 마커만 걷어내고 WHY는 보존하는 sweep 후보
- packages/domain-tools loopback-notes.ts 736줄 (6도구+judge+walk 혼재) / loopback-calendar.ts 576줄 / loopback-reminders.ts 509줄 → 분리 후보
- ⚠ 사전존재 red: packages/domain-tools test/event-reminder-link.test.ts "delete removes the linked reminder…" — dueAt 2시간 오프셋, 머신 TZ/DST 의존 단언. 테스트를 TZ 고정으로 결정론화하는 수리 후보 (fire 2에서 발견, 무관 확인)
- 루프 운영 교훈: sonnet 워커 프롬프트에 "git stash 금지" 명시할 것 (fire 2 워커가 사전존재 확인에 stash 사용 — 잔여물 없이 끝났지만 규칙 위반; fire 3부터 명시 적용됨)
- packages/recall present.ts:23 date-sort가 feeds-store의 compareFeedEntriesNewestFirst와 불일치 (unparseable date를 0 취급) → 동작 변경이라 이 루프 범위 밖, 별도 버그픽스 후보로 기록
- packages/recall select.ts 514줄 (memory/contacts/evidence 혼재) → 분리 후보
- packages/recall parse-bounded-int.ts·mime.ts는 범용 유틸이 recall에 배치됨 → 크로스패키지 이동 후보 (무거움, 신중히)

## Fire 로그

| # | 대상 | 출하 | 검증 |
|---|---|---|---|
| 1 | packages/model | provider-openai.ts 546줄 → Chat(324줄) + provider-openai-responses.ts(234줄) 행위-보존 분리, 공개 API 불변; 미사용 import 제거 + goal-마커 테스트 제목 정리 | @muse/model build ✓ · 457 tests ✓ · lint 0 ✓ (fable 재검증) |
| 2 | packages/domain-tools | 토큰-동일 중복 judge-출력 파서 2벌(parseNotesJudgeOutput/parseLlmJudgeOutput) → judge-output.ts parseJudgeStringArray로 통합 + 직접 단위테스트 7건 신설 | build ✓ · 신규 7/7 ✓ · related 322/323 (red 1건은 사전존재 TZ-의존, 무관 확인) · lint 0 ✓ |
| 3 | packages/recall | present.ts 967→771줄: build*ContextBlock 10개+safeField를 context-blocks.ts(199줄)로 순수 이동(index 재export로 공개 API 불변, 임포터 12파일 갱신) + chunk-lookup 3벌을 chunks.ts findChunkByNote로 통합 | recall build ✓ · 607/607 ✓ · cli build ✓ · lint 0 ✓ (fable 재검증) |
