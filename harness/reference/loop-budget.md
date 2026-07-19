---
title: 루프 종료 & 예산 (Loop Control & Budget)
audience: [개발자, AI 에이전트]
purpose: 에이전트 루프가 무한 반복·비용 폭주 없이 반드시 끝나게 하는 종료 조건과 예산 한도
status: draft
updated: 2026-07-19
sources_basis: [호스트 CLAUDE.md(예: Muse) (tool loops have explicit limits/timeouts), 호스트 architecture 규약 (deterministic budgets/stop conditions), Claude Code agent-loop (max_turns/max_budget_usd), 2026 runaway-cost prevention guides]
related: [../core/team-roles.md, failure-modes-and-observability.md, ../core/verification-and-guardrails.md, architecture.md, ../README.md]
---

# 루프 종료 & 예산 (Loop Control & Budget)

> **왜 이 칸인가?** [architecture](architecture.md) 자가평가에서 비어 있던 칸(현재 ✅). 에이전트 루프는
> "모델 호출 → 출력 파싱 → 도구 실행"을 반복하는데, **반드시 끝나게** 만들지 않으면 무한 반복·비용
> 폭주가 납니다(2026엔 한 루프가 수만 달러를 태운 사례도). Muse는 이미 도구 루프에 한도·타임아웃을
> 두지만(SYSTEM-MAP #1·CLAUDE.md), 그 종료 규약을 하네스 차원에서 명문화합니다.
> 말로만(코드 없음).

## 0. 한 줄 원칙

**모든 루프는 하드 캡으로 끝난다 — 소프트 경고가 아니라 하드 스톱.** 경고는 알림일 뿐, 멈추는 건
강제된 한도여야 합니다.

## 1. 끝내는 한도 (셋 다 둔다)

- **횟수 상한** — 한 작업의 도구 호출/턴 수에 상한(예: max turns). 넘으면 그 자리에서 종료.
- **시간 상한** — 작업 전체·개별 호출에 벽시계 타임아웃. 한 호출이 멈춰도 루프가 멎지 않게.
- **예산 상한(비용/토큰)** — 한 실행의 토큰·비용 한도. 넘으면 하드 스톱(누적 비용이 한도에 닿는 순간).

세 한도 중 **어느 하나라도 닿으면** 루프는 멈추고, 왜 멈췄는지(횟수/시간/예산)를 결과에 남깁니다.

## 2. 끝내는 조건 (한도 외에)

- **작업 완료 신호** — 수용 기준 충족 시 정상 종료([harness-acceptance](harness-acceptance.md)).
- **진전 없음 감지** — 같은 행동을 반복하거나 새 진전이 없으면(루프 정체) 끊고 사람에게 올림.
- **막힘(BLOCKED)** — 답을 모르면 추측하지 말고 멈춰 `## 열린 질문`에 적습니다([handoff-template](../core/handoff-template.md)).

## 2.5 PLAN 검토 예산과 BUILD↔EVAL 예산을 분리한다

두 루프는 목적과 종료 신호가 달라서 카운터를 공유하지 않습니다.

- **PLAN-review budget** — 헤더에 최대 시간·비용을 먼저 적습니다. raw `PLAN FAIL` 횟수만으로
  `BLOCKED` 판정을 내리지 않습니다. **material progress**는 이전 blocker를 닫거나 acceptance/accounting을
  측정 가능하게 만든 변경입니다. **no-progress**는 같은 blocker가 새 증거나 수정 없이 반복되는
  상태입니다. no-progress 또는 명시된 시간·비용 cap 도달만 PLAN의 `BLOCKED` 승격 근거입니다.
- **BUILD↔EVAL budget** — PLAN과 별도로 concrete regression 수정 횟수·시간·비용 cap을 둡니다.
  평가 피드백은 한 pass에서 합리적으로 발견 가능한 blocker를 묶어 반환해야 합니다. 이후 pass의
  새 blocker는 왜 이전 pass에서 발견 불가능했는지 근거를 남겨야 하며, 설명 없는 blocker drip은
  no-progress로 셉니다.

각 pass는 handoff 상태 로그에 `budget kind`, 누적 사용량, `material-progress | no-progress`, 닫힌
blocker, 새 증거를 기록합니다. 한 루프의 남은 예산을 다른 루프의 재시도 근거로 빌려 쓰지 않습니다.

## 3. 폭주를 끊는 안전장치

- **회로 차단(circuit breaker)** — 도구 연쇄 실패·이상 행동을 감지하면 한도 전이라도 루프를 끊습니다.
- **재시도는 유한·백오프** — 무한 재시도 금지, 지수 백오프 + 최대 횟수.
- **결정론적 강제** — 이 한도들은 "모델 판단"이 아니라 **고정 규칙 코드**로 동작합니다([architecture
  rule]의 deterministic budgets/stop conditions와 일치).

## 4. 비용을 줄이는 운용 (한도와 함께)

- **컨텍스트가 비용** — 맥락이 길수록 매 호출이 비쌉니다. 10~15 도구 호출마다 **압축**을 예약하면
  품질을 지키며 토큰을 크게 아낍니다(심화: [context-compaction](context-compaction.md)).
- **싼 검사 먼저** — 비싼 모델 호출 전에 싼 가드레일/검증을 병렬로([verification-and-guardrails](../core/verification-and-guardrails.md)).
- **모델 티어링** — 간단한 일은 빠른 모델, 깊은 추론만 강한 모델([team-roles](../core/team-roles.md)).

## 5. 한 줄 요약 (루프 종료 체크리스트)

1. **횟수·시간·예산** 세 하드 캡이 다 걸렸나?
2. 한도에 닿으면 **하드 스톱**하고 사유를 남기나(경고 아님)?
3. PLAN-review와 BUILD↔EVAL 예산이 분리되고, 완료·정체·막힘에서 **정상 종료**되나?
4. 폭주엔 **회로 차단 + 유한 백오프**가 있나?
5. 한도가 **모델이 아니라 코드**로 강제되나?

---

## 출처 (검증 기반)

- 호스트 프로젝트(예: Muse) — `CLAUDE.md` ("Tool output is untrusted. Tool loops have explicit limits and timeouts.")
- 호스트 프로젝트(예: Muse) — `.claude/rules/architecture.md` ("Deterministic code for policy, permissions, budgets, and stop conditions.")
- Claude Code — [How the agent loop works](https://code.claude.com/docs/en/agent-sdk/agent-loop) (max_turns / max_budget_usd 하드 캡 + 종료 사유)
- [How to Prevent Infinite Loops and Spiraling Costs](https://codieshub.com/for-ai/prevent-agent-loops-costs) (하드 캡·타임아웃·회로 차단)
- [AI Agent Loop Token Costs: Constrain Context](https://www.augmentcode.com/guides/ai-agent-loop-token-cost-context-constraints) (컨텍스트=비용, 10~15콜마다 압축)
