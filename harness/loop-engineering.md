---
title: 루프 엔지니어링 — 자율 루프를 "설계"하는 계약 (Loop Engineering)
audience: [AI 에이전트, 개발자]
purpose: 자율 루프를 띄울 때마다 즉흥적으로 프롬프트를 짜는 대신, 검증된 루프-엔지니어링 원칙으로 6개 프리미티브·검증가능 정지조건·maker≠judge·3대 실패모드 가드를 매번 보장한다. `loop-creator` 스킬이 활성화하는 본체.
format: harness layer (vendor-neutral)
source: Addy Osmani, "Loop Engineering" (addyosmani.com/blog/loop-engineering) — 2026 검증
updated: 2026-06-12
---

# 루프 엔지니어링 — Loop Engineering

> **이 파일은 "자율 루프를 어떻게 설계하는가"의 계약입니다.**
> [`dev-loop.md`](dev-loop.md)가 *한 슬라이스를 어떻게 고르고 실행하나*라면,
> 이 파일은 *그 슬라이스를 도는 루프 자체를 어떻게 구성하나*입니다.
> `.claude/skills/loop-creator`가 이 계약을 읽고 잘 짜인 루프를 *생성*합니다 —
> 매번 손으로 ad-hoc 프롬프트를 쓰지 않게.

## 0. 한 줄 (왜 만들었나)

Addy Osmani: **"Loop engineering is replacing yourself as the person who
prompts the agent. You design the system that does it instead."** 프롬프트
엔지니어링이 *당신이 매 턴 프롬프트를 치는 것*이라면, 루프 엔지니어링은
*일을 찾고·나눠주고·검증하고·무엇이 끝났는지 적고·다음을 정하는 작은 시스템을
짜는 것*. 레버는 "도구를 계속 손에 쥐고 있는 것"에서 "그 손을 대체하는 설계"로 옮겨간다.

증상(진안이 겪던 것): 루프를 띄울 때마다 프롬프트가 매번 임시방편 — 6개 프리미티브가
다 들어갔는지, 정지조건이 검증가능한지, 검증자가 maker와 분리됐는지 보장이 없었다.
이 파일이 그 보장을 **체크리스트**로 고정한다.

## 1. 6개 프리미티브 — Muse seam 매핑 (전부 들어갔나)

루프는 아래 6개가 **전부** 배선됐을 때만 잘 돈다. 대부분 Muse에 이미 있으니
*재발명하지 말고 가리켜라*. 빈 칸이 있으면 그게 이번 루프의 위험점이다.

| 프리미티브 | 뜻 (Addy) | Muse seam (이미 있음) |
|---|---|---|
| **Automation** | 스케줄로 돌며 일을 찾고 triage해 inbox로 — 사람이 감시 안 해도 | `/loop` cron (CronCreate) / ScheduleWakeup |
| **Worktree** | 병렬 에이전트가 파일 쓰기에서 충돌 안 하게 격리된 git 체크아웃 | /tmp worktree (**레포 트리 밖**에 — [[project_worktree_instability]]) |
| **Skill** | 프로젝트 지식(`SKILL.md`)을 재사용 — 매 사이클 컨텍스트 재유도 방지 | `.claude/skills/` (improve-muse), [`dev-loop.md`](dev-loop.md) |
| **Connector** | MCP로 외부 도구(이슈트래커·DB·Slack)에 *실제로 행동* | MCP (codegraph 등), [`skills-and-mcp.md`](skills-and-mcp.md) |
| **Sub-agent** | 다른 지시/모델의 에이전트가 **ideation과 verification을 분리** | harness planner→worker→evaluator ([`team-roles.md`](team-roles.md)), Agent 도구 |
| **State/Memory** | "모델은 런 사이에 다 잊는다 — 메모리는 컨텍스트가 아니라 **디스크**에" | [`backlog.md`](../docs/goals/backlog.md), `MEMORY.md`, self-eval-scoreboard, [`session-persistence.md`](session-persistence.md) |

> 토큰 예산은 7번째 축이다 — 무인 루프는 비용이 "token rich/poor에 따라 크게"
> 흔들린다. 캡은 [`loop-budget.md`](loop-budget.md)가 소유한다. 루프 프롬프트는 fire당
> 1슬라이스 + retry 2–3회 상한을 명시할 것.

## 2. 검증가능 정지조건 — `/goal` (지금의 갭)

Addy의 "두 번째 프리미티브": 에이전트는 **"당신이 쓴 조건이 실제로 참일 때까지"**
반복하고, **매 턴 별도의 작은 모델이 끝났는지 검사**한다 — 검사 모델은 코딩 모델이 아니다.

Muse 루프는 대개 *타이머*로 돈다(20분마다). 그건 *스케줄*이지 *목표*가 아니다. 잘 짜인
루프는 둘 다 갖는다:

- **타이머**가 *언제* 깨우나를 정하고,
- **검증가능 조건**이 *언제 멈추나*를 정한다 — `pnpm self-eval` exit 0,
  `eval:tools` ≥ threshold, "backlog의 이 ★ 항목이 Done", "fabrication=0 배터리 pass^k".

정지조건은 **결정적이거나 judge-backed**여야 한다 — "느낌상 됐다"는 정지조건이 아니다.
[`verification-and-guardrails.md`](verification-and-guardrails.md)의 게이트가 그 조건의 재료다.
조건을 못 쓰겠으면 그 루프는 아직 띄울 준비가 안 된 것이다.

## 3. 3대 실패모드 가드 (루프가 좋아질수록 *날카로워지는* 것)

Addy: 이 셋은 "루프가 나아질수록 쉬워지는 게 아니라 더 날카로워진다." 모든 루프 설계가
아래 셋에 대한 **명시적 가드**를 가져야 한다.

1. **Unattended verification failure** — *"무인으로 도는 루프는 무인으로 실수도 하는
   루프다."* 검증자 서브에이전트는 *체크*지 *증명*이 아니다. **maker ≠ judge**는
   협상 불가([`team-roles.md`](team-roles.md), agent-testing.md): 코드를 쓴 인스턴스가
   자기 숙제를 채점하지 않는다. 가드 = 독립 evaluator + 사람의 최종 확인(아래 3).
2. **Comprehension debt** — *"루프가 당신이 안 쓴 코드를 빨리 내놓을수록, 존재하는
   것과 당신이 실제로 이해하는 것 사이 격차가 커진다."* 가드 = 루프가 만든 diff를
   **사람이 읽는 체크포인트**를 설계에 박는다(push 금지·draft-first가 이걸 강제).
3. **Cognitive surrender** — *"루프가 스스로 돌면 의견을 갖길 멈추고 그냥 받는 게
   유혹적이다."* 같은 시스템이라도 *판단을 갖고* 설계한 것과 *생각을 피하려고* 설계한
   것은 정반대 결과를 낸다. 가드 = 루프는 **후보를 surface**할 뿐, 품질을 자기판정하지
   않는다. 사람은 "go를 누르는 사람"이 아니라 "엔지니어"로 남는다.

## 4. 루프를 띄우기 전 체크리스트 (loop-creator가 강제)

- [ ] **목적 한 줄** — 이 루프가 *무엇을* 더 강하게 만드나.
- [ ] **6 프리미티브 전부 배선** — §1 표의 빈 칸 = 위험점. 없으면 명시.
- [ ] **검증가능 정지조건** — §2. 결정적/judge-backed. 못 쓰면 띄우지 않는다.
- [ ] **maker ≠ judge** — 빌드 인스턴스 ≠ 검증 인스턴스. §3-1.
- [ ] **사람-읽는 체크포인트** — diff 리뷰 지점. push 금지(명시 승인 전). §3-2.
- [ ] **토큰/스텝 캡** — fire당 1슬라이스, retry 2–3 상한, 예산 캡. [`loop-budget.md`](loop-budget.md).
- [ ] **State 파일** — 무엇이 Done·다음은 무엇. 디스크에([`backlog.md`](../docs/goals/backlog.md)).
- [ ] **불변식 불가침** — fabrication=0 floor + IMMUTABLE-CORE는 절대 약화 안 함.
- [ ] **중단 방법** — cron id 기록, 어떻게 멈추나(CronDelete/cmux), 무인 비용 경계.

## 5. 출처 (1차)

- Addy Osmani — [Loop Engineering](https://addyosmani.com/blog/loop-engineering/)
- 본 harness의 인접 계약: [`dev-loop.md`](dev-loop.md)(슬라이스 선택·실행),
  [`team-roles.md`](team-roles.md)(maker≠judge), [`verification-and-guardrails.md`](verification-and-guardrails.md)(게이트),
  [`loop-budget.md`](loop-budget.md)(예산), [`session-persistence.md`](session-persistence.md)(state).
