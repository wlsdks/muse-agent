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

> **무엇이 하네스이고 무엇이 아닌가(2026 합의):** 하네스는 *실행하는* 제어플레인입니다 — 루프를
> 돌리고 게이트를 강제합니다(규칙만이 아님).
> - `harness-runner.mjs` = 게이트(전이 허용/거부 판정) — 규칙을 코드로 강제하는 부품. **하네스.**
> - `orchestrator.mjs` = 계획→빌드→평가 **루프를 실제로 구동**하는 제어플레인. **하네스 본체.**
> - `run.mjs` = 그 루프를 특정 에이전트 CLI(`claude -p`)에 잇는 **교체 가능한 어댑터**. 어떤 에이전트를
>   쓰느냐만 호스트마다 다르고, 루프·게이트·검증이라는 하네스 본체는 그대로입니다.
> - 하네스가 *아닌* 것 = 에이전트가 만들어내는 **도메인 작업**(backoff 함수 등) = 워크로드.

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
- **`orchestrator.mjs`** — 실행 통합. `runCycle(task, {callAgent})`가 plan→build→evaluate→complete를
  **실제로 구동**하되 매 전이를 위 게이트로 막고 **트레이스**를 남김. `callAgent`는 주입식(테스트는
  가짜 에이전트, 운영은 실제 LLM)이라 포터블·테스트 가능.
- **`orchestrator.test.mjs`** — 가짜 에이전트로 구동 흐름 + 게이트 발화를 증명(LLM 불필요).
- **`run.mjs`** — CLI 진입점: `node harness/runner/run.mjs "<작업>"` — 각 역할을 실제 `claude -p`로
  부르고(역할마다 새 컨텍스트=만든자≠판정자), `last-trace.json`을 남김. 에이전트 바이너리는
  `CLAUDE_BIN`으로 교체 가능(다른 에이전트 CLI로 포팅).
- **`redteam.test.mjs`** — 게이트 **우회 시도**(단계 점프·완료 위조·자기채점·권한 상승·은행 위장·
  재시도 캡 우회)가 전부 차단되는지 적대 검증.

## 돌리는 법 (의존성 설치 불필요)

```
node --test harness/runner/
```

마지막 측정: **27/27 통과** (적합성 13 + 오케스트레이터 5 + 적대 9). 행복경로만이 아니라
**거부 경로가 전부 초록**일 때만 러너가 "delivered"입니다. CI는
[`.github/workflows/harness.yml`](../../.github/workflows/harness.yml)가 `harness/**` 변경마다 강제.

**실제 end-to-end(통합 러너, `run.mjs`):** 실제 `claude -p` 3역할로 `count_vowels`·`fizzbuzz`·
`is_valid_email` 세 작업을 구동 → **3/3 모두 plan→build→evaluate→DONE(PASS)**, 게이트가 코드로
강제되고 트레이스가 남음. 즉 게이트가 "테스트된 로직"을 넘어 **실제 실행을 강제**합니다.

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
