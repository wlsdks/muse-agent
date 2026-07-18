# Continuity natural evidence loop handoff

## 헤더 (목표 + 맥락)

- **작업 이름:** continuity-natural-evidence-loop
- **한 줄 목표:** 웹 Continuity 화면에서 열린 Pack의 exact local next-step을 평소 task 완료 행동으로 끝내면 기존 authenticated API가 factual receipt를 기록하고 interaction audit가 즉시 갱신되는 한 흐름을 만든다.
- **제품 맥락:** 공통 interaction audit와 CLI/API receipt 기록은 구현됐지만 actual baseline은 exact 0이다. 웹은 Pack 열기와 task 완료를 이미 지원하나 서로 다른 화면이고 interaction audit를 표시하지 않는다. 다음 병목은 새로운 추론이 아니라 추가 승인·평가 입력 없이 실제 사용 경로를 이어 주는 것이다.
- **현재 단계:** `DONE`
- **담당:** root maker / independent evaluator
- **baseline commit:** `8ce46ee79`

## 1. 수용 기준

- [x] `ContinuityReviewView`가 authenticated `GET /api/attunement/interactions`를 review query와 독립적으로 조회하고 공통 report의 `collecting | audit-required`, life/work exact `n/10`, exact opened UTC dates `n/2`, exact/none/unavailable totals를 표시한다.
- [x] interaction card는 numeric coverage가 natural timing, usefulness, outcome, causality, permission, promotion을 인증하지 않는다고 명시한다. interaction 상태를 `used` 등으로 표현하거나 outcome gate와 합치지 않는다.
- [x] 열린 Pack이 policy상 보이고, available하며, `providerId=local`, `artifactType=task`, `role=next-step`, `taskStatus=open`이고 **같은 delivery의 현재 canonical interaction projection이 `none`**일 때만 같은 카드에 명시적 task 완료 버튼을 표시한다. interaction query loading/refetch/error, missing delivery, `unavailable`, `exact`에서는 fail-close로 숨긴다.
- [x] 완료 버튼은 새 API·권한·confirmation prompt를 만들지 않고 기존 authenticated `POST /api/tasks/:id/complete`를 호출한다. 이는 task 완료 행동 자체이지 Muse 행동 승인이나 outcome 평가가 아니다.
- [x] 완료 성공 후 열린 Pack의 task 상태를 `done`으로 반영하고 interaction/review를 실제 refetch하며 `tasks`/`tasks-count` cache를 invalidation한다. 성공 문구는 task 완료와 coverage refresh만 말하며 exact receipt가 실제 report에 나타나기 전 기록 성공을 주장하지 않는다.
- [x] hidden, unavailable, non-local, non-task, non-next-step, already-done next-step에는 완료 버튼이 없다. stale/relinked/ambiguous receipt 판단은 기존 fail-closed core/API에 맡긴다.
- [x] task 완료는 explicit outcome을 생성하지 않고 permission/grant를 확대하지 않는다. 기존 API integration test와 웹 public interaction test가 이를 검증한다.
- [x] interaction endpoint 실패는 review/Pack/thread UI 전체를 막지 않고 해당 evidence card에만 오류를 격리한다.
- [x] task POST 자체가 실패하면 Pack은 `open` 상태와 canonical `none` capability를 유지하고 scoped completion error만 표시한다.
- [x] task POST 200 뒤 receipt recorder가 warn-and-continue로 실패하는 API negative case를 재현한다. task는 `done`, HTTP는 성공이고 Attunement bytes/outcome/permission/receipt는 불변이며 warning이 남는다. 대응 UI는 refetched coverage가 증가하지 않아도 receipt 성공을 주장하지 않는다.
- [x] outcome longitudinal gate와 interaction audit가 서로 반대 상태인 fixture를 한 화면에 렌더해 각각의 title, count, disclaimer가 교차 오염되지 않음을 고정한다.
- [x] i18n은 영어·한국어를 함께 추가하고, 파생 UI 상태는 render에서 계산하며 user action side effect는 mutation event handler에 둔다.
- [x] TDD RED→GREEN, focused web browser test, API receipt regression, TS7/web build, rendered Browser QA, full `pnpm check`, 독립 completion evaluation이 PASS한다.

## 2. 검증 방법

- 첫 tracer bullet은 browser component test에서 initial interaction coverage가 보이는지 RED→GREEN으로 만든다.
- 두 번째 tracer bullet은 Pack 열기 → exact local task 완료 → existing task endpoint 호출 → task `done` 표시 → refetched exact coverage 증가를 한 public rendered flow로 검증한다.
- 같은 테스트에서 outcome endpoint 호출이 없고 interaction report의 outcome-independent 상태만 바뀌는지 확인한다.
- hidden/unavailable/done 및 current projection loading/error/missing/unavailable/exact negative cases는 공개 렌더 결과로 완료 버튼 부재를 검증한다.
- divergent fixture에서 outcome gate `audit-required`와 interaction audit `collecting`을 동시에 렌더해 문구와 수치가 독립임을 검증한다.
- interaction GET만 reject하는 fixture에서 review/Pack/thread가 계속 렌더되고 interaction error만 보이는지 검증한다.
- completion success fixture는 interaction/review GET 재호출과 QueryClient의 `tasks`/`tasks-count` stale 전환을 검증한다.
- 기존 `tasks-routes-attunement.test.ts`를 실행해 API 완료가 receipt 한 건을 기록하고 delivery outcome은 비어 있음을 재검증한다. 추가 negative는 corrupt/unwritable Attunement fault에서 task commit 후 recorder만 실패해 HTTP 200, task done, warning, Attunement bytes 불변임을 검증한다.
- in-app Browser로 Continuity 화면의 page identity, non-blank, overlay, console, screenshot, target interaction을 확인한다. 실제 자연 증거는 조작하지 않으며 필요하면 격리된 fixture만 사용한다.

## 3. 구현 순서

1. interaction report UI type/card/i18n을 추가하고 공개 렌더 테스트를 GREEN으로 만든다.
2. `OpenedPackCard`에 exact-local-open task 완료 capability를 좁게 추가한다.
3. `ContinuityReviewView` mutation과 병렬 cache invalidation을 연결한다.
4. negative states, API regression, rendered QA를 검증한다.
5. Attunement 목표/CHANGELOG/handoff를 갱신하고 release gate를 닫는다.

## 4. 명시적 비범위

- task가 실제로 완료됐는지 모델이 추론하거나 자동 완료하지 않는다.
- source auto-linking, proactive delivery, OS Observe, permission/autonomy 승격을 추가하지 않는다.
- task 완료를 `used | adjusted | ignored | rejected`로 변환하지 않는다.
- 새 task completion endpoint나 interaction 저장 형식을 추가하지 않는다.
- synthetic/fixture 결과를 actual natural evidence로 기록하거나 actual local store를 조작하지 않는다.

## 5. 워커 노트

- **구조 확인:** API/CLI/loopback task completion은 이미 `recordContinuityTaskCompletionInteraction`을 호출한다. Web `ContinuityReviewView`는 Pack을 열고 `TasksView`는 같은 API로 task를 완료하지만 interaction report는 아직 조회하지 않는다.
- **React 적용:** review와 interaction query는 독립적으로 시작해 waterfall을 만들지 않고, mutation success에서 파생 Pack 상태와 cache invalidation을 처리한다. effect로 action을 재현하지 않는다.
- **테스트 적용:** API client만 system boundary로 대체하고, component 내부 hook/callback 호출 횟수는 검증하지 않는다.
- **PLAN FAIL 보완:** completion capability를 opened Pack snapshot이 아니라 current canonical `none` projection과 교집합으로 제한한다. receipt recorder post-commit failure는 factual task success와 evidence absence를 분리해 표시한다.
- **구현 완료:** interaction/outcome query를 독립 시작하고, exact local open next-step과 current `none`의 교집합에만 완료 capability를 열었다. task 성공 뒤 interaction/review/tasks/tasks-count를 갱신하며 receipt 성공은 authoritative refetch 결과 외에 주장하지 않는다.
- **실제 상태 감사:** aggregate-only local audit는 life 6/work 15 delivery 전부 unavailable, exact 0, 각 0/2 dates를 확인했다. Attunement/tasks SHA는 불변이고 synthetic data와 permission expansion은 없었다.

## 6. 평가자 판정

- **PLAN GATE:** `PASS` — interaction audit와 outcome longitudinal gate는 divergent fixture/title/count/disclaimer로 분리되고, task completion은 outcome·permission·approval과 독립이다. 완료 capability는 Pack 조건과 같은 delivery의 current canonical `none` 교집합에서만 열리며 loading/refetch/error/missing/unavailable/exact는 fail-close한다. task POST 실패 및 POST 200+receipt warn-and-continue 실패가 task effect, receipt, UI claim을 정직하게 분리하고, interaction query 격리·interaction/review refetch·tasks/tasks-count invalidation이 public/QueryClient 경계로 검증된다. focused browser/API와 rendered QA 기준까지 구현 가능한 형태로 충분하다.
- **COMPLETION EVAL:** **PASS (cycle 1).** baseline `8ce46ee79` 대비 현재 전체 diff와 evidence를 독립 검토하고 focused rendered/API/local gates를 재실행했으며 남은 수용 기준 blocker가 없다.
- **기준별 판정:** review와 interaction query는 같은 render에서 독립 시작하고 additive shared report를 표시한다. 완료 capability는 현재 opened delivery의 canonical `none`과 visible, available, local/task/next-step/open Pack 조건의 교집합으로만 파생되며 fetching/error/missing/unavailable/exact 및 hidden/done/비정합 source에서 fail-close한다. task action은 기존 `/api/tasks/:id/complete`만 호출하고 outcome·confirmation·permission 경로를 추가하지 않는다. 성공 시 opened Pack을 done으로 반영하고 interaction/review를 refetch하며 tasks/tasks-count를 invalidate한다. 성공·실패/pending banner는 현재 Pack의 exact task ID로 scope되고 receipt 성공은 authoritative coverage 증가 전 주장하지 않는다. recorder failure test는 task 200/done과 warning을 유지하면서 Attunement bytes/outcome/permission/receipt 불변을 증명한다. divergent outcome/interaction fixtures와 영어·한국어 strings도 서로 분리되어 있다.
- **독립 실행 증거:** repo Chromium Browser Mode focused 8/8, API receipt boundary 2/2, `git diff --check`가 PASS했다. actual local aggregate audit는 exact 0, unavailable 21, life/work dates 0/2를 유지하고 Attunement/tasks existence 및 SHA 불변을 재확인했다. maker의 full Chromium 43/43, web typecheck/build/lint, full `pnpm check` PASS 및 QA fixture DELETE 204/동일 ID 0건 증거와 일치한다.
- **rendered QA 제한:** Browser plugin 연결을 규약대로 재확인했으나 available browser 목록이 0이라 in-app page identity/console/screenshot은 재수행할 수 없었다. 사용자가 허용한 repo Chromium public rendered interaction gate를 fallback으로 사용했으며 이 제한은 evaluation 문서와 일치한다.
- **반복 횟수:** 1

## 상태 로그

- 2026-07-18 · root · PLAN · actual exact 0의 원인을 backend 부재가 아니라 분리된 web use path와 audit visibility gap으로 고정함.
- 2026-07-18 · independent plan evaluator · PLAN GATE FAIL · current-exact capability가 canonical interaction state에 fail-close로 묶이지 않았고 warn-and-continue receipt 실패, divergent outcome/interaction gate, independent query/cache negative public proof가 수용 기준에 필요함.
- 2026-07-18 · root · PLAN · current `none` projection 교집합, loading/error/exact fail-close, recorder post-commit failure, divergent gate, query isolation, 네 cache 검증을 수용 기준에 추가함.
- 2026-07-18 · independent plan evaluator · PLAN GATE PASS · 이전 capability, receipt-failure honesty, divergent gate, query/cache isolation blocker가 모두 측정 가능한 acceptance와 public negative proof로 반영되어 남은 계획 blocker가 없음.
- 2026-07-18 · root · VERIFY · Chromium browser 8/8, API receipt boundary 2/2, web typecheck PASS. in-app Browser runtime은 available browser 0으로 수동 screenshot을 만들 수 없어 repo Chromium public-behavior gate로 대체하고 제한을 evaluation에 기록함.
- 2026-07-18 · root · VERIFY · changed-file lint, web production build, full Chromium browser 43/43, full repository `pnpm check` PASS. 정확한 QA fixture task는 삭제 후 동일 ID 0건을 확인함.
- 2026-07-18 15:29 KST · independent completion evaluator · COMPLETION EVAL cycle 1 **PASS** · Current diff, focused Chromium 8/8, API 2/2, actual local SHA-preserving audit, canonical capability/error/cache paths, i18n, and outcome/permission separation passed with no remaining blocker. Browser availability was independently confirmed as 0, so repo Chromium Browser Mode remained the documented rendered fallback. Only evaluator §6 and this status entry were changed.
- 2026-07-18 · root · DONE · independent PASS를 수용하고 최신 origin/main 재배치 뒤 focused Chromium 8/8, API 2/2, web typecheck를 재검증함. 구현 및 검증 blocker가 없음.
