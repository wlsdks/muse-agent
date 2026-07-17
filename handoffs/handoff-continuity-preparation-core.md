# Continuity Pack shared preparation core

## 헤더

- **작업 이름:** continuity-pack-shared-preparation-core
- **한 줄 목표:** CLI, HTTP, web, timing offer가 exact local artifact와 Continuity Pack 의미를 `@muse/attunement`의 한 deep Module에서 공유한다.
- **제품 맥락:** delivery 21의 due/tags 개선은 CLI 전용 resolver와 formatter에만 들어갔다. HTTP/timing은 `createLocalExactArtifactResolver`를 사용하지만 그 Adapter는 notes 정규화, due, tags를 누락하고 web도 이를 표시하지 않는다. 새 기능 전에 shared-core parity를 닫는다.
- **현재 단계:** `DONE`
- **담당(현재):** Codex worker

## 1. 수용 기준

- [x] `createLocalExactArtifactResolver`가 local task/note의 canonical resolution을 한 번만 구현한다. Task notes는 whitespace-normalized + 240자 bounded, valid stored `dueAt`은 verbatim, tags는 exact values, status/title/timestamp는 기존 계약을 유지한다. Invalid due는 fail-closed로 Pack metadata에서 생략한다.
- [x] CLI resolver는 local task/note를 직접 읽거나 다시 정규화하지 않고 core local Adapter에 위임한다. External MCP resource만 별도 Adapter로 resolve하며 exact-source/no-search 규칙을 유지한다.
- [x] shared preparation Module이 injected `now()`를 정확히 한 번 읽어 numeric `nowMs`를 internal builder에 전달하는 유일한 clock owner다. Resolver, internal builder, CLI/HTTP/timing caller, formatter/web은 host clock을 다시 읽지 않는다. Task due state는 `due|overdue`: `open && dueMs < nowMs`만 overdue이고 equal/future/done은 due다. 모든 evidence와 nextStep은 같은 파생 artifact를 공유한다.
- [x] user-invoked open 흐름을 담당하는 deep Module이 state read → one-shot clock → exact build → available-evidence guard → policy-version-checked delivery open을 소유한다. CLI와 HTTP continue는 이 Interface를 호출한다. Unavailable-only Pack과 build/open 사이 policy race는 delivery를 만들지 않는다.
- [x] HTTP continue는 기존 surface 계약을 보존한다: missing thread `404`, external-resource thread `409`, unavailable-only `409`, policy-version race `409`; 모두 structured `errorMessage`를 반환하고 zero-delivery다.
- [x] timing `offer` preview는 같은 read/prepare path와 local Adapter만 호출하고 shared open Interface/store open을 호출하지 않는다. Route before/after canonical delivery count가 동일해야 한다.
- [x] HTTP continue 응답이 CLI와 동일한 normalized summary, stored due, derived due state, tags, task status를 반환한다.
- [x] web opened-Pack response type은 `policy.nextStep`과 evidence reference의 `role`/`providerId`를 구조적으로 받는다. UI는 structured due state/timestamp/tags를 실제 Chromium에서 표시하고 hidden next-step에서는 title, summary, status, due, tags 등 artifact content 전체를 숨긴 채 safe `artifactType:artifactId` reference marker만 남긴다. Rendering만 surface-local로 남는다.
- [x] persisted Attunement schema, canonical outcomes, policy mapping, permissions, source set, proactive delivery는 변경하지 않는다. 모델 호출, source search/auto-link, external action도 추가하지 않는다.
- [x] canonical first-21 store에는 새 delivery/outcome/mutation을 만들지 않는다.

## 2. 검증 방법

- CodeGraph context/explore/impact로 `buildContinuityPack`, local resolver, CLI/HTTP callers의 실제 영향 범위를 확인한다.
- TDD tracer 1: public core local Adapter test가 normalized notes + valid due + exact tags를 요구해 RED, 최소 구현 후 GREEN.
- TDD tracer 2: public prepare Interface test가 injected clock exactly-once, invalid/equal/future/done/overdue semantics와 evidence/nextStep artifact identity를 요구해 RED→GREEN.
- TDD tracer 3: public shared open Interface test가 exactly one delivery, unavailable-only zero-delivery, resolver 중 policy mutation으로 발생한 version race zero-delivery를 요구해 RED→GREEN; CLI와 HTTP를 이 Interface로 교체한다.
- HTTP Fastify injection test로 structured metadata + one delivery, missing/external/unavailable/race의 status/structured error/zero-delivery를 확인한다.
- Timing offer Fastify injection test로 prepared Pack은 반환되지만 before/after delivery count가 0임을 확인한다.
- Vitest Browser Mode + real Chromium으로 web opened-Pack metadata와 hidden artifact-content 전체 suppression + safe reference marker를 확인한다.
- Existing CLI attunement test file, affected attunement/API tests, package builds, changed-file ESLint, `git diff --check`.
- 독립 evaluator가 이 handoff, diff, tests, canonical store read-only stats를 대조한다.

## 3. 워커 노트

- CodeGraph를 초기화하고 영향 범위를 확인한 뒤 core local Adapter, temporal derivation, deep open/read Interfaces를 tracer별 RED→GREEN으로 구현했다.
- CLI는 local task/note 중복 resolver와 formatter clock을 제거했다. External MCP resource Adapter만 CLI seam에 남겼다.
- Fastify injection 6건이 metadata parity, missing/external/unavailable/race status와 zero-delivery, timing preview zero-delivery를 검증한다.
- Chromium Browser Mode가 direct Pack의 status/due/tags와 hidden next-step 전체 내용 suppression을 검증한다.
- 독립 평가가 잡은 mixed available/unavailable 회귀를 RED 테스트로 재현했고, 하나 이상의 exact source가 available이면 기존처럼 delivery가 열리도록 가드를 교정했다.
- canonical first-21 파일은 read-only hash/count로만 검증했고 persisted schema/outcome/policy/source 권한을 변경하지 않았다.

## 4. 평가자 판정

- **판정:** COMPLETION PASS
- **수용 기준 대조:** shared resolver, one-shot clock/derived artifact identity, invalid/equal/future/done/overdue semantics, policy-race zero-delivery, HTTP structured metadata/error parity, timing preview read-only, web hidden full-content suppression, no-schema/no-model/no-search wiring이 diff와 focused evidence에 부합한다. 수정된 guard는 `every(status === "unavailable")`일 때만 거부해 기존 available-evidence 계약을 보존한다. 새 public test가 one unavailable context + one available exact task의 status marker를 보존하면서 exactly one delivery를 여는 것과 unavailable-only zero-delivery를 둘 다 검증한다.
- **검증 근거:** re-run `src/continuity-preparation.test.ts` 4/4 PASS; worker 보고 focused gates는 core 15/15, API 6/6, CLI 17/17, Chromium 3, changed-file ESLint, root TS7+web build PASS. Canonical store는 SHA-256 `e19247d57f55426f3a4c38cdb9748840a1e8c73fc1684b669e6db4f9088d4927`, 21 deliveries/21 outcomes, `used 12 / adjusted 7 / ignored 2`로 불변이다.
- **구체적 피드백:** 없음.

## 열린 질문

- 없음. `Continuity Pack`, exact artifact, delivery는 기존 문서의 domain language를 그대로 사용한다.

## 상태 로그

- 2026-07-17 15:42 KST · Codex worker · PLAN · CodeGraph 3,223 files / 35,762 nodes / 32,517 edges 초기화 후 shared-core 수용 기준 작성.
- 2026-07-17 15:45 KST · independent evaluator · PLAN · clock ownership, fail-closed HTTP/open race, preview zero-delivery, complete web hidden suppression 계약을 교정하도록 PLAN FAIL.
- 2026-07-17 15:47 KST · Codex worker · PLAN · shared preparation을 sole clock owner로 고정하고 HTTP race/error, timing zero-delivery, hidden full-content suppression acceptance를 보강.
- 2026-07-17 15:48 KST · independent evaluator · PLAN · 이전 4개 blocker가 모두 명시적·검증 가능하게 교정됨을 확인해 PLAN PASS.
- 2026-07-17 16:03 KST · Codex worker · BUILD · core 14, CLI 17, HTTP 6, Chromium 3 focused assertions green; shared preparation wiring and docs complete, completion evaluation requested.
- 2026-07-17 16:06 KST · independent evaluator · EVAL · focused core 14/14와 canonical store 불변은 확인했으나 mixed available/unavailable Pack을 거부하는 수용 기준 벗어남으로 COMPLETION FAIL.
- 2026-07-17 16:08 KST · independent evaluator · EVAL · mixed evidence TDD fix와 unavailable-only guard, focused preparation 4/4, canonical store 불변을 재검증해 COMPLETION PASS.
- 2026-07-17 16:09 KST · Codex worker · DONE · evaluator PASS를 수용하고 최종 빌드·lint·merge 준비로 전환.
