---
title: 하네스 구성도 & 자가평가 (Architecture & Self-Assessment)
audience: [기획자, 개발자, AI 에이전트]
purpose: 하네스가 어떻게 짜였는지 한눈에(구성도) + 2026 권위 체크리스트 대비 무엇이 있고 무엇이 빠졌는지
status: draft
updated: 2026-05-31
sources_basis: [awesome-harness-engineering (component checklist), Agent Harness Engineering — AI Control Plane (Masood 2026), Atlan harness tools 2026, Braintrust observability 2026]
related: [README.md, team-roles.md, handoff-template.md, role-prompts.md, verification-and-guardrails.md, failure-modes-and-observability.md, harness-acceptance.md, muse-mapping.md]
---

# 하네스 구성도 & 자가평가 (Architecture & Self-Assessment)

> **이 문서는?** 지금까지 만든 하네스가 **어떻게 짜였는지 한 장으로** 보여주고(구성도), 2026년
> 권위 있는 체크리스트(awesome-harness-engineering의 12개 카테고리 등)에 비춰 **무엇이 채워졌고
> 무엇이 빠졌는지** 정직하게 평가합니다. 말로만(코드 없음). 출처는 끝에.

## 1. 한 장 구성도 (한 작업이 흐르는 길)

```
                 ┌──────────────────────────────────────────────┐
                 │            오케스트레이터 (지휘자)            │
                 │   전체 맥락·계획 소유 / 위임 / 결과 종합       │
                 └───────────────┬──────────────────────────────┘
            위임(목표·출력·도구·경계)│        ▲ 압축 요약 반환
                 ┌────────────────┼────────────────┐
                 ▼                ▼                ▼
            ┌─────────┐     ┌─────────┐     ┌──────────┐
            │ 플래너  │ ──▶ │  워커   │ ──▶ │  평가자  │   (만든 자 ≠ 판정하는 자)
            │ 계획    │     │ 빌드    │ ◀── │  PASS/   │
            └─────────┘     └─────────┘ 피드백│  FAIL   │
                 │                │           └────┬─────┘
                 └────────────────┴────────────────┘
                          모두 같은 한 장을 채움
                 ┌──────────────────────────────────────────────┐
                 │      핸드오프 아티팩트 (작업당 1장, 상태 소유)  │
                 │  계획 → 빌드 → 평가 → 리뷰 + 열린질문 + 상태로그│
                 └──────────────────────────────────────────────┘
   가로지르는 토대(모든 단계에 적용):
   · 가드레일: 입력/출력 검사 + 트립와이어(즉시 중단)
   · 게이트: 계획 승인(앞) · 완료(뒤), 막힘 우선(fail-closed)
   · 관측: 도구·추론·계층 트레이스 + 비용 + 상태 전이
   · 복구: 체크포인트 재개 · 멱등성 · 격리(worktree)
   · 검증: 골든 과제 + 6층 테스트로 하네스 자체를 평가
```

**읽는 법:** 한 작업은 오케스트레이터가 **핸드오프 한 장**을 열며 시작 → 플래너가 계획 칸 → 워커가
빌드 칸 → 평가자가 평가 칸(만든 워커와 다른 에이전트). 모든 단계가 가드레일·게이트·관측·복구라는
**가로 토대** 위에서 돌고, 하네스 자체는 검증(골든 과제·6층)으로 점검됩니다.

## 2. 문서 → 구성 요소 지도

| 구성 요소 | 담은 문서 |
|---|---|
| 역할·패턴·경계 | [team-roles](team-roles.md) |
| 역할별 붙여넣기 프롬프트 | [role-prompts](role-prompts.md) |
| 작업 상태(핸드오프) | [handoff-template](handoff-template.md) |
| 가드레일·게이트 | [verification-and-guardrails](verification-and-guardrails.md) |
| 실패 모드·관측·복구 | [failure-modes-and-observability](failure-modes-and-observability.md) |
| 하네스 자체 검증 | [harness-acceptance](harness-acceptance.md) |
| Muse 런타임 매핑 | [muse-mapping](muse-mapping.md) |

## 3. 자가평가 — 2026 체크리스트 대비

권위 체크리스트(awesome-harness-engineering의 12개 카테고리)에 비춘 현재 상태:

| # | 권위 카테고리 | 우리 하네스 | 상태 |
|---|---|---|---|
| 1 | 에이전트 루프 | team-roles 패턴(일의 모양) | 🟡 부분 |
| 2 | 계획·분해 | 플래너 역할 + 핸드오프 계획 칸 | ✅ |
| 3 | 컨텍스트·압축 | 실패모드의 맥락부패·압축 반환 | 🟡 부분 |
| 4 | 도구 설계 | [tool-design](tool-design.md) — 한-shot 선택·예시스키마·위험등급 | ✅ |
| 5 | 스킬·MCP | [skills-and-mcp](skills-and-mcp.md) — 2단계 허용목록·격리·최소권한·불신출력 | ✅ |
| 6 | 권한·승인 | 게이트·승인(fail-closed) | 🟡 부분 |
| 7 | 메모리·상태 | 핸드오프 상태로그 | 🟡 부분 |
| 8 | 오케스트레이션 | team-roles + muse-mapping | ✅ |
| 9 | 검증·CI | verification + acceptance(6층) | ✅ |
| 10 | 관측·트레이스 | failure-modes 관측 | ✅ |
| 11 | 디버깅·DX | [debugging-and-dx](debugging-and-dx.md) — 트레이스→격리→결정론 재현→회귀 | ✅ |
| 12 | 사람 개입(HITL) | 게이트·승인·체크인 | ✅ |

**한 줄 결론:** **⬜ 갭이 모두 닫혔습니다.** 12개 카테고리 중 ✅ 9 / 🟡 3(루프·컨텍스트·권한·메모리는
부분). 협업 구조·도구·스킬/MCP·검증·관측·디버깅까지 갖췄고, 남은 일은 부분 칸의 **심화**입니다.

## 4. 다음에 채울 것 (우선순위)

1. ~~도구 설계 규약~~ → [tool-design](tool-design.md) ✅.
2. ~~스킬/MCP 통합~~ → [skills-and-mcp](skills-and-mcp.md) ✅.
3. ~~디버깅/DX~~ → [debugging-and-dx](debugging-and-dx.md) ✅.
4. 부분(🟡) 칸 심화 — 루프 종료조건·예산 / 컨텍스트 압축 트리거 / 권한 매트릭스 / 메모리 계층.
   (한 칸씩 별도 보강으로 채워 🟡→✅)

> 이 자가평가는 외부 권위 체크리스트로 측정한 것이며, 칸이 채워질 때마다 위 표의 상태를 갱신합니다.
> 측정 가능한 진전(빈 칸 → 채움)이 곧 "최고의 하네스"로 가는 길입니다.

## 출처 (자가평가 기준)

- [awesome-harness-engineering](https://github.com/ai-boost/awesome-harness-engineering) (12개 하네스 카테고리 체크리스트)
- Adnan Masood — [Agent Harness Engineering: The Rise of the AI Control Plane](https://medium.com/@adnanmasood/agent-harness-engineering-the-rise-of-the-ai-control-plane-938ead884b1d) (15-모듈 컴포넌트 모델·위험 taxonomy)
- Atlan — [Best AI Agent Harness Tools 2026](https://atlan.com/know/best-ai-agent-harness-tools-2026/)
- Braintrust — [Agent Observability 2026](https://www.braintrust.dev/articles/agent-observability-complete-guide-2026)
