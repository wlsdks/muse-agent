---
name: loop-creator
description: Use when 진안 wants to start (register) an autonomous improvement loop on the Muse repo — "루프 돌려줘", "loop 등록", "X를 계속 강화하는 루프", or just a theme to iterate on. Generates a principle-compliant recurring loop prompt from harness/loop-engineering.md AND registers the cron itself, then reports the prompt + cron id + how to stop. The autonomous successor to hand-written ad-hoc loop prompts.
---

# loop-creator — 원칙을 지키는 자율 루프를 생성하고 등록한다

## Overview

한 번 호출하면 끝까지 한다: **테마/목적을 받아 → 루프-엔지니어링 계약을 채워 →
재귀 루프 프롬프트를 생성 → cron으로 등록 → 멈추는 법까지 보고.** 진안이 루프를
자주 돌리므로, 매번 손으로 ad-hoc 프롬프트를 짜지 않게 이 스킬이 대신한다.

계약 본체는 [`harness/loop-engineering.md`](../../../harness/loop-engineering.md) —
6 프리미티브 · 검증가능 정지조건 · maker≠judge · 3대 실패모드 가드. 이 스킬은 그
계약을 *적용*하는 생성기다. 단일 슬라이스 빌드는 하지 않는다(그건 루프가 돌며 함).

## 입력 해석

- **테마/목적이 있으면** (예: "브라우저 강화", "agent-core 하드닝") → 그걸 목적으로 채운다.
- **간격이 있으면** (예: "20분") → 그 간격. 없으면 기본 **20m**(세션 루프).
- **아무것도 없으면** → `docs/goals/backlog.md` 최상단 ★ 테마를 목적으로 제안하고 진행
  (improve-muse처럼 "할 게 없다"는 금지 — backlog가 비면 gap-scout 리필이 곧 목적).

요지: 진안이 한 줄만 던져도 나머지는 스스로 채운다. 모호한 포크가 있을 때만 1개 질문.

## 파이프라인 (생성, 그다음 등록)

### 1. ORIENT — 계약과 현재 상태를 읽는다
- [`harness/loop-engineering.md`](../../../harness/loop-engineering.md)의 §1 표와 §4 체크리스트를 읽는다.
- `docs/goals/backlog.md` 최상단(작업 소스), `git log --oneline -5`(최근 무엇), `pnpm self-eval`(회귀?).

### 2. 계약을 채운다 (§4 체크리스트 — 빈 칸은 위험점, 명시)
각 항목을 이 루프에 맞게 구체화한다. Muse 기본 seam:

| 체크 항목 | 이 루프에서 (기본값) |
|---|---|
| 목적 한 줄 | 입력에서 / backlog ★에서 |
| 6 프리미티브 | Automation=cron · Worktree=/tmp(레포 밖, [[project_worktree_instability]]) · Skill=improve-muse+dev-loop · Connector=MCP · Sub-agent=harness planner→worker→evaluator · State=backlog.md+MEMORY.md |
| 검증가능 정지조건 | `pnpm self-eval` exit 0 + 관련 eval(eval:tools/eval:browser-agent/eval:agent/precheck:grounding) ≥ threshold + "backlog ★ 항목 Done" |
| maker ≠ judge | 빌드 인스턴스와 별개의 evaluator(harness 또는 Agent 서브에이전트) |
| 사람-읽는 체크포인트 | **push 금지**(명시 승인 전), draft-first, 커밋만 |
| 토큰/스텝 캡 | fire당 1슬라이스, retry 2–3 상한 |
| State 파일 | `docs/goals/backlog.md`에 Done/다음 write-back |
| 불변식 | fabrication=0 floor + IMMUTABLE-CORE 불가침 |
| 중단 방법 | cron id 기록 + CronDelete/cmux |

빈 칸(예: connector가 무의미한 루프)은 "N/A — 이유"로 명시한다. 채울 수 없는 정지조건이면
**띄우지 않고** 그 블로커를 보고한다(루프가 아직 준비 안 된 것).

### 3. 재귀 루프 프롬프트를 생성한다
아래 골격으로, 위에서 채운 값을 박아 *한 fire가 무엇을 하는지*를 자기완결로 쓴다:

```
Muse 자율 개선 루프 — 테마: <목적>. 반드시 Node 24(nvm default).
① docs/goals/backlog.md를 먼저 읽고 `pnpm self-eval`로 회귀를 확인 — 있으면 그게 이번 이터레이션.
② <테마>의 최상단 ★/◦ 항목 하나(비면 gap-scout 리필이 작업).
③ harness/dev-loop.md §3에 따라 가장 작은 검증가능 슬라이스를 TDD-first로.
   새 도구는 tool-calling.md 체크리스트 + eval:tools 골든 케이스.
④ 검증(정지조건): 가장 좁은 테스트 → pnpm check → 관련 eval(<해당 eval>) → pnpm lint.
   maker≠judge: 검증은 빌드와 별개 인스턴스/서브에이전트로.
⑤ write-back(테스트/eval/backlog Done) 포함 커밋. **push 절대 금지.**
한 fire에 슬라이스 하나; 막히면 backlog에 블로커 기록 후 멈춤.
grounding floor(fabrication=0)·IMMUTABLE-CORE 절대 약화 금지.
무인 실수 방지: diff는 진안이 읽고 머지(comprehension debt 가드).
```

테마별로 ④의 eval과 ②의 backlog 섹션을 정확히 바꿔 넣는다(브라우저 루프면 eval:browser-agent 등).

### 4. 등록한다 (cron)
생성한 프롬프트로 **`/loop` 스킬을 호출**해 등록한다(스케줄 매핑·클라우드 오퍼는 /loop이 소유):
`Skill(skill: "loop", args: "<간격> <생성한 프롬프트>")`.
간격이 sub-hour(세션 루프)면 그대로, ≥60m/daily면 /loop이 클라우드 스케줄을 제안한다.
등록 후 반환된 **cron id를 기록**한다.

### 5. 보고한다
진안에게: ① 생성한 루프 프롬프트(전문), ② cron id + 간격, ③ 각 fire가 무엇을 할지 한 줄,
④ 멈추는 법(`CronDelete <id>` 또는 cmux), ⑤ 무인 비용 경계(fire당 1슬라이스 캡).

## 하지 않는 것 (경계)

- **단일 슬라이스를 직접 빌드하지 않는다** — 그건 루프가 돈다(이 스킬은 *루프를 만든다*).
- **push하지 않는다** — 등록된 루프도 커밋만, 머지는 진안이.
- **불변식을 약화하지 않는다** — fabrication=0 / IMMUTABLE-CORE / 아웃바운드 fail-close.
- **정지조건 없이 띄우지 않는다** — 검증가능 조건을 못 쓰면 블로커로 보고하고 멈춘다.

## 멈추기

등록한 cron의 id를 §5에서 보고했다. 진안이 "루프 그만"이라 하면 `CronList`로 찾아
`CronDelete <id>`. 별도 cmux 백그라운드 루프는 cmux에서 중단([[feedback_no_loop_collaborate]]).
