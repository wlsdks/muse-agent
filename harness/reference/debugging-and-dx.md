---
title: 디버깅 & 개발자 경험 (Debugging & DX)
audience: [개발자, AI 에이전트]
purpose: 비결정적 에이전트 실패를 사람이 읽고·재현·고치고·재발방지로 바꾸는 흐름
status: draft
updated: 2026-05-31
sources_basis: [Muse SYSTEM-MAP #12 (트레이스·실패 재현), Braintrust agent observability 2026, Maxim debugging AI agents 2026, deterministic replay / time-travel debugging 2026]
related: [failure-modes-and-observability.md, harness-acceptance.md, ../core/verification-and-guardrails.md, architecture.md, ../README.md]
---

# 디버깅 & 개발자 경험 (Debugging & DX)

> **왜 마지막 갭이었나?** [architecture](architecture.md) 자가평가의 마지막 ⬜. 에이전트는
> **비결정적**이라 같은 입력에도 매번 다르게 굴 수 있어, 관측([failure-modes-and-observability]
> (failure-modes-and-observability.md))이 있어도 "이걸 어떻게 다시 재현해 고치나"가 없으면 디버깅이
> 막힙니다. Muse는 이미 **트레이스 + 실패 재현**을 갖췄으니(아래), 그 위에서 사람이 실패를 다루는
> 흐름을 정리합니다. 말로만(코드 없음).

## 0. 한 줄 원칙

**모든 실행을 재현 가능한 트레이스로 남기고, 실패는 그 트레이스에서 결정론적으로 되돌려 고친 뒤,
그 케이스를 회귀 테스트로 굳힌다.** 추측 디버깅이 아니라 "같은 조건에서 다시 돌려보기"입니다.

## 1. 재현의 토대 (이미 있는 것)

Muse 런타임은 실행 단계별 기록(트레이스)과 실패 재현(debug replay)을 이미 갖추고 있습니다
(SYSTEM-MAP #12). 하네스 디버깅은 그 위에 얹습니다:
- 각 단계(span)에 입력·출력·소요시간·비용·오류 상태를 남깁니다.
- 도구 호출엔 이름·인자·원본 출력·재시도 횟수를 남깁니다([failure-modes-and-observability §2](failure-modes-and-observability.md)).

## 2. 실패를 고치는 5단계 흐름

1. **모든 실행을 재현 가능한 트레이스로 캡처** — 실패가 나야 비로소 켜는 게 아니라 평소에 남깁니다.
2. **가장 작은 실패 구간을 격리** — 어느 단계(어느 워커·어느 도구 호출)에서 어긋났는지 좁힙니다.
3. **결정론적으로 재현** — 기록된 모델/도구 출력을 그대로 되먹여, 모델을 다시 부르지 않고도 같은
   실패를 재연합니다(같은 조건 = 진짜 원인 추적).
4. **고치고 같은 트레이스로 다시 실행** — 수정이 실제로 그 케이스를 통과시키는지 확인합니다.
5. **고친 케이스를 회귀 테스트로 전환** — [harness-acceptance](harness-acceptance.md)의 골든 과제·
   회귀 스위트(6층 中 5층)에 영구 편입 — 같은 실패가 다시 안 나게.

## 3. 멀티에이전트에서의 추적 (상관 ID)

- 여러 에이전트로 실패가 번지면 근본 원인 찾기가 어렵습니다.
- **상관 ID 하나가 모든 에이전트·도구 호출을 관통**하게 해, 한 사용자 요청을 끝까지 추적합니다.
- 계층(span) 부모-자식 관계가 핸드오프를 넘어 보존돼야, 어느 단계에서 갈렸는지 보입니다.

## 4. 사람이 읽기 좋게 (DX)

- 트레이스를 **계층 트리**(오케스트레이터→워커→도구)로 보여줘 한눈에 흐름이 읽히게 합니다.
- 실패한 단계가 **무엇이·왜 어긋났는지** 한 줄로 드러나야 합니다(원본 입출력 링크 포함).
- 핸드오프 양식의 `## 상태 로그`(append-only)와 `## 열린 질문`이 사람 디버깅의 진입점입니다
  ([handoff-template](../core/handoff-template.md)).

## 5. 한 줄 요약 (디버깅 체크리스트)

1. 모든 실행이 **재현 가능한 트레이스**로 남나?
2. 실패 시 **가장 작은 구간**으로 좁히나?
3. 기록된 출력으로 **결정론적 재현**이 되나(모델 재호출 없이)?
4. 고친 케이스가 **회귀 테스트**로 굳나?
5. **상관 ID**가 멀티에이전트를 끝까지 관통하나?

---

## 출처 (검증 기반)

- Muse 제품 — SYSTEM-MAP #12 (실행 단계별 트레이스 + 실패 재현, 코드 검증됨)
- Braintrust — [Agent Observability 2026](https://www.braintrust.dev/articles/agent-observability-complete-guide-2026) (중첩 span·부모자식·실패↔span 매핑)
- Maxim — [Debugging AI Agents in 2026](https://www.getmaxim.ai/articles/debugging-ai-agents-in-2026-tools-techniques-and-best-practices/) (재현·격리 워크플로)
- [The Debugging Crisis in Multi-Agent AI Systems](https://www.kdnuggets.com/the-debugging-crisis-in-multi-agent-ai-systems-and-how-to-fix-it) (상관 ID로 end-to-end 추적)
