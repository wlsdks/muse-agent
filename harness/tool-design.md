---
title: 도구 설계 규약 (Tool Design)
audience: [개발자, AI 에이전트]
purpose: 에이전트가 한 번에 올바른 도구를 고르고 인자를 채우도록, 도구를 어떻게 설계·노출하나
status: draft
updated: 2026-05-31
sources_basis: [Muse .claude/rules/tool-calling.md, Anthropic building-effective-agents (ACI), Anthropic multi-agent research system (tool descriptions), awesome-harness-engineering (tool design category)]
related: [team-roles.md, verification-and-guardrails.md, architecture.md, README.md]
---

# 도구 설계 규약 (Tool Design)

> **왜 이게 빠진 칸이었나?** [architecture](architecture.md) 자가평가에서 "도구 설계"가 ⬜ 갭이었습니다.
> 하네스가 아무리 역할·핸드오프가 좋아도, **에이전트가 도구를 한 번에 못 고르면** 무너집니다.
> Muse는 로컬 소형 모델을 쓰므로 이건 특히 사활적입니다 — Muse 레포의 도구 규약(`tool-calling.md`)을
> 근거로, 검증된 2026 원칙과 함께 정리합니다. 말로만(도구 설명 예시만 인용 형태).

## 0. 한 줄 원칙

**첫 번째 도구 호출이 맞도록 설계한다.** 작은 모델은 추론 라운드가 늘수록 느리고 덜 정확하므로,
"생각해서 찾아가게" 두지 않고 **한 번에 올바른 도구를 고르고 인자를 채우게** 만듭니다.

## 1. 노출은 작게 (한 턴 ≤ 5~7개)

- 한 번에 모델에 보여주는 도구 수를 적게 유지합니다 — 도구가 많을수록 오선택 확률이 오릅니다.
- 전체 도구를 다 던지지 말고 **요청 맥락에 맞는 것만** 추려 노출합니다(관련성 필터).
- 많이 필요하면 한 프롬프트를 넓히지 말고 **맥락별로 나눕니다**.

## 2. 이름은 모호하지 않게 (동사_명사, 한 가지 일)

- `home_state`·`web_action`·`knowledge_search`처럼 **동사_명사, 한 도구 한 일**.
- 모델이 헷갈릴 두 도구를 같이 두지 않습니다(`find`+`search`, `remove`+`delete` 동시 금지).
- 이름·설명의 **동음이의가 오선택 1위 원인**입니다.

## 3. 풍부하고 제약된 입력 스키마

- **항상 `required`를 선언**합니다 — 필수 데이터를 옵션에 기대지 않습니다.
- 명시적 타입, 고정 선택지엔 `enum`, 범위엔 최소/최대·패턴.
- 모든 속성 설명에 **구체적 예시**를 답니다 — "그 엔티티"가 아니라 "대상 식별자, 예: `lock.front_door`".
- 줄임말 금지(`product_name`, `pn` 아님). "잘못된 인자"가 두 번째 오류이며 여기서 막힙니다.

## 4. 설명에 "쓸 때 / 안 쓸 때"를 적는다

- 도구 설명에 한 줄 **"이럴 때 쓰고 … 이럴 땐 쓰지 마라"**를 넣습니다.
- 인사·의도 없는 입력에 도구를 성급히 부르는 것(eager invocation)을 막고 선택을 날카롭게 합니다.

## 5. 한 응답에 한 도구 (정말 다단계가 아니면)

- 작은 모델이 3개 이상 도구를 연쇄하게 설계하지 않습니다.
- 한 도구가 한 일을 끝내게 하거나, 단계를 여러 턴으로 나눕니다.

## 6. 위험 등급 + 게이트 (도구 설계의 일부)

- 모든 도구를 **읽기 / 쓰기 / 실행**으로 분류합니다(위험 taxonomy).
- 상태를 바꾸는 도구는 [verification-and-guardrails](verification-and-guardrails.md)의 게이트를 거칩니다
  (읽기 통과 / 실행은 신뢰목록 / 차단목록 거부, 외부 전송은 draft-first).

## 7. 검증은 코드로 (재추론 루프 금지)

- 도구 인자를 스키마에 맞춰 **코드로 파싱·검증**하고, 잘못되면 결정론적으로 한 번 복구/재요청합니다.
- 모델이 모양을 추측하며 라운드를 태우지 않게 — 스키마+파서가 계약입니다.

## 8. 도구를 추가할 때 (체크리스트)

1. 겹치지 않는 동사_명사 이름.
2. `required` 소수 + 각 속성에 예시·가장 좁은 타입/enum/범위.
3. "쓸 때 / 안 쓸 때" 한 줄.
4. 올바른 위험 등급(읽기/쓰기/실행), 상태변경은 fail-close.
5. **모델이 실제로 그 도구를 고르는지** 검증 — 핸들러 단위테스트가 아니라 실제 선택을 확인하는
   라운드트립(골든 프롬프트→기대 도구, 부정·혼동 케이스 포함). [harness-acceptance](harness-acceptance.md)의
   골든 과제로 편입.

## 한 줄 요약 (도구 설계 체크리스트)

1. 한 턴에 보이는 도구가 **5~7개 이하**인가?
2. 이름이 **동사_명사·한 일**이고 혼동 도구가 없나?
3. `required` + **예시 박힌** 스키마인가?
4. 설명에 **쓸 때/안 쓸 때**가 있나?
5. 위험 등급 + 게이트가 걸렸나?
6. **모델이 첫 시도에 그 도구를 고르는지** 골든 과제로 검증되나?

---

## 출처 (검증 기반)

- Muse 레포 규약 — `.claude/rules/tool-calling.md` (소형 모델 한-shot 선택: ≤5~7 노출·동사_명사·예시-스키마·쓸때/안쓸때·코드 검증)
- Anthropic — [Building Effective Agents](https://www.anthropic.com/engineering/building-effective-agents) (ACI: 도구 인터페이스를 HCI 수준으로 설계)
- Anthropic — [Multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) (도구 설명이 행동을 좌우 — 나쁜 설명은 엉뚱한 길)
- [awesome-harness-engineering](https://github.com/ai-boost/awesome-harness-engineering) (tool design 카테고리)
