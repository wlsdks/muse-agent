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
2026년 5월 기준 검증된 멀티에이전트 패턴(Anthropic · Addy Osmani)에 근거합니다.

| 문서 | 무엇 | 상태 |
|---|---|---|
| [team-roles.md](team-roles.md) | 팀의 역할·경계·핸드오프·검증 게이트 정의 (벤더 중립) | draft |
| [handoff-template.md](handoff-template.md) | 한 작업당 채워 넘기는 핸드오프 아티팩트 단일 양식 | draft |
| [role-prompts.md](role-prompts.md) | 역할마다 붙이는 벤더 중립 시스템 프롬프트 블록 | draft |
| [muse-mapping.md](muse-mapping.md) | 추상 역할 ↔ Muse 실제 멀티에이전트 런타임 부품 매핑 (무엇이 곧바로 가능한가) | draft |

## 새 에이전트가 합류하면 (골격 사용법)

1. [team-roles §7](team-roles.md) 체크리스트로 자기 **역할 한 개**를 고른다.
2. [role-prompts](role-prompts.md)에서 그 역할 블록을 시스템 프롬프트에 붙인다.
3. [handoff-template](handoff-template.md) 양식의 **자기 섹션만** 채우고 다음 역할로 넘긴다.

> 다음 조각(예정): 검증 게이트 실행 형태(완료 훅·체크포인트). Muse 런타임 매핑은 [muse-mapping](muse-mapping.md) 참고.
