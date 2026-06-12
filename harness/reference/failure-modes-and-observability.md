---
title: 실패 모드 & 관측 (Failure Modes & Observability)
audience: [개발자, AI 에이전트]
purpose: 하네스가 왜 무너지는지(대부분 모델이 아니라 하네스 탓)와, 그걸 추적·복구하는 최소 장치
status: draft
updated: 2026-06-13
sources_basis: [Agent observability guides 2026, Harness engineering guides 2026, Anthropic multi-agent research system, Addy Osmani long-running agents, Judge reliability harness]
related: [../core/verification-and-guardrails.md, ../core/team-roles.md, ../host/muse-mapping.md, ../README.md]
---

# 실패 모드 & 관측 (Failure Modes & Observability)

> **왜 이게 "최고의 하네스"의 갈림길인가?** 2026 프로덕션 데이터의 핵심 한 줄: **에이전트 실패의
> 약 60%는 모델의 추론 부족이 아니라 하네스 결함에서 온다**(맥락 관리·도구·복구·데이터). 즉 더 좋은
> 모델이 아니라 **더 좋은 하네스**가 답입니다. 이 문서는 그 실패가 어디서 나는지와, 그것을 보고
> 고치는 최소 장치를 검증된 2026 레퍼런스에 근거해 정리합니다. (말로만, 코드 없음.)

## 1. 하네스가 무너지는 곳 (실패 모드)

- **맥락 부패(context rot).** 긴 작업에서 맥락이 넘쳐 모델이 한계 근처에서 소심해지거나 정보를
  잃습니다 → "작업 메모리 예산"을 두고, 합치기보다 **압축/리셋**합니다([handoff-template](../core/handoff-template.md)).
- **충돌하는 암묵적 결정.** 병렬 워커가 서로의 전체 맥락을 못 보면 어긋난 가정으로 일합니다
  ([team-roles §0](../core/team-roles.md)의 단일 스레드 반대원칙).
- **도구 오작동.** 잘못된 도구 설명이 에이전트를 엉뚱한 길로 보냅니다 → 도구 설계에 사람-인터페이스
  수준의 공을 들입니다.
- **연쇄 실패.** 긴 자율 작업에서 사소한 실패가 큰 행동 변화로 번집니다 → 재시작이 아니라
  **체크포인트 재개**.
- **무한 탐색/과다 스폰.** 간단한 일에 서브에이전트를 과다 생성하거나 없는 것을 끝없이 찾습니다 →
  넓게 시작해 좁히고, 작업 규모에 맞춰 에이전트 수를 정합니다.
- **데이터 결함.** 엔터프라이즈 실패의 상당수는 모델이 아니라 하네스에 들어가는 **데이터** 문제입니다
  → 입력 품질·출처를 가드레일로 거릅니다([verification-and-guardrails](../core/verification-and-guardrails.md)).
- **조정 실패 > 능력 실패 (MAST).** 1,600+ 실측 트레이스의 14 실패 모드는 ① 시스템 설계 결함
  ② 에이전트 간 불일치(핸드오프) ③ 검증 부재, 세 범주로 묶입니다(arXiv 2503.13657) — 처방은
  핸드오프마다 명시적 스키마 검증·명시적 종료 조건·독립 검증 단계이고, 우리 양식 강제·루프
  한도·평가자 게이트가 각각에 대응합니다.

## 2. 최소 관측 (무엇을 남길 것인가)

관측이 없으면 비결정적 실패를 고칠 수 없습니다(현재 대부분이 미계측 — 그래서 차별점이 됩니다).
**실패가 드러나는 자리가 곧 고치는 자리**가 되도록, 단계별 기록(span)을 남깁니다.

- **도구 호출 기록** — 도구 이름·인자·**원본 출력**·소요시간·재시도 횟수·오류 상태.
- **추론·결정 기록** — 모델이 왜 그 선택을 했는지(계획·분기). 입출력만으론 부족합니다.
- **계층 기록** — 오케스트레이터 → 워커 → 도구로 내려가는 트리. 어느 층에서 어긋났는지 보입니다.
- **비용·단계** — 단계별·실행별 토큰/비용(멀티에이전트는 크게 더 씀 — 어디서 새는지 추적).
- **상태 전이** — 핸드오프 양식의 단계(PLAN/BUILD/EVAL…) 변화를 append-only 로그로.
- **귀속은 계측으로 — 사후 LLM 판단 금지.** 누가/어느 스텝이 실패를 일으켰는지의 자동 blame은
  에이전트 수준 53.5%·스텝 수준 14.2% 정확도에 그칩니다(Who&When 2505.00212). 단계별 스키마
  체크·상태 diff 같은 결정론 신호를 남겨 귀속이 로그에서 *읽히게* 합니다. 결정론 레이어별
  무-LLM 테스트는 종합 지표가 가리는 회귀를 잡습니다(레이어 슬라이스 −25~−91pp가 종합에선
  −1.7~−5.9pp로 희석, 2606.11686) — 러너의 레이어별 테스트 스위트가 정확히 이 형태입니다.

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
- [MAST — Why Do Multi-Agent LLM Systems Fail? (2503.13657)](https://arxiv.org/abs/2503.13657) (1,600+ 트레이스·14 모드·3 범주) · [Who&When (2505.00212)](https://arxiv.org/abs/2505.00212) (자동 귀속 53.5%/14.2% — 계측으로 대체) · [Layer-Isolated Evaluation (2606.11686)](https://arxiv.org/abs/2606.11686) (레이어별 무-LLM CI 게이트)
