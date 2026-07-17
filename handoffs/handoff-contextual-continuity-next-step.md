# Contextual Continuity next step

## 헤더 (목표 + 맥락)

- **작업 이름:** contextual-continuity-next-step
- **한 줄 목표:** `adjusted` 피드백 뒤의 Continuity Pack이 contextual action line에서 task 제목을 반복하지 않고, 사용자 작성 task notes 또는 그 notes에 첫 행동을 추가하는 정확한 로컬 명령을 보여준다.
- **제품 맥락:** 8번째 실제 dogfood에서 exact task 복원은 맞았지만 next step이 task 제목을 그대로 반복해 `adjusted`로 판정됐다. 결과가 실제 다음 Pack을 개선해야 Attunement loop가 성립한다.
- **현재 단계:** `DONE`
- **담당(현재):** complete

## 1. 수용 기준 (검증 가능한 PASS 조건)

- [x] `adjusted`가 만든 `contextual` 정책에서 linked open task에 notes가 있으면, 다음 Pack의 contextual action line은 task 제목 대신 그 user-authored notes를 근거 그대로 표시한다. Notes는 의미를 재해석하지 않고, 모든 공백/개행을 한 칸으로 정규화하고 trim한 뒤 최대 240 UTF-16 code units로 제한한다.
- [x] notes가 없거나 공백뿐이면 제목을 행동인 것처럼 반복하지 않고, 정확히 `muse tasks edit <id> --notes "<first concrete action>" --local` 명령으로 구체화 방법을 안내한다.
- [x] baseline `direct`, `hidden`, exact-source, no-model, explicit-outcome 동작은 바뀌지 않는다.
- [x] task 제목은 exact evidence인 `Connected context`에 계속 표시할 수 있지만 contextual action line에는 반복하지 않는다.
- [x] 공개 CLI 흐름으로 non-empty notes, whitespace/missing notes, exact `--local` fallback, unchanged direct/hidden을 검증한다.
- [x] 실제 로컬 dogfood 전에 thread `thread_6c38aaf7-d3ec-4678-bf2d-b43d178ba9cb`가 contextual이고 linked exact local task가 open인지 preflight한다. 현재 notes 없음 분기를 그대로 실행하며, task/notes/outcome을 coverage용으로 바꾸지 않는다. 허용된 실데이터 mutation은 9번째 delivery 기록 하나뿐이고 outcome은 미기록으로 남긴다.
- **범위 밖(하지 말 것):** LLM으로 task를 분해하거나 문구를 추론하기, source 자동 연결, task/outcome 자동 변경, 새 저장 포맷, Slice B 자동화.

## 2. 검증 방법

- `pnpm --filter @muse/cli test -- src/commands-attunement.test.ts -t "contextual"`
- `pnpm --filter @muse/cli build`
- `pnpm eslint apps/cli/src/commands-attunement.ts apps/cli/src/commands-attunement.test.ts`
- 빌드된 CLI로 preflight 후 실데이터 `muse continue <thread-id>`를 1회 실행하고 review queue에서 9번째 delivery/outcome 미기록 상태를 확인한다.
- 다른 에이전트가 이 handoff와 diff만 읽고 수용 기준을 독립 평가한다.

## 3. 워커 노트 (워커/빌더가 채움)

- **건드린 범위:** `apps/cli/src/commands-attunement.ts`, 공개 CLI 테스트, changelog.
- **한 일:** contextual presentation이 task title을 반복하던 동작을 exact task notes/fallback command로 교체했다.
  - non-empty notes → 공백 한 칸 정규화 + trim + 240 code-unit 제한 후 `Next-action notes`로 표시.
  - missing/whitespace notes → exact `muse tasks edit <id> --notes "<first concrete action>" --local` 표시.
  - direct/hidden → 기존 동작 유지.
- **결정/가정:** task notes는 local exact artifact에서 읽은 user-authored text다. 내용의 의미를 판정하지 않고 표시만 하며, 없을 때는 추론 대신 명시적 `--local` 편집 명령을 사용한다.
- **검증 실행 결과:** CLI test 14/14 PASS; focused contextual 2/2 PASS; `pnpm --filter @muse/cli build` PASS; changed-file ESLint PASS; `git diff --check` PASS. Real preflight는 contextual policy v8 + exact local/open task + no notes를 확인했다. 9번째 delivery `delivery_fc7020af-6906-49ac-b90d-a34398b61cf7`만 생성됐고 outcome은 미기록이다. Task hash와 `del(.deliveries)` Attunement hash는 전후 동일했다.
- **평가자가 특히 봐야 할 곳:** direct/hidden 회귀 여부, whitespace-only notes, 240자/한 줄 normalization, notes 없는 분기의 명령이 실제 CLI와 일치하는지, real dogfood가 delivery 외 데이터를 바꾸거나 outcome을 자동 기록하지 않는지.

## 4. 평가자 판정 (독립 평가자가 채움 — 워커와 반드시 다른 에이전트)

- **판정:** PASS
- **수용 기준 대조:** diff는 exact local task notes를 공백 정규화·trim·240 UTF-16 code units로 제한해 contextual action line에 표시하고, empty/whitespace notes에서 exact `muse tasks edit <id> --notes "<first concrete action>" --local` fallback을 출력한다. Direct는 제목 action을, hidden은 숨김 문구를 유지하며 Connected context의 exact task 제목도 유지한다. 모델 추론·자동 연결·스토리지 포맷 변경은 없다.
- **검증 근거:** `pnpm --filter @muse/cli exec vitest run src/commands-attunement.test.ts` 14/14 PASS, CLI 전체 suite 4264/4264 PASS, `git diff --check` PASS. Read-only 실데이터 점검에서 대상 thread는 contextual policy v8, linked local task는 open + `notes: null`, delivery는 총 9개이며 마지막/9번째 `delivery_fc7020af-6906-49ac-b90d-a34398b61cf7`은 policy v8이고 outcome이 없다.
- **구체적 피드백:** 없음.
- **반복 횟수:** 0

## 열린 질문 (BLOCKED일 때)

- 없음.

## 상태 로그 (append-only)

- 2026-07-17 14:27 KST · Codex worker · BUILD · 8번째 adjusted dogfood에서 좁은 contextual presentation 슬라이스를 확정.
- 2026-07-17 14:31 KST · independent evaluator + Codex worker · PLAN · `--local`, notes normalization, evidence/action-line 경계, fail-closed dogfood 기준으로 계획을 교정.
- 2026-07-17 14:36 KST · Codex worker · BUILD · 두 RED→GREEN 사이클, 경계 회귀 테스트, TS7 build/lint, 실제 9번째 Pack을 완료하고 EVAL로 넘김.
- 2026-07-17 14:40 KST · independent evaluator · EVAL · 공개 CLI 전체 4264/4264와 실데이터 불변식을 독립 확인해 PASS.
