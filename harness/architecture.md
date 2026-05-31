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
빌드 칸 → 평가자가 평가 칸(만든 워커와 다른 에이전트) → **큐레이터/학습자**가 통한 전략을 강화하고
배운 절차를 정돈해 **다음 작업을 더 낫게** 만듭니다(Muse 고유의 자기학습 환류). 모든 단계가 가드레일·게이트·관측·복구라는
**가로 토대** 위에서 돌고, 하네스 자체는 검증(골든 과제·6층)으로 점검됩니다.

## 2. 문서 → 구성 요소 지도

| 구성 요소 | 담은 문서 |
|---|---|
| 역할·패턴·경계(큐레이터/학습자 포함 7역할) | [team-roles](team-roles.md) |
| 역할별 붙여넣기 프롬프트 | [role-prompts](role-prompts.md) |
| 자기학습 환류(스킬·플레이북·회고) | [team-roles](team-roles.md) 큐레이터/학습자 + [muse-mapping](muse-mapping.md) |
| 도구 설계 / 외부 도구(스킬·MCP) | [tool-design](tool-design.md) · [skills-and-mcp](skills-and-mcp.md) |
| 루프 종료·예산 / 컨텍스트 압축 | [loop-budget](loop-budget.md) · [context-compaction](context-compaction.md) |
| 권한 매트릭스 / 메모리 계층 | [permission-matrix](permission-matrix.md) · [memory-layers](memory-layers.md) |
| 디버깅·DX | [debugging-and-dx](debugging-and-dx.md) |
| 작업 상태(핸드오프) | [handoff-template](handoff-template.md) |
| 가드레일·게이트 | [verification-and-guardrails](verification-and-guardrails.md) |
| 실패 모드·관측·복구 | [failure-modes-and-observability](failure-modes-and-observability.md) |
| 하네스 자체 검증 | [harness-acceptance](harness-acceptance.md) |
| Muse 런타임 매핑 | [muse-mapping](muse-mapping.md) |

## 3. 자가평가 — 2026 체크리스트 대비

권위 체크리스트(awesome-harness-engineering의 12개 카테고리)에 비춘 현재 상태:

| # | 권위 카테고리 | 우리 하네스 | 상태 |
|---|---|---|---|
| 1 | 에이전트 루프 | team-roles 패턴 + [loop-budget](loop-budget.md)(횟수·시간·예산 하드캡·회로차단) | ✅ |
| 2 | 계획·분해 | 플래너 역할 + 핸드오프 계획 칸 | ✅ |
| 3 | 컨텍스트·압축 | [context-compaction](context-compaction.md) — 선제·주기·예산인지·중요도 가중 보존 (+실측: 결정·출처 보존 pass^2) | ✅ |
| 4 | 도구 설계 | [tool-design](tool-design.md) — 한-shot 선택·예시스키마·위험등급 | ✅ |
| 5 | 스킬·MCP | [skills-and-mcp](skills-and-mcp.md) — 2단계 허용목록·격리·최소권한·불신출력 | ✅ |
| 6 | 권한·승인 | [permission-matrix](permission-matrix.md) — 위험등급×처리·최소권한·감사 (+실측: outbound=막힘우선·금융=거부) | ✅ |
| 7 | 메모리·상태 | [memory-layers](memory-layers.md) + 핸드오프 상태로그 — 5계층·쓰기/읽기/정리 (+실측: 쓰기 규칙 pass^2) | ✅ |
| 8 | 오케스트레이션 | team-roles + muse-mapping | ✅ |
| 9 | 검증·CI | verification + acceptance(6층) | ✅ |
| 10 | 관측·트레이스 | failure-modes 관측 | ✅ |
| 11 | 디버깅·DX | [debugging-and-dx](debugging-and-dx.md) — 트레이스→격리→결정론 재현→회귀 | ✅ |
| 12 | 사람 개입(HITL) | 게이트·승인·체크인 | ✅ |

**한 줄 결론:** **12개 카테고리 전부 ✅ 문서화** (⬜ 0 / 🟡 0) **+ 실제 Claude Code로 다수 실측 통과**
(평가자 양방향·빈기준 막힘·워커 수렴·3역할 연쇄 + 권한·메모리·압축 게이트 — 반복 pass^k 포함,
[harness-acceptance §7.5](harness-acceptance.md)). **그리고 이제 참고 문서가 아니라 활성·포터블**:
진입점 [AGENTS.md](AGENTS.md)로 에이전트가 읽고 따르며(이 저장소는 루트 `AGENTS.md`·`CLAUDE.md`에서
연결), [INSTALL](INSTALL.md)로 어떤 프로젝트에든 `harness/` 폴더째 복사해 재사용합니다.

## 4. 다음에 채울 것 (우선순위)

1. ~~도구 설계 규약~~ → [tool-design](tool-design.md) ✅.
2. ~~스킬/MCP 통합~~ → [skills-and-mcp](skills-and-mcp.md) ✅.
3. ~~디버깅/DX~~ → [debugging-and-dx](debugging-and-dx.md) ✅.
4. ~~루프 종료·예산~~ → [loop-budget](loop-budget.md) ✅.
5. ~~컨텍스트 압축~~ → [context-compaction](context-compaction.md) ✅.
6. ~~권한 매트릭스~~ → [permission-matrix](permission-matrix.md) ✅ · ~~메모리 계층~~ → [memory-layers](memory-layers.md) ✅.

**모든 칸 ✅ + 활성·포터블 + 코드 강제까지 완료:** ① **최소 코드 러너 구현·검증** — [runner/](runner/)가
게이트를 결정론 코드로 강제, §7 거부 매트릭스 `node --test` **13/13** ② **평가자 사람-라벨 보정** —
[judge-calibration](judge-calibration.md) TPR 2/2·**TNR 4/4=100%**(일반 판정자 TNR<25% 기준선 상회)
③ **모호 골든 확장** — G11(부분충족)·G12(의미버그/TNR).

**L4 실행통합·CI·적대까지(2026-05-31):** ④ **러너가 실제 구동** — [runner/orchestrator.mjs](runner/orchestrator.mjs)가
plan→build→eval을 코드 게이트로 막으며 실제 `claude -p`로 구동, end-to-end **3/3 DONE** + 트레이스
⑤ **적대 9/9 차단**(게이트 우회 시도 전부 BLOCKED) ⑥ **CI 게이트** harness.yml(`node --test` 27/27).
성숙도: 설계/근거/코드강제 + **실행통합·CI·적대**까지 도달. **L5 진행:** 실전형 과제 G13·G14를 통합
러너로 실제 구동(누적 5/5 DONE)·판정자 보정 n=6→**12**(TPR 4/4·TNR 8/8). 남은 것: 대형 다단계·실
코드베이스 작업, 보정셋 더 키우기+반복, 트레이스 관측 확장.

> 이 자가평가는 외부 권위 체크리스트로 측정한 것이며, 칸이 채워질 때마다 위 표의 상태를 갱신합니다.
> 측정 가능한 진전(빈 칸 → 채움)이 곧 "최고의 하네스"로 가는 길입니다.

## 출처 (자가평가 기준)

- [awesome-harness-engineering](https://github.com/ai-boost/awesome-harness-engineering) (12개 하네스 카테고리 체크리스트)
- Adnan Masood — [Agent Harness Engineering: The Rise of the AI Control Plane](https://medium.com/@adnanmasood/agent-harness-engineering-the-rise-of-the-ai-control-plane-938ead884b1d) (15-모듈 컴포넌트 모델·위험 taxonomy)
- Atlan — [Best AI Agent Harness Tools 2026](https://atlan.com/know/best-ai-agent-harness-tools-2026/)
- Braintrust — [Agent Observability 2026](https://www.braintrust.dev/articles/agent-observability-complete-guide-2026)
- Anthropic — [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) · [Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) (컨텍스트 리셋·구조화 핸드오프·압축)
- [AGENTS.md](https://agents.md/) — OpenAI 발원·Linux Foundation 표준, 6만+ 레포가 채택한 교차도구 에이전트 지시 포맷(이 하네스의 진입점 형식)
- Addy Osmani — [Agent Harness Engineering](https://addyosmani.com/blog/agent-harness-engineering/) ("모델이 아니라 설정 문제" — 에이전트 실패의 ~60%가 하네스에서 비롯)
- Cognition — [Don't Build Multi-Agents](https://cognition.ai/blog/dont-build-multi-agents) → [Multi-Agents: What's Actually Working](https://cognition.ai/blog/multi-agents-working) (2026: 쓰기는 단일 스레드, 보조 에이전트는 행위가 아닌 지능을 더하는 map-reduce-and-manage)
- Hamel Husain — [Using LLM-as-a-Judge](https://hamel.dev/blog/posts/llm-judge/) (판정자를 사람 라벨에 보정)
- OpenAI — [Harness engineering: leveraging Codex in an agent-first world](https://openai.com/index/harness-engineering/) (결정론 스캐폴딩·구조적 게이트·~100줄 AGENTS.md 맵·하네스>모델)
- Andrej Karpathy — [agentic engineering / autonomy slider](https://www.nextbigfuture.com/2026/03/andrej-karpathy-on-code-agents-autoresearch-and-the-self-improvement-loopy-era-of-ai.html) ("권한 늘리기 전에 evals부터"·자율성 슬라이더·tight leash)
- Boris Cherny (Claude Code 창시자) — [workflow/harness](https://karozieminski.substack.com/p/boris-cherny-claude-code-workflow) (thin harness·smart model·loop 중심; Claude Code 하네스 5계층)
- [Faramesh: protocol-agnostic execution control plane](https://arxiv.org/pdf/2601.17744) (non-bypassable·fail-closed 권한 — 게이트 코드화의 근거)
