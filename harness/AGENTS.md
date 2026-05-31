---
title: 에이전트 하네스 운영 계약 (Agent Harness — Operating Contract)
audience: [AI 에이전트, 개발자, 기획자]
purpose: 이 파일을 읽은 에이전트가 "하네스대로" 일하게 만드는 진입점 — 역할·핸드오프·게이트·검증을 한 장으로 강제
format: AGENTS.md (vendor-neutral, 어떤 에이전트/도구든 읽음)
updated: 2026-05-31
---

# 에이전트 하네스 — 운영 계약

> **이 파일이 진입점입니다.** 당신(에이전트)이 이 파일을 읽었다면, 지금부터 아래 규약대로
> 일하세요. 이 한 장이 "어떤 에이전트가 와도 같은 방식으로 일하게" 만드는 계약이고,
> 세부는 같은 폴더의 문서들이 풉니다. **이 폴더 하나가 곧 하네스입니다 — 복사해서 어떤
> 프로젝트에든 떨어뜨리면 그 프로젝트의 에이전트들이 이 방식으로 움직입니다.**

## 0. 한 줄 원칙

**작업을 역할로 쪼개고, 양식 한 장으로 넘기고, 매 단계 fail-closed 게이트로 막고, 만든 자와
판정하는 자를 분리하고, 그게 실제로 되는지 검증한다.** 불확실하면 진행이 아니라 멈춤이 기본.

## 1. 한 작업이 흐르는 길 (이대로 돌리세요)

```
요청 ─▶ [PLAN] 플래너 ──(계획 게이트)──▶ [BUILD] 워커 ──▶ [EVAL] 평가자
                                                            │
                                PASS ─▶ [LEARN] 큐레이터 ─▶ 완료
                                FAIL ─▶ 피드백 → [BUILD] (반복 한도까지)
```

- 한 작업은 **핸드오프 양식 한 장**([handoff-template](handoff-template.md))을 열며 시작합니다.
- 각 단계는 자기 칸만 채우고, 다음 단계는 **그 양식만** 입력으로 받습니다(컨텍스트 리셋).
- 단계 사이 화살표마다 **게이트**를 통과해야 다음으로 갑니다(§3).

## 2. 역할 (필요한 것만 띄우세요)

작은 작업이면 한 에이전트가 여러 역할을 겸해도 되지만, **만든 자 ≠ 판정하는 자**는 항상 지킵니다.

| 역할 | 한 일 | 프롬프트 |
|---|---|---|
| 오케스트레이터 | 맥락·계획 소유, 위임, 결과 종합 | [role-prompts](role-prompts.md) |
| 플래너 | 검증 가능한 수용 기준 산출 | 〃 |
| 워커(생성자) | 기준을 만족하는 결과물 생성 | 〃 |
| 평가자 | **다른 인스턴스**로 독립 판정(PASS/FAIL+근거) | 〃 |
| 리뷰어(선택) | 병합 전 전체 맥락 리스크 점검 | 〃 |
| 큐레이터/학습자 | 통한 전략 강화·교정된 것 약화 | 〃 |

자세히는 [team-roles](team-roles.md). 새 에이전트 합류 절차는 [team-roles §7](team-roles.md).

## 3. 게이트 (fail-closed — 이게 핵심 안전장치)

- **계획 게이트(앞단)** — 수용 기준이 비었거나 모순이면 BUILD 진입 거부.
- **완료 게이트(뒷단)** — 평가자 PASS(+가능하면 자동 채점) 없이는 완료 거부.
- **권한 게이트** — 도구를 위험 등급(읽기/쓰기/실행/외부전송/금지)으로 가르고, 외부 전송은
  **자동 금지·초안 먼저·사람 확인**, 금융/결제는 영구 거부. → [permission-matrix](permission-matrix.md).
- **막힘 우선** — 불확실/모호하면 통과시키지 말고 멈춰 사람에게 올립니다.

게이트 정의·통과 조건은 [verification-and-guardrails](verification-and-guardrails.md).

## 4. 토대 (모든 단계에 적용)

- **루프 한도** — 횟수·시간·예산 하드캡(반복 2~3회 상한). → [loop-budget](loop-budget.md).
- **메모리** — 내구성 사실만 장기 저장, 일회성 드롭, 약한 추론 보류. → [memory-layers](memory-layers.md).
- **압축** — 한계 전 선제·주기적으로 줄이되 **결정·출처는 보존**. → [context-compaction](context-compaction.md).
- **도구·스킬·MCP** — 한-shot 선택 가능한 이름·스키마, 허용목록·격리. → [tool-design](tool-design.md) · [skills-and-mcp](skills-and-mcp.md).
- **관측·복구** — 전 과정 상관 ID 트레이스, 체크포인트 재개. → [failure-modes-and-observability](failure-modes-and-observability.md) · [debugging-and-dx](debugging-and-dx.md).

## 5. 검증 (이게 진짜 되는지 — 안 하면 한 걸로 안 침)

- 대표 과제 묶음([golden-set](golden-set.md))으로 결과+경로를 채점하고, 같은 과제를 여러 번 돌려
  **pass^k**(매번 통과)로 비결정성 내성을 확인합니다.
- 하네스 자체 검증 규약은 [harness-acceptance](harness-acceptance.md). 게이트를 코드로 강제하는
  러너 계약은 [runner-spec](runner-spec.md).

## 6. 이 프로젝트에 맞추기

추상 역할을 실제 프로젝트 런타임에 어떻게 잇는지는 어댑터 문서 하나로 둡니다 — 예시는
[muse-mapping](muse-mapping.md). **새 프로젝트에 깔 때는 이 파일을 복제해 당신 프로젝트용
매핑으로 바꾸세요.** (설치법은 [INSTALL](INSTALL.md).)

---

> 요약: **읽었으면 따르세요.** 역할로 쪼개고 → 양식으로 넘기고 → 게이트로 막고 → 분리해서
> 검증한다. 세부는 위 링크들이, 설치는 [INSTALL](INSTALL.md)이 풉니다.
