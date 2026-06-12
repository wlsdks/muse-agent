---
title: 하네스 러너 스펙 (Harness Runner)
audience: [개발자, AI 에이전트]
purpose: 핸드오프·역할·게이트를 "사람이 양식을 채움"에서 "런타임이 강제"로 올리는 실행 규약
status: draft
updated: 2026-06-13
sources_basis: [harness-acceptance 실측 9회, team-roles·role-prompts·handoff-template·verification-and-guardrails·loop-budget, Anthropic 3-agent harness(컨텍스트 리셋·핸드오프 아티팩트)]
related: [../core/team-roles.md, ../core/handoff-template.md, ../core/role-prompts.md, ../core/verification-and-guardrails.md, loop-budget.md, architecture.md, ../README.md]
---

# 하네스 러너 스펙 (Harness Runner)

> **왜 이 칸인가?** 지금 하네스는 역할·양식·게이트가 다 정의됐고 실제 Claude Code로 9회 돌아갔지만,
> 그 흐름을 **사람이 손으로** 이어붙였습니다([harness-acceptance §7.5](harness-acceptance.md)의 연쇄가
> 그 증거). "엄청나게 좋은 하네스"가 되려면 그 사이클을 **런타임이 강제**해야 합니다 — 누가 돌려도
> 같은 양식·같은 게이트가 자동으로 적용되도록. 이 문서는 그 러너의 **동작 규약**(무엇을 강제하나)을
> 말로 정의합니다. 구현이 아니라 "러너가 반드시 지킬 계약"입니다.

## 0. 한 줄 원칙

**사이클은 사람이 아니라 러너가 돌린다.** 역할 프롬프트·핸드오프 양식·게이트·한도를 러너가 자동으로
끼우고, 사람은 승인 지점에서만 개입합니다.

## 1. 한 작업의 강제 사이클

러너는 한 작업을 다음 순서로 돌리고, **각 전이마다 게이트를 통과해야** 다음으로 갑니다.

```
요청 ─▶ [PLAN] 플래너 ──(계획 게이트)──▶ [BUILD] 워커 ──▶ [EVAL] 평가자
                                                              │
                                  PASS ─▶ [LEARN] 큐레이터 ─▶ DONE
                                  FAIL ─▶ 피드백 → [BUILD] (반복 한도까지)
```

- ([LEARN] 큐레이터는 DONE *이후*의 비차단 학습 단계 — 러너 상태기계는 DONE까지를 강제하고,
  학습은 게이트가 아니다.)
- 각 단계는 [role-prompts](../core/role-prompts.md)의 해당 블록을 **자동 주입**받는다(사람이 안 붙임).
- 단계 산출은 [handoff-template](../core/handoff-template.md)의 자기 섹션에만 기록되고, 다음 단계는 그
  양식만 입력으로 받는다(컨텍스트 리셋).

## 2. 러너가 강제하는 것 (계약)

- **양식 강제** — 각 역할의 출력이 핸드오프 양식 스키마에 맞아야 한다. 안 맞으면 한 번 재요청, 그래도
  안 되면 BLOCKED.
- **계획 게이트(앞단)** — BUILD 전에 계획의 **자체 정합성**을 점검(수용 기준이 서로 모순 없나, 예시와
  기준이 일치하나). 통과해야 BUILD 진입. (※ 골든 측정에서 본 "계획이 틀리면 하류가 다 어긋난다"의
  방어 — [golden-set] 관찰 참고.)
- **완료 게이트(뒷단)** — 평가자 PASS + (가능하면) 자동 채점이 통과해야 DONE. 불확실은 막힘 우선.
- **만든 자 ≠ 판정하는 자** — BUILD와 EVAL은 서로 다른 에이전트 인스턴스로 강제(평가자가 자기 빌드를
  못 본다).
- **루프 한도** — 횟수·시간·예산 하드 캡([loop-budget](loop-budget.md)). BUILD↔EVAL 반복도 상한, 넘으면
  BLOCKED로 사람에게 올림.
- **압축·체크포인트** — 길어지면 압축([context-compaction](context-compaction.md)), 분기점마다
  체크포인트(실패 시 재개).

## 3. 사람이 개입하는 지점 (HITL)

러너는 자동이되, **이 셋은 반드시 사람**:
- **외부 전송/상태 변경** — draft-first, 사람 확인 후에만([verification-and-guardrails](../core/verification-and-guardrails.md)).
- **받은 노하우 승격** — 격리된 스킬은 사람이 올려야 활성([skills-and-mcp](skills-and-mcp.md)).
- **BLOCKED 해소** — 열린 질문·한도 초과는 사람이 판단.

## 4. 관측 (러너가 남기는 것)

- 모든 전이·도구 호출·게이트 판정을 **상관 ID 하나로** 추적([debugging-and-dx](debugging-and-dx.md)).
- 각 실행은 **재현 가능한 트레이스** + 비용·단계 기록. 골든 과제로 회귀([harness-acceptance](harness-acceptance.md)).

## 5. 지금과의 간극 (정직)

- **출발점(2026-05-31 이전)**: 역할·양식·게이트가 문서로 정의됐고 사람이 claude를 손으로 이어 9회 돌려 흐름을 입증.
- **이 스펙이 정의하는 것**: 그 강제·자동 끼움·게이트 통과를 **러너가** 하는 계약.
- **이제 된 것(2026-05-31)**: 최소 **코드 러너**가 이 계약을 강제합니다 — [`runner/`](../runner/)의
  `harness-runner.mjs`(의존성 0)가 상태기계·계획/완료/권한 게이트를 결정론 코드로 거부하고,
  `conformance.test.mjs`가 §7 거부 매트릭스를 **13/13 통과**(`node --test "harness/runner/*.test.mjs"`). 즉
  게이트가 "지시"에서 "코드 강제"로 올라갔습니다.
- **아직 아닌 것**: 러너를 실제 오케스트레이션 런타임(프로세스 스폰·도구 배선)에 붙이는 것은 호스트
  몫 — 이 러너는 그 위에서 전이 허용을 판정하는 게이트 코어입니다.

## 6. 적합성 — 게이트가 실제로 막는다는 증거 (conformance)

스펙이 "막는다"고 적는 것과 게이트가 **실제로 막는 것**은 다릅니다. 핵심 게이트의 거부 행동은 이미
실제 Claude Code 실측으로 확인됐고([harness-acceptance §7.5](harness-acceptance.md)), 아래처럼 스펙
게이트에 결속됩니다. 즉 이 규약은 가설이 아니라 **이미 작동을 본 행동의 명문화**입니다.

| 스펙 게이트/규약 | 요구 행동 | 결속된 실측 증거 |
|---|---|---|
| 계획 게이트 — 빈 기준 거부 | 수용 기준이 비면 다음 단계로 못 감 | G10 빈 기준 → "검증 불가" **pass^5**(추측 통과 0) |
| 완료 게이트 — 틀린 빌드 FAIL | 기준 위반 산출물은 PASS 안 됨 | G8 null 빌드 → **pass^10** FAIL · G9 올바른 빌드 → pass^5 PASS |
| 외부전송 게이트(HITL) | 자동 전송 금지·draft-first | 권한 실측: outbound→approve·은행→refuse([permission-matrix §4.5](../core/permission-matrix.md)) |

## 7. 코드 러너가 통과해야 할 적합성 매트릭스 (미래 구현 계약)

이 스펙을 코드로 구현할 때, **행복경로만이 아니라 거부 경로**를 증명해야 합니다([verification-and-guardrails]
의 fail-closed 원칙과 동형). 구현은 다음 거부 케이스를 전부 통과해야 인정됩니다.

| 케이스 | 입력 | 기대(fail-closed) |
|---|---|---|
| 단계 건너뛰기 | PLAN 없이 BUILD 요청 | 거부, 상태 유지 |
| 빈 기준 | 수용 기준 없이 계획 게이트 | 전이 거부 + 사유 로그 |
| 미평가 머지 | 평가 PASS 없이 DONE 요청 | 거부(완료 게이트) |
| 자기 채점 | BUILD와 같은 인스턴스가 EVAL | 거부(만든 자≠판정하는 자) |
| 손상된 양식 | 상태 로그 파손/알 수 없는 상태 | 진행 금지 + 사람 개입 |
| 재개 멱등성 | 같은 전이 2회 실행 | 부작용 1회만(중복 금지) |

> 행복경로 통과만으로는 러너가 "delivered"가 아닙니다 — 위 거부 매트릭스가 모두 초록일 때만.

## 한 줄 요약 (러너 체크리스트)

1. 역할 프롬프트가 **자동 주입**되나(사람이 안 붙임)?
2. 단계 전이마다 **게이트 통과**가 강제되나(계획 앞·완료 뒤)?
3. BUILD≠EVAL 인스턴스가 **강제 분리**되나?
4. 루프 **하드 캡** + 압축·체크포인트가 걸리나?
5. 외부전송·승격·BLOCKED만 **사람**에게 가나?
6. 전 과정이 **상관 ID 트레이스**로 남나?

---

## 출처 (근거)

- [harness-acceptance §7.5](harness-acceptance.md) (실제 Claude Code 9회 실측 — 현재는 사람이 사이클을 이어붙임)
- [team-roles](../core/team-roles.md) · [handoff-template](../core/handoff-template.md) · [role-prompts](../core/role-prompts.md) (강제 대상)
- [verification-and-guardrails](../core/verification-and-guardrails.md) · [loop-budget](loop-budget.md) · [debugging-and-dx](debugging-and-dx.md) (게이트·한도·관측)
- Anthropic — [3-agent harness](https://www.infoq.com/news/2026/04/anthropic-three-agent-harness-ai/) (컨텍스트 리셋 + 구조화 핸드오프 아티팩트)
