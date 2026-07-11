# code-quality loop — 소스코드 구조/퀄리티 개선

브랜치 `loop/code-quality`, 워크트리 `/tmp/muse-code-quality`, cron `dc08dcdc` (20분).
모델 티어링: 분석 haiku · 계획 fable · 구현 sonnet · 난제만 opus.
행위-보존 리팩터/정리/테스트 보강만 — 기능 추가 없음. main 직접 push 금지.

## 커버리지 (한 fire = 한 영역, 전 패키지 순회)

| 영역 | 최근 fire | 상태 |
|---|---|---|
| packages/agent-core | – | 미방문 |
| packages/model | fire 1 | 방문 |
| packages/cli (apps/cli) | – | 미방문 |
| packages/memory | – | 미방문 |
| packages/recall | – | 미방문 |
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

## Fire 로그

| # | 대상 | 출하 | 검증 |
|---|---|---|---|
| 1 | packages/model | provider-openai.ts 546줄 → Chat(324줄) + provider-openai-responses.ts(234줄) 행위-보존 분리, 공개 API 불변; 미사용 import 제거 + goal-마커 테스트 제목 정리 | @muse/model build ✓ · 457 tests ✓ · lint 0 ✓ (fable 재검증) |
