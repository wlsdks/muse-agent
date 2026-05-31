---
title: 에이전트 하네스 (Agent Harness)
audience: [기획자, 개발자, AI 에이전트]
purpose: 어떤 에이전트가 들어와도 동일하게 일하도록 하는 운영 구조 문서 모음
status: draft
updated: 2026-05-30
related: [team-roles.md, ../README.md]
---

# 에이전트 하네스 (Agent Harness)

Muse 작업에 **어떤 AI 에이전트가 투입되든 똑같은 방식으로 협업**하게 만드는 운영 구조를 모읍니다.
2026년 5월 기준 검증된 멀티에이전트 패턴(Anthropic · Addy Osmani · Cognition · OpenAI)에 근거합니다.

> **이 폴더 하나가 곧 하네스입니다.** 자체완결이라 어떤 프로젝트에든 복사해 씁니다.
> - **에이전트라면 → [AGENTS.md](AGENTS.md) 를 읽고 그대로 따르세요** (운영 계약·진입점).
> - **새 프로젝트에 깔려면 → [INSTALL.md](INSTALL.md)** (복사 + 한 줄 연결 + 매핑 교체).
> - 아래 표는 사람용 인덱스입니다.

**상태:** 권위 12-카테고리 체크리스트 **전부 문서화(✅)**되었고, 실제 Claude Code로 **4종 실측 통과**
— 평가자·플래너 단일, 그리고 플래너→평가자·플래너→워커→평가자 연쇄가 양식만으로 한 사이클 맞물려
돕니다([harness-acceptance §7.5](harness-acceptance.md)). 남은 일: 골든 과제 묶음·반복(pass^k)으로
키우기. (개별 문서는 계속 다듬는 중이라 frontmatter는 draft.)

| 문서 | 무엇 | 상태 |
|---|---|---|
| [team-roles.md](team-roles.md) | 팀의 역할·경계·핸드오프·검증 게이트 정의 (벤더 중립) | draft |
| [handoff-template.md](handoff-template.md) | 한 작업당 채워 넘기는 핸드오프 아티팩트 단일 양식 | draft |
| [role-prompts.md](role-prompts.md) | 역할마다 붙이는 벤더 중립 시스템 프롬프트 블록 | draft |
| [muse-mapping.md](muse-mapping.md) | 추상 역할 ↔ Muse 실제 멀티에이전트 런타임 부품 매핑 (무엇이 곧바로 가능한가) | draft |
| [verification-and-guardrails.md](verification-and-guardrails.md) | 평가자 채점 루브릭 · 입출력 가드레일 · 게이트/관측/복구 규칙 | draft |
| [failure-modes-and-observability.md](failure-modes-and-observability.md) | 하네스가 무너지는 곳(~60%가 하네스 탓) · 최소 관측 · 복구 · 판정자 보정 | draft |
| [harness-acceptance.md](harness-acceptance.md) | 하네스가 "실제로 잘 됐는지" 검증하는 법 — 골든 과제·결과+경로·6층 테스트·문서 자체 점검 | draft |
| [golden-set.md](golden-set.md) | 실측으로 신뢰도를 쌓는 고정 과제집(G1~G10) + pass^k 진행 현황 | draft |
| [runner-spec.md](runner-spec.md) | 핸드오프·게이트를 "사람이 채움"→"런타임이 강제"로 올리는 실행 계약 | draft |
| [runner/](runner/) | **코드 러너** — 게이트·루프·훅을 결정론 코드로 강제(`node --test harness/runner/` 33/33) | code |
| [hooks.md](hooks.md) | **훅** 레이어(PreToolUse/PostToolUse) — 도구 호출을 우회 불가로 막거나 관측 | draft |
| [observability.md](observability.md) | **관측** 레이어 — 상관 ID 트레이스·요약(비용/단계)·redaction | draft |
| [session-persistence.md](session-persistence.md) | **세션 영속** — 체크포인트·재개(완료 단계 재실행 없이) | draft |
| [claude-code-integration.md](claude-code-integration.md) | **Claude Code 통합** — 서브에이전트·에이전트 팀·Dynamic Workflows + 오케스트레이션 선택 규약(그냥작업/서브/팀/워크플로) | draft || [judge-calibration.md](judge-calibration.md) | 평가자를 사람 라벨에 보정(TPR/TNR) — 무효 탐지가 강한지 수치 증명 | draft |
| [architecture.md](architecture.md) | **구성도(한 장)** + 2026 권위 체크리스트 대비 자가평가(무엇이 있고 무엇이 빠졌나) | draft |
| [tool-design.md](tool-design.md) | 도구를 어떻게 설계·노출해 한 번에 올바로 고르게 하나(한-shot 선택·예시스키마·위험등급) | draft |
| [skills-and-mcp.md](skills-and-mcp.md) | 외부 도구(MCP)·자작 스킬을 안전하게 끌어오는 규약(2단계 허용목록·격리·최소권한·불신출력) | draft |
| [debugging-and-dx.md](debugging-and-dx.md) | 비결정적 실패를 트레이스→격리→결정론 재현→회귀로 고치는 흐름 | draft |
| [loop-budget.md](loop-budget.md) | 루프가 무한 반복·비용 폭주 없이 끝나게 하는 횟수·시간·예산 하드캡 + 회로차단 | draft |
| [context-compaction.md](context-compaction.md) | 문맥 창이 넘치지 않게 줄이되 결정·출처는 보존(선제·주기·예산인지·중요도 가중) | draft |
| [permission-matrix.md](permission-matrix.md) | 위험 등급 × 처리(통과/신뢰/승인/거부) 매트릭스 + 최소권한 + 감사 | draft |
| [memory-layers.md](memory-layers.md) | 작업·단기·장기·사용자모델·에피소드 5계층 + 쓰기/읽기/정리/승격/감쇠 | draft |

## 새 에이전트가 합류하면 (골격 사용법)

1. [team-roles §7](team-roles.md) 체크리스트로 자기 **역할 한 개**를 고른다.
2. [role-prompts](role-prompts.md)에서 그 역할 블록을 시스템 프롬프트에 붙인다.
3. [handoff-template](handoff-template.md) 양식의 **자기 섹션만** 채우고 다음 역할로 넘긴다.

> 다음 조각(예정): 검증 게이트 실행 형태(완료 훅·체크포인트). Muse 런타임 매핑은 [muse-mapping](muse-mapping.md) 참고.
