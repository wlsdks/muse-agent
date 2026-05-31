---
title: 하네스 러너 (코드 — 게이트 강제)
audience: [개발자, AI 에이전트]
purpose: 하네스 게이트를 "지시"가 아니라 "코드"로 강제하는 최소 러너
updated: 2026-05-31
---

# 하네스 러너 (코드)

[`../runner-spec.md`](../runner-spec.md)가 정의한 상태기계와 fail-closed 게이트를 **실제 코드로
강제**합니다. 문서(지시)는 모델이 "따르기로 선택"하지만, 이 러너는 **허용되지 않은 전이를 코드가
거부**합니다 — 모델이 단계를 건너뛰거나 빈 기준으로 통과시키려 해도 러너가 막습니다.

> 2026 근거: "쿠버네티스는 fail-closed였는데 에이전트 시스템은 fail-open이다"(제어플레인 문제) —
> 그래서 게이트는 **결정론 코드**여야 하고(OpenAI Harness Engineering·Faramesh non-bypassable),
> 신뢰-핵심 로직은 **단위 테스트로 거부 경로까지 증명**해야 합니다(Martin Fowler).

## 무엇이 들어있나

- **`harness-runner.mjs`** — 의존성 0(Node 내장만). 순수 함수 모음:
  - `advance(state, event, ctx)` — 상태 전이. 허용 안 되면 `BLOCKED`+사유(fail-closed 기본).
  - `planGate(criteria)` — 빈/공백 수용 기준이면 거부(추측 통과 차단).
  - `permissionGate(action)` — 은행=영구 거부, 외부전송=수신자 확정+사람 확인 필수, write/execute=신뢰 필요, 미상=거부.
  - `createRun()` — 같은 전이 id를 다시 적용하면 1회만 반영(재개 멱등성).
- **`conformance.test.mjs`** — [runner-spec §7 매트릭스](../runner-spec.md)의 **거부 경로**를 증명하는 테스트.

## 돌리는 법 (의존성 설치 불필요)

```
node --test harness/runner/
```

마지막 측정: **13/13 통과** (단계 건너뛰기·빈 기준·미평가 완료·자기 채점·손상된 양식·재시도 캡·
은행/외부전송 권한·멱등 재개 + 해피패스). 행복경로만이 아니라 **거부 경로가 전부 초록**일 때만
러너가 "delivered"입니다.

## 상태기계

```
REQUESTED --plan(계획 게이트)--> PLANNED --build--> BUILT --evaluate(만든자≠판정자)--> EVALUATED
   EVALUATED --complete(완료 게이트: PASS만)--> DONE
   EVALUATED --rebuild(재시도 캡)--> BUILT
   그 외 모든 전이 --> BLOCKED (fail-closed)
```

## 한계

최소 러너입니다 — 상태기계·게이트의 **결정론 강제**가 핵심이고, 모델은 각 상태 *안에서* 추론합니다
(Boris Cherny의 "thin harness, smart model"). 오케스트레이션 런타임(프로세스 스폰·도구 호출 배선)에
얹는 것은 호스트 몫이며, 이 러너는 그 위에서 "전이 허용 여부"를 판정하는 게이트 코어입니다.
