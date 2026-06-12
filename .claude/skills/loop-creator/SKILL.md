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
- **기준선이 초록이어야 등록한다.** `self-eval`이 non-zero면 루프를 띄우지 않고 회귀를
  진안에게 보고한다 — 깨진 기준선 위 루프는 매 fire가 그 회귀를 보고, 정지조건
  (`self-eval` exit 0)에 영영 못 닿는다(improve-muse와 같은 규칙).
- **main에 이미 자동 커밋/푸시 루프가 도는지 확인**(`git log --oneline -5`에 loop 커밋이
  연달아 있나). 있으면 신규 루프는 반드시 /tmp worktree에서 — 안 그러면 push가
  non-fast-forward로 충돌한다([[project_worktree_instability]] · [[project_loop_docs_reset]]).
- **연료 체크 (등록 전 경고).** 테마의 열린 backlog 항목(★/◦)을 센다. **≤2개면 얇음** —
  루프가 매 fire 거의 gap-scout 리필에 의존하게 되니, 등록 전에 진안에게 그 사실을 알리고
  *더 넓은 테마*(예: 단일 'browser' 대신 'TOOL expansion & hardening')를 제안한다. 진안이
  그래도 좁은 테마를 원하면 진행하되, 첫 fire가 gap-scout부터 돈다는 걸 §5 보고에 명시한다.

### 2. 계약을 채운다 (§4 체크리스트 — 빈 칸은 위험점, 명시)
각 항목을 이 루프에 맞게 구체화한다. Muse 기본 seam:

| 체크 항목 | 이 루프에서 (기본값) |
|---|---|
| 목적 한 줄 | 입력에서 / backlog ★에서 |
| 6 프리미티브 | Automation=cron · Worktree=/tmp(레포 밖, [[project_worktree_instability]]) · Skill=improve-muse+dev-loop · Connector=MCP · Sub-agent=harness planner→worker→evaluator · State=backlog.md+MEMORY.md |
| 검증가능 정지조건 | `pnpm self-eval` exit 0 + 관련 eval(eval:tools/eval:browser-agent/eval:agent/precheck:grounding) ≥ threshold + "backlog ★ 항목 Done"(이 'Done' 판정은 **독립 evaluator/진안**이 — 루프 자신이 maker=judge로 판정하지 않는다) |
| maker ≠ judge | 빌드 인스턴스와 별개의 evaluator(harness 또는 Agent 서브에이전트) |
| 사람-읽는 체크포인트 | **push 금지**(명시 승인 전), draft-first, 커밋만 |
| 토큰/스텝 캡 | fire당 1슬라이스, retry 2–3 상한, 예산 캡([`loop-budget.md`](../../../harness/loop-budget.md)) |
| **모델 티어링** | 정형 빌드/검색/문서 → Sonnet 서브에이전트(`Agent`/`Workflow` `model:"sonnet"`); 설계·모호함·적대적 검증 → Opus. maker=Sonnet / **judge=Opus**. 오케스트레이터는 얇게. (Muse 런타임 모델 gemma4는 고정 — [`loop-engineering.md`](../../../harness/loop-engineering.md) §1.5) |
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
모델 티어링(토큰 절약): 정형 빌드/검색은 Sonnet 서브에이전트(Agent/Workflow model:"sonnet")로
위임하고, 이 Opus 컨텍스트는 설계·모호한 포크·적대적 검증만; judge는 worker보다 강한 티어(Opus).
한 fire에 슬라이스 하나; 막히면 backlog에 블로커 기록 후 멈춤.
예산 캡: harness/loop-budget.md 한도 준수 — 토큰/비용이 캡에 닿으면 fire 중단 후 보고.
grounding floor(fabrication=0)·IMMUTABLE-CORE 절대 약화 금지.
무인 실수 방지: diff는 진안이 읽고 머지(comprehension debt 가드).
```

테마별로 ④의 eval과 ②의 backlog 섹션을 정확히 바꿔 넣는다(브라우저 루프면 eval:browser-agent 등).

### 3.5 자가검증 (등록 전, 필수 — "신뢰할 검증자라야 손을 뗀다")

등록은 행동이다. 등록 *전에* 생성물을 §4 체크리스트에 대고 스스로 PASS/FAIL한다:

- [ ] §4의 **10항목**이 전부 **채워졌거나 "N/A — 이유"로 명시**됐나? 빈 칸이 있으면 FAIL.
- [ ] 정지조건이 **실제로 실행 가능한 명령**인가 — `<해당 eval>` 자리에 실재하는
      `pnpm <script>`(package.json에 있는)가 들어갔나? placeholder가 안 치환됐거나
      "느낌상 됐다"면 FAIL — 띄우지 않고 블로커 보고.
- [ ] 프롬프트의 ④ eval이 테마와 맞나(브라우저인데 eval:browser-agent 빠지지 않았나)?
- [ ] push 금지·fabrication=0·IMMUTABLE-CORE·**예산 캡** 문구가 프롬프트에 살아있나?
- [ ] 모델 티어링 라인이 테마에 맞나(정형 위주면 Sonnet 위임이 실제로 토큰을 아끼나)?
- [ ] **같은 테마의 활성 cron이 이미 있나** — `CronList`로 확인. 있으면 등록 대신
      보고(중복 루프는 worktree·backlog·push에서 레이스를 낸다).

하나라도 FAIL이면 §3으로 돌아가 고친다. 전부 PASS여야 §4로 간다. (maker≠judge 정신:
이 점검을 별도 인스턴스/서브에이전트로 돌리면 더 신뢰할 수 있다.)

### 4. 등록한다 (cron)
생성한 프롬프트로 **`/loop` 스킬을 호출**해 등록한다(스케줄 매핑·클라우드 오퍼는 /loop이 소유):
`Skill(skill: "loop", args: "<간격> <생성한 프롬프트>")`.
- 간격이 sub-hour(예: 20m, 세션 루프)면 `/loop`이 `CronCreate`로 **세션 스코프 cron**을
  만든다 — 진짜 job id를 반환하고 `CronDelete`로 끌 수 있으나 세션을 닫으면 만료된다.
- ≥60m/daily면 `/loop`이 **클라우드 영속 스케줄**(`/schedule`)을 제안한다.
- `/loop`은 등록 직후 **첫 fire를 즉시 실행**한다 — 그게 곧 라이브 초도검증이다(아래 §5).

등록 후 반환된 **cron id를 기록**한다.

### 5. 보고한다
진안에게: ① 생성한 루프 프롬프트(전문), ② cron id + 간격(+ 세션/영속 여부),
③ 각 fire가 무엇을 할지 한 줄, ④ **첫 fire는 방금 즉시 실행됨**(/loop이 등록 직후 1회 돌림)
— 그 결과가 프롬프트 작동의 첫 증거, ⑤ 멈추는 법(`CronDelete <id>` 또는 cmux),
⑥ 무인 비용 경계(fire당 1슬라이스 캡 + loop-budget 한도).

## 하지 않는 것 (경계)

- **단일 슬라이스를 직접 빌드하지 않는다** — 그건 루프가 돈다(이 스킬은 *루프를 만든다*).
- **push하지 않는다** — 등록된 루프도 커밋만, 머지는 진안이.
- **불변식을 약화하지 않는다** — fabrication=0 / IMMUTABLE-CORE / 아웃바운드 fail-close.
- **정지조건 없이 띄우지 않는다** — 검증가능 조건을 못 쓰면 블로커로 보고하고 멈춘다.

## 워크드 예시 (입력 한 줄 → 등록)

> 진안: "browser 강화하는 루프 돌려줘"

1. **ORIENT** — backlog의 "★ TOOL expansion & hardening" 읽음; `pnpm self-eval` 그린(기준선 OK); main에 동시 푸시 루프 없음 확인.
2. **계약 채움** — 목적="브라우저 도구 확장+강화"; 정지조건=`pnpm check` + `pnpm eval:browser-agent` ≥ threshold + "backlog browser ◦ 항목 Done(독립 판정)"; eval=**eval:browser-agent**; 모델=정형 CDP 배선은 Sonnet, 프레임/grounding 설계는 Opus; connector=N/A(로컬 Chrome라 외부 트래커 불필요); 예산=loop-budget 한도.
3. **프롬프트 생성** — §3 골격에 위 값 박음(④가 `pnpm eval:browser-agent`로, ②가 browser 섹션으로, 예산 캡 줄 포함).
3.5 **자가검증** — 10항목 PASS(정지조건 `eval:browser-agent` 실재 확인, 같은 테마 cron 없음 `CronList`), push-금지·floor·예산 문구 살아있음 → 통과.
4. **등록** — `Skill(skill:"loop", args:"20m <생성한 프롬프트>")` → 세션 cron id 반환 + 첫 fire 즉시 실행.
5. **보고** — 프롬프트 전문 + cron id(세션) + "각 fire: browser ◦ 1슬라이스 TDD→check→eval:browser-agent→커밋" + 첫 fire 결과 + `CronDelete <id>`로 중단 + fire당 1슬라이스 비용 경계.

## 계보·출처 (왜 이 모양인가)

이 스킬의 원칙은 2026-06 "Loop Engineering" 합의에서 왔다 — **Peter Steinberger**
("designing loops that prompt your agents"), **Boris Cherny**(Anthropic, "I don't
prompt Claude anymore"), **Addy Osmani**(명명·정리). 전체 출처·심화 글은
[`harness/loop-engineering.md`](../../../harness/loop-engineering.md) §5. 토큰 효율
(모델 티어링)은 그 합의가 "Agent Orchestrator"의 핵심 craft로 꼽은 것과 일치.

## 멈추기

등록한 cron의 id를 §5에서 보고했다. 진안이 "루프 그만"이라 하면 `CronList`로 찾아
`CronDelete <id>`. 별도 cmux 백그라운드 루프는 cmux에서 중단([[feedback_no_loop_collaborate]]).
