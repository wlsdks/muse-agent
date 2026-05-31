---
title: 실패 모드 & 관측 (Failure Modes & Observability)
audience: [개발자, AI 에이전트]
purpose: 하네스가 왜 무너지는지(대부분 모델이 아니라 하네스 탓)와, 그걸 추적·복구하는 최소 장치
status: draft
updated: 2026-05-30
sources_basis: [Agent observability guides 2026, Harness engineering guides 2026, Anthropic multi-agent research system, Addy Osmani long-running agents, Judge reliability harness]
related: [verification-and-guardrails.md, team-roles.md, muse-mapping.md, README.md]
---

# 실패 모드 & 관측 (Failure Modes & Observability)

> **왜 이게 "최고의 하네스"의 갈림길인가?** 2026 프로덕션 데이터의 핵심 한 줄: **에이전트 실패의
> 약 60%는 모델의 추론 부족이 아니라 하네스 결함에서 온다**(맥락 관리·도구·복구·데이터). 즉 더 좋은
> 모델이 아니라 **더 좋은 하네스**가 답입니다. 이 문서는 그 실패가 어디서 나는지와, 그것을 보고
> 고치는 최소 장치를 검증된 2026 레퍼런스에 근거해 정리합니다. (말로만, 코드 없음.)

## 1. 하네스가 무너지는 곳 (실패 모드)

- **맥락 부패(context rot).** 긴 작업에서 맥락이 넘쳐 모델이 한계 근처에서 소심해지거나 정보를
  잃습니다 → "작업 메모리 예산"을 두고, 합치기보다 **압축/리셋**합니다([handoff-template](handoff-template.md)).
- **충돌하는 암묵적 결정.** 병렬 워커가 서로의 전체 맥락을 못 보면 어긋난 가정으로 일합니다
  ([team-roles §0](team-roles.md)의 단일 스레드 반대원칙).
- **도구 오작동.** 잘못된 도구 설명이 에이전트를 엉뚱한 길로 보냅니다 → 도구 설계에 사람-인터페이스
  수준의 공을 들입니다.
- **연쇄 실패.** 긴 자율 작업에서 사소한 실패가 큰 행동 변화로 번집니다 → 재시작이 아니라
  **체크포인트 재개**.
- **무한 탐색/과다 스폰.** 간단한 일에 서브에이전트를 과다 생성하거나 없는 것을 끝없이 찾습니다 →
  넓게 시작해 좁히고, 작업 규모에 맞춰 에이전트 수를 정합니다.
- **데이터 결함.** 엔터프라이즈 실패의 상당수는 모델이 아니라 하네스에 들어가는 **데이터** 문제입니다
  → 입력 품질·출처를 가드레일로 거릅니다([verification-and-guardrails](verification-and-guardrails.md)).

## 2. 최소 관측 (무엇을 남길 것인가)

관측이 없으면 비결정적 실패를 고칠 수 없습니다(현재 대부분이 미계측 — 그래서 차별점이 됩니다).
**실패가 드러나는 자리가 곧 고치는 자리**가 되도록, 단계별 기록(span)을 남깁니다.

- **도구 호출 기록** — 도구 이름·인자·**원본 출력**·소요시간·재시도 횟수·오류 상태.
- **추론·결정 기록** — 모델이 왜 그 선택을 했는지(계획·분기). 입출력만으론 부족합니다.
- **계층 기록** — 오케스트레이터 → 워커 → 도구로 내려가는 트리. 어느 층에서 어긋났는지 보입니다.
- **비용·단계** — 단계별·실행별 토큰/비용(멀티에이전트는 크게 더 씀 — 어디서 새는지 추적).
- **상태 전이** — 핸드오프 양식의 단계(PLAN/BUILD/EVAL…) 변화를 append-only 로그로.

## 3. 복구 (실패를 견디는 법)

- **체크포인트 재개.** 의미 있는 분기점에서 상태 저장 → 실패 시 마지막 지점부터.
- **멱등성.** 재실행이 중복 부작용을 내지 않게(같은 전송 2번 금지).
- **백오프·회로 차단.** 도구 실패엔 지수 백오프, 연쇄 오류엔 회로 차단.
- **사람 개입 지점(HITL).** 프로덕션은 **단일 well-scoped 에이전트 + 사람 체크포인트 + Plan-
  Execute-Verify 단계 게이트**를 선호합니다 — 자율성보다 **통제 가능성**이 신뢰를 만듭니다.
- **블라스트 반경 제한.** 위험한 실행은 격리 샌드박스에서, 도구 접근은 좁게.

## 4. 판정자도 검증한다 (judge 신뢰성)

평가자(LLM judge)도 틀립니다 — 그래서 판정자 자체를 보정·점검합니다:

- **보정 셋.** 사람이 정답을 단 200~500개 예시를 둡니다.
- **재보정 신호.** 사람 판정과의 상관이 떨어지거나(예: r<0.7) 불일치율이 20~25%를 넘으면 루브릭을
  다시 맞춥니다.
- **도메인 보정.** 채팅용으로 검증된 판정자는 코드 리뷰·에이전트 과제엔 그대로 못 씁니다 — 도메인별로
  다시 봅니다.

## 5. 한 줄 요약 (관측·복구 체크리스트)

1. 도구 호출에 이름·인자·출력·시간·재시도·오류가 **다 남는가**?
2. **추론·결정**과 **계층(오케스트레이터→워커→도구)**이 추적되는가?
3. 긴 작업이 **체크포인트에서 재개**되고, 부작용이 **멱등**한가?
4. 위험 실행이 **격리**되고 도구 접근이 **좁은가**?
5. 판정자에 **보정 셋**이 있고, 어긋나면 **재보정**되는가?

---

## 출처 (검증 기반)

- [Agent Observability: The Complete Guide for 2026 (Braintrust)](https://www.braintrust.dev/articles/agent-observability-complete-guide-2026) (span 타입 ↔ 실패 모드, 도구 span 필드)
- [What Is Harness Engineering? (NxCode, 2026)](https://www.nxcode.io/resources/news/what-is-harness-engineering-complete-guide-2026) (~60% 실패가 하네스, 작업 메모리 예산·샌드박스)
- Addy Osmani — [Long-running Agents](https://addyo.substack.com/p/long-running-agents) (단일 well-scoped + HITL 체크포인트 + Plan-Execute-Verify)
- Anthropic — [Multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) (전 과정 추적·체크포인트·실패 모드)
- [Judge Reliability Harness (arXiv 2603.05399)](https://arxiv.org/abs/2603.05399) (판정자 보정·재보정 기준)
