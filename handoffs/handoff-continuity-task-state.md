# Continuity exact task state

## 헤더

- **작업 이름:** continuity-exact-task-state
- **한 줄 목표:** Continuity Pack이 exact linked task의 due/staleness와 tags를 보여주고 contextual notes를 한 번만 표시해 다음 결정을 덜어준다.
- **제품 맥락:** first-20에서 exact grounding은 강했지만 vague life/work task가 due/tags 없이 표시됐고, contextual notes가 evidence와 action line에 중복됐다. Raw 12/20, strict 10/20 결과는 automation hold와 이 수동 Pack 개선을 우선하도록 했다.
- **현재 단계:** `DONE`
- **담당(현재):** Codex worker

## 1. 수용 기준

- [x] exact local task resolver가 선택된 task의 optional `dueAt`과 tags만 provider-neutral artifact metadata로 전달한다. 다른 task를 검색하거나 자동 연결하지 않는다.
- [x] Pack마다 `nowMs`를 정확히 한 번 capture/inject한다. 열린 task의 parseable due가 `Date.parse(dueAt) < nowMs`면 CLI evidence에 stored timestamp를 verbatim으로 `overdue` 표시한다. Equal/future는 `due`; invalid/unparseable due는 fail-closed로 생략한다.
- [x] 이 slice에서 staleness는 deterministic overdue만 뜻한다. `createdAt`, age, title, model 추론으로 stale을 판정하지 않는다.
- [x] tags가 있으면 exact user-authored values를 `JSON.stringify(tags)` 배열로 표시해 newline/control character가 terminal output으로 주입되지 않게 한다.
- [x] decision-critical due/tags는 compact/direct에서도 보인다. Hidden policy는 기존처럼 next-step 내용을 숨긴다.
- [x] contextual next-step notes는 해당 exact `nextStep` evidence entry에서만 생략하고 action line에 정확히 한 번 표시한다. 다른 linked context evidence의 summary는 유지한다. Notes 없는 fallback도 유지한다.
- [x] no-model, exact-source, explicit-outcome, no-external-action 계약과 on-disk schema는 바뀌지 않는다.
- [x] post-window delivery 21은 life thread `thread_bf0dce32-3e81-4148-92ae-4a3d6a7a7693`와 exact tagged/overdue task `task_4eb5262c-7f56-4734-a06c-9aa59f991656`로 한 번만 연다. Correct rendering만으로 `used`를 주지 않고 concrete task-advancing artifact/decision이 있어야 한다. First-20 statistics가 그대로인지 확인한다.
- **범위 밖:** duplicate task 검색/추론, due 자동 변경, task 자동 완료, policy mapping 변경, proactive delivery, Slice B.

## 2. 검증 방법

- Public CLI RED→GREEN: overdue due + safely escaped JSON tags output with injected `nowMs`.
- Public CLI cases: invalid/equal/future due, compact/direct metadata visibility, hidden suppression.
- Public CLI RED→GREEN: contextual notes occurrence count is exactly one while unrelated context summary remains.
- `pnpm exec vitest run src/commands-attunement.test.ts` in `apps/cli`.
- `pnpm --filter @muse/attunement build` and `pnpm --filter @muse/cli build`.
- changed-file ESLint and `git diff --check`.
- Real delivery 21: preflight exact life thread/task, open once, confirm task/outcome are unchanged until explicit verdict, record one honest outcome, append evidence to first-20 report as post-window follow-up.
- Independent evaluator reads this handoff, diff, tests, and real delivery 21 state.

## 3. 워커 노트

- Public CLI 테스트 17/17 PASS. Injected one-shot clock, invalid/equal/future
  due, compact/direct/hidden, escaped control characters in tags, contextual
  exact-one summary와 unrelated note 보존을 검증했다.
- `@muse/attunement`와 `@muse/cli` build, changed-file ESLint,
  `git diff --check` 모두 PASS.
- Real delivery 21 `delivery_7b2fdebb-a8e4-499d-9336-3581ea5521ac`는 exact
  life task에 `overdue: 2026-06-06T18:00:00.000Z · tags: ["구매"]`를 표시했다.
  실제 task 진전은 없어 `adjusted`로 기록하고 link를 제거했다. Total은
  21/21 outcomes, first-20은 `used 12 / adjusted 6 / ignored 2 / rejected 0`로
  불변이다.

## 4. 평가자 판정

- **판정:** PASS
- **수용 기준 대조:** resolver는 `readTaskById`로 선택된 exact local task의 `dueAt`/tags만 transient `ResolvedArtifact` metadata로 전달하며 persisted schema를 늘리지 않는다. CLI는 Pack당 `now()`를 한 번만 읽고, parseable due에 `dueMs < nowMs` + open task일 때만 `overdue`를 표시하며 equal/future는 `due`, invalid due는 생략한다. Tags는 `JSON.stringify` 배열로 escape되고, due/tags는 compact/direct에서 유지되지만 hidden next-step에서는 숨겨진다. Contextual summary 제거는 artifact id/type/provider/role이 일치하는 exact next-step evidence에만 적용되어 unrelated context summary를 보존한다.
- **검증 근거:** `pnpm exec vitest run src/commands-attunement.test.ts` 17/17 PASS; `@muse/attunement`/`@muse/cli` build PASS; changed-file ESLint PASS; `git diff --check` PASS. Tests가 one-shot clock, invalid/equal/future, overdue, JSON newline/control escaping, compact/direct/hidden, contextual exact-one + unrelated summary 보존을 공개 CLI 흐름으로 검증한다.
- **실데이터:** `delivery_7b2fdebb-a8e4-499d-9336-3581ea5521ac`는 unique 21번째 delivery이며 named life thread의 exact local task 하나만 참조하고 outcome은 정직한 `adjusted`다. Task는 open/미완료 + due/tags/notes 유지, thread link는 제거, pending은 0이다. First-20은 20 unique/20 outcomes와 `used 12 / adjusted 6 / ignored 2 / rejected 0`로 불변이다.
- **구체적 피드백:** 없음.

## 열린 질문

- 없음.

## 상태 로그

- 2026-07-17 15:05 KST · Codex worker · PLAN · first-20의 due/tags omission과 contextual duplication만 다루는 좁은 TDD slice를 작성.
- 2026-07-17 15:10 KST · independent evaluator + Codex worker · PLAN · one-shot clock, overdue-only staleness, JSON tags, scoped summary suppression, post-window delivery 21 기준으로 교정.
- 2026-07-17 15:24 KST · Codex worker · BUILD · public CLI 17/17, package builds, lint, diff check PASS; delivery 21 adjusted and first-20 unchanged.
- 2026-07-17 15:27 KST · independent evaluator · EVAL · acceptance 전체, narrow tests/build/lint, canonical delivery 21과 first-20 불변을 독립 검증해 PASS.
- 2026-07-17 15:28 KST · Codex worker · DONE · evaluator PASS를 확인하고 exact task-state slice를 완료.
