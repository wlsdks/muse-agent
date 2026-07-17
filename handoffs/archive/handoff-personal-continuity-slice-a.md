---
title: Personal Continuity Slice A handoff
updated: 2026-07-14
---

# Personal Continuity — Slice A

## 작업 헤더

- **작업 이름:** personal-continuity-slice-a
- **한 줄 목표:** 사용자가 고른 일상 또는 업무의 미완료 주제를, 명시적으로 연결한 자료와
  안전한 다음 한 단계로 다시 이어 준다.
- **현재 단계:** `EVAL PASS`
- **담당:** 오케스트레이터 `/root`

## 1. 계획

- **제품 맥락:** Muse는 업무 도우미가 아니라 한 사람의 일상과 업무를 함께 돕는 개인 AI다.
  Personal Continuity는 이 정체성을 처음으로 실제 사용 경험으로 증명하는 tracer bullet이다.
- **LLM 역할 판정:** 자료가 어느 thread에 속하는지, 권한, 보존 기간, 결과에 따른 정책 변경은
  결정론 코드가 맡는다. Slice A에는 LLM 호출이 없다. 후속 slice에서만 이미 연결된 자료를
  요약할 수 있으며, 그 요약도 link·권한·보존·수신자·외부 행동을 바꾸지 못한다.
- **첫 사용자 흐름:** `muse thread start`로 일상 또는 업무 thread를 만들고 자료를 명시적으로
  연결한다. `muse continue`가 근거 ID와 다음 한 단계를 담은 Continuity Pack을 보여 준다.
  사용자는 `used`, `adjusted`, `ignored`, `rejected` 중 결과를 기록한다.
- **범위:** local file-backed store, CLI, deterministic pack/policy reducer, unit·integration
  golden tests. 자료원은 **local task와 local note만** 지원한다. 브라우저 이력 자동 연결,
  Observe, reminder·calendar·contact·browser adapter, 자동 타이밍, LLM 요약, 외부 행동은 이번
  slice 밖이다.
- **선행 게이트:** 현재 `main`의 egress-authorization seam 테스트 4건과 doctor timeout 1건을
  원인 확인 후 복구한다. 문서 commit을 local `main`에 병합하고 `feat/attunement` branch를 만든 뒤
  Slice A 구현을 시작한다. 이 복구는 안전 동작을 약화하지 않아야 한다.
- **수용 기준:**
  1. `life`와 `work`는 동등한 thread 종류이며 어느 쪽도 기본값으로 가정하지 않는다.
  2. Pack은 선택한 `threadId`에 명시적으로 연결된 local task/note만 사용하고 각 자료의 타입·ID를
     보여 준다. pack builder는 `threadId → 저장된 link → exact resolver` 순서로만 자료에 접근하며,
     사전 해석된 전체 목록을 입력받지 않는다.
  3. Slice A에서 자료 귀속을 만드는 주체는 **사용자뿐**이다. `ArtifactLink`는
     `{ threadId, artifactType: task|note, providerId: local, artifactId, role: context|next-step,
     linkedBy: user, linkedAt }`를 모두 가진다. 결정론 코드는 이 입력을 검증·저장·정확 조회할 뿐이며,
     모델·제목 검색·자동 규칙은 새 link를 만들 수 없다. task는 exact ID 또는 유일한 ID prefix,
     note는 vault 상대 경로 exact ID만 허용한다. note link는 absolute path와 `..` segment를 거부하고,
     link 시 canonical realpath가 vault root 안에 있는지 확인한 뒤 정규화된 vault-relative canonical ID만
     저장한다. pack resolve 때에도 realpath containment를 다시 확인하므로, link 뒤 symlink가 vault 밖을
     가리키게 바뀌면 해당 source는 fail-closed로 제외한다. missing·escaped·ambiguous source에서 제목/경로
     검색 fallback은 금지한다. task prefix는 link 명령에서만 0개/다중 결과를
     fail-closed로 거부하는 입력 편의이며, 성공 시 store에는 resolver가 돌려 준 **canonical full ID**만
     기록한다. 이후 pack은 그 full ID로만 exact resolve한다. 한 thread에는 `next-step` link가 최대
     하나만 있을 수 있다. 다음 단계를 바꾸려면 사용자가 먼저 기존 link를 unlink한 뒤 새 task를
     link해야 하며, Muse는 여러 후보 중 하나를 고르지 않는다.
  4. canonical outcome은 `used|adjusted|ignored|rejected`뿐이며, `openedAt`은 별도 delivery event다.
     `ContinuityDelivery { id, threadId, evidenceRefs, openedAt, policyVersion, outcome? }` 하나에만
     outcome을 연결한다. outcome 기록과 새 policy 저장은 하나의 원자적 mutation이다.
  5. reducer의 허용 출력은 아래 세 필드뿐이다. Pack의 source refs와 원본 자료, 보존, 권한, 수신자,
     외부 행동은 어떤 outcome으로도 바뀌지 않는다.

     초기 policy는 `detail=standard`, `next-step=direct`, `suppression=none`이다. 아래 표의 네 행만
     canonical outcome에 따른 전이다.

     | outcome | detail | next-step 표시 | suppression |
     | --- | --- | --- | --- |
     | used | compact | direct | none |
     | adjusted | standard | contextual | none |
     | ignored | compact | direct | acknowledge-previous |
     | rejected | compact | hidden | acknowledge-previous |

     `direct`는 사용자가 `next-step`으로 연결한 열린 task를 그대로 보여 주고, `contextual`은
     같은 task를 "연결된 다음 단계"로 표시하며, `hidden`은 task를 source ref로만 남긴다.
     `acknowledge-previous`는 직전 delivery의 결과를 한 줄로 표시할 뿐, 자동 발송·타이밍·새 자료
     수집을 만들지 않는다.
  6. 같은 delivery에 같은 canonical outcome을 다시 기록하면 같은 receipt를 돌려주는 no-op이고,
     다른 outcome으로 덮어쓰려 하면 오류다. `reset`은 thread와 links, immutable delivery/outcome
     history를 보존한 채 active policy만 초기 policy로 되돌린다. reset receipt는 immutable
     `{ id, threadId, beforePolicy, basePolicyVersion, resetPolicyVersion }`이고, reset은 하나의 atomic
     mutation으로 새 monotonic policy version을 발급한다. `undo-reset`은 다음 순서로 동작한다.
     (1) 이미 성공한 immutable `UndoResetReceipt { id, resetId, threadId, restoredPolicy,
     previousPolicyVersion, undoPolicyVersion, undoneAt }`가 있으면 CAS 검사 없이 같은 receipt를
     반환한다. (2) 없을 때만 reset receipt가 아직 마지막 policy mutation인지
     (`activePolicyVersion === resetPolicyVersion`) 비교한다. (3) 일치하면 snapshot 복원, 새 monotonic
     `undoPolicyVersion` 발급, UndoResetReceipt 추가를 하나의 atomic mutation으로 기록한다. 이후
     outcome/reset이 하나라도 있으면 stale undo는 fail-closed로 거부한다. golden tests가
     `outcome → policy → changed next pack`, no-op, overwrite 거부, reset/undo와 stale-undo 거부를
     증명한다.
  7. 데이터는 `~/.muse/attunement.json`의 로컬 owner-only 파일에 원자적으로 저장된다. process 내부
     queue와 cross-process file lock을 함께 사용한다. `inspect`, `reset`, `undo-reset`가 가능하다.
  8. `pnpm check`, 관련 golden tests, lint, 독립 평가 PASS 없이 완료·병합하지 않는다.

## 구현 경계와 CLI 계약

- 새 provider-neutral package는 `packages/attunement/`이고, store는 기존 `@muse/stores`의 atomic
  file write와 cross-process lock을 재사용한다. package는 model/provider/browser에 의존하지 않는다.
- `muse thread start <title...> --kind <life|work>` — `--kind` 필수, default 없음
- `muse thread list`
- `muse thread link <thread-id> <task|note> <artifact-id> --role <context|next-step>`
- `muse thread unlink <thread-id> <task|note> <artifact-id>`
- `muse thread continue [thread-id]`와 동일 handler의 `muse continue [thread-id]` — ID는 정확히
  선택한 thread만 연다. 인자를 생략한 interactive TTY에서는 후보를 보여 주고 사용자가 full ID를
  선택해야 한다. non-interactive, 0개 또는 다수 후보에서 생략은 실패하며 최근 thread나 추정값을
  자동 선택하지 않는다.
- `muse thread inspect <thread-id> [--json]`
- `muse thread outcome <delivery-id> <used|adjusted|ignored|rejected>`
- `muse thread reset <thread-id>` / `muse thread undo-reset <thread-id> <reset-id>`
- command loader, manifest, Planning & time help group을 함께 등록하고 manifest drift test를 통과한다.

## 2. 빌드

- 완료. `packages/attunement/`에 provider-neutral thread·link·pack·outcome·policy·receipt store를
  만들고, 기존 atomic write + process-local queue + cross-process lock을 결합했다. CLI에는
  `thread`와 top-level `continue`를 lazy command/manifest/help group까지 등록했다.
- Local adapter는 task의 exact ID/유일 prefix를 full ID로 정규화하고, note는 link·resolve 양쪽에서
  vault realpath containment를 확인한다. Store public mutation도 exact artifact validator 없이는
  link를 저장하지 않으며 unsafe note ID·손상된 relation/version state를 fail-closed로 거부한다.

## 3. 평가

- **PASS.** 독립 evaluator가 life/work 동등성, thread-local exact source isolation, LLM/auto-binding
  부재, canonical delivery/outcome, reducer의 좁은 capability, reset/undo CAS, 0600 atomic storage와
  vault containment, CLI registry까지 수용 기준 전체를 재판정했다.
- 검증: `pnpm check`, `pnpm lint`, `pnpm lint:comments`, `pnpm check:prompt-seam`,
  `pnpm check:capabilities`, `pnpm test:changed --uncommitted`, focused package/CLI tests 모두 PASS.

## 열린 질문

- 없음. Slice A의 source 범위·binding·delivery/outcome·policy transition·reset 의미를 확정했다.

## 상태 로그

- 2026-07-14 · 오케스트레이터 · PLAN · Slice A를 user-chosen, deterministic, local-first tracer로 정의.
- 2026-07-14 · 독립 evaluator · PLAN FAIL · 자동 결정론 link, artifact 범위, delivery/outcome, reducer,
  reset 계약이 모호함을 지적.
- 2026-07-14 · 오케스트레이터 · PLAN 보완 · task/note user-only link, atomic delivery/outcome, transition
  table, history-preserving reset/undo, exact CLI 계약으로 고정.
- 2026-07-14 · 독립 evaluator · PLAN FAIL · prefix canonicalization, optional continue의 암묵 선택,
  stale reset undo CAS, baseline/outcome 표기 모순을 지적.
- 2026-07-14 · 오케스트레이터 · PLAN 보완 · full ID 저장, interactive explicit selection, versioned
  reset receipt/CAS/no-op undo, initial policy 분리로 보완. 재평가 대기.
- 2026-07-14 · 독립 evaluator · PLAN FAIL · immutable reset receipt의 undo 표기 모순, undo version/
  replay ordering, note vault containment 누락을 지적.
- 2026-07-14 · 오케스트레이터 · PLAN 보완 · separate immutable undo receipt와 monotonic version/CAS
  ordering, link·resolve 양쪽의 vault realpath containment로 보완. 재평가 대기.
- 2026-07-14 · 오케스트레이터 · PLAN 명료화 · `next-step`은 thread당 하나로 제한해 여러 연결 task
  중 Muse가 임의로 고르는 경로를 제거.
- 2026-07-14 · 오케스트레이터 · BUILD · local task/note only Slice A와 CLI, atomic state, explicit
  outcome/reset/undo를 구현.
- 2026-07-14 · 독립 evaluator · BUILD FAIL · public link mutation의 exact source validator와 persisted
  state relation negative proof가 부족함을 지적.
- 2026-07-14 · 오케스트레이터 · BUILD 보완 · required canonical validator, core-level unsafe note ID
  guard, relation validation 및 negative golden tests를 추가.
- 2026-07-14 · 독립 evaluator · EVAL PASS · 수용 기준 전체와 clean workspace check를 독립 확인.
