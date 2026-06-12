---
title: 루프 엔지니어링 — 자율 루프를 "설계"하는 계약 (Loop Engineering)
audience: [AI 에이전트, 개발자]
purpose: 자율 루프를 띄울 때마다 즉흥적으로 프롬프트를 짜는 대신, 검증된 루프-엔지니어링 원칙으로 6개 프리미티브·검증가능 정지조건·maker≠judge·3대 실패모드 가드를 매번 보장한다. `loop-creator` 스킬이 활성화하는 본체.
format: loop-creator skill reference (vendor-neutral principles, bundled with the skill)
source: Addy Osmani, "Loop Engineering" (addyosmani.com/blog/loop-engineering) — 2026 검증
updated: 2026-06-12
---

# 루프 엔지니어링 — Loop Engineering

> **이 파일은 "자율 루프를 어떻게 설계하는가"의 계약입니다.**
> [`dev-loop.md`](../../../../harness/dev-loop.md)가 *한 슬라이스를 어떻게 고르고 실행하나*라면,
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
| **Skill** | 프로젝트 지식(`SKILL.md`)을 재사용 — 매 사이클 컨텍스트 재유도 방지 | `.claude/skills/` (improve-muse), [`dev-loop.md`](../../../../harness/dev-loop.md) |
| **Connector** | MCP로 외부 도구(이슈트래커·DB·Slack)에 *실제로 행동* | MCP (codegraph 등), [`skills-and-mcp.md`](skills-and-mcp.md) |
| **Sub-agent** | 다른 지시/모델의 에이전트가 **ideation과 verification을 분리** | harness planner→worker→evaluator ([`team-roles.md`](../../../../harness/team-roles.md)), Agent 도구 |
| **State/Memory** | "모델은 런 사이에 다 잊는다 — 메모리는 컨텍스트가 아니라 **디스크**에" | [`backlog.md`](../../../../docs/goals/backlog.md), `MEMORY.md`, self-eval-scoreboard, [`session-persistence.md`](../../../../harness/session-persistence.md) |

> 토큰 예산은 7번째 축이다 — 무인 루프는 비용이 "token rich/poor에 따라 크게"
> 흔들린다. 캡은 [`loop-budget.md`](../../../../harness/loop-budget.md)가 소유한다. 루프 프롬프트는 fire당
> 1슬라이스 + retry 2–3회 상한을 명시할 것.

## 1.5 모델 티어링 — 토큰 절약의 핵심 레버

Addy: 서브에이전트는 "다른 지시 **그리고 모델**"로 ideation과 verification을 가른다 —
검증자는 explorer보다 "더 강한 모델, 더 높은 reasoning effort"일 수 있다. 즉 **모든 턴을
가장 비싼 모델로 돌리는 건 낭비다.** 무인 루프에서 토큰을 가장 크게 아끼는 한 수.

규칙 (Muse, 비용 ↓ 품질 유지):

1. **일상 작업 → 싼 티어(Sonnet).** 기계적 TDD·검색·문서·정형 슬라이스 빌드는
   Sonnet 서브에이전트로 위임(`Agent` 도구 / `Workflow` `agent()`의 `model: "sonnet"`).
   루프 fire의 대부분이 정형이므로 여기서 토큰이 가장 많이 빠진다.
2. **어려운 곳만 강한 티어 — 계획/설계는 Fable 5 우선.** 설계 판단·계획 수립·모호한
   포크·회귀 진단은 **Fable 5(`model:"fable"`)를 *가능할 때* 쓰고, 불가하면 Opus 4.8
   (`claude-opus-4-8[1m]`)로 폴백**. (개발/빌드는 Opus든 Sonnet이든 무관 — 위 1번.)
3. **maker ≠ judge를 모델 티어로도 구현.** worker=Sonnet, **evaluator=강한 티어**(Fable 5
   가능 시, 아니면 Opus 4.8 — 더 강한 판정자). 토큰을 아끼면서 동시에 검증 품질을 *높인다* — Addy의 "신뢰할 검증자라야
   손을 뗄 수 있다"와 정확히 일치([`team-roles.md`](../../../../harness/team-roles.md)).
4. **오케스트레이터는 얇게.** 메인 컨텍스트(Opus)는 *고르고·나눠주고·검증을 읽는*
   역할만; 토큰-무거운 본작업은 싼 티어 서브에이전트로 밀어낸다.

레버는 서브에이전트/Workflow의 `model` 오버라이드(`fable`/`opus`/`sonnet`/`haiku`)다. 단,
Muse의 *런타임* 모델(로컬 gemma4:12b, fabrication floor를 도는 모델)은 **고정**이다 —
티어링은 *개발 루프를 모는 Claude Code 에이전트*의 비용 얘기지, Muse 제품 모델을 바꾸는
게 아니다([[project_local_first]] · [[project_gemma4_default]]).

## 2. 검증가능 정지조건 — `/goal` (지금의 갭)

이 흐름의 발화점(2026-06): **Peter Steinberger** — *"You shouldn't be prompting
coding agents anymore. You should be designing loops that prompt your agents."*
— 와 **Boris Cherny**(Anthropic, Claude Code) — *"I don't prompt Claude anymore.
I have loops running that prompt Claude."* — 를 **Addy Osmani**가 "Loop
Engineering"으로 명명·정리했다(§5).

Addy의 "두 번째 프리미티브"가 `/goal`: 에이전트는 **"당신이 쓴 조건이 실제로 참일
때까지"** 반복하고, **매 턴 별도의 작은 모델이 끝났는지 검사**한다 — 검사 모델은 코딩
모델이 아니다(= maker≠judge가 정지판정에도 적용). Claude Code/Codex가 이 프리미티브를
제품에 실었다.

Muse 루프는 대개 *타이머*로 돈다(20분마다). 그건 *스케줄*이지 *목표*가 아니다. 잘 짜인
루프는 둘 다 갖는다:

- **타이머**가 *언제* 깨우나를 정하고,
- **검증가능 조건**이 *언제 멈추나*를 정한다 — `pnpm self-eval` exit 0,
  `eval:tools` ≥ threshold, "backlog의 이 ★ 항목이 Done", "fabrication=0 배터리 pass^k".

정지조건은 **결정적이거나 judge-backed**여야 한다 — "느낌상 됐다"는 정지조건이 아니다.
[`verification-and-guardrails.md`](../../../../harness/verification-and-guardrails.md)의 게이트가 그 조건의 재료다.
조건을 못 쓰겠으면 그 루프는 아직 띄울 준비가 안 된 것이다.

## 3. 3대 실패모드 가드 (루프가 좋아질수록 *날카로워지는* 것)

Addy: 이 셋은 "루프가 나아질수록 쉬워지는 게 아니라 더 날카로워진다." 모든 루프 설계가
아래 셋에 대한 **명시적 가드**를 가져야 한다.

1. **Unattended verification failure** — *"무인으로 도는 루프는 무인으로 실수도 하는
   루프다."* 검증자 서브에이전트는 *체크*지 *증명*이 아니다. **maker ≠ judge**는
   협상 불가([`team-roles.md`](../../../../harness/team-roles.md), agent-testing.md): 코드를 쓴 인스턴스가
   자기 숙제를 채점하지 않는다.
   **가드(게이팅 검증자) — "신뢰할 검증자라야 손을 뗀다"의 운영화:** 빌드 인스턴스와
   **별개의, 더 강한 티어(Opus) evaluator** 서브에이전트가 슬라이스를 적대적으로 판정한다 —
   (a) 슬라이스가 실제 acceptance를 충족하나, (b) 어떤 불변식(fabrication=0·IMMUTABLE-CORE)도
   약화하지 않았나, (c) 무관한 state를 안 깨뜨렸나. **이 판정이 커밋을 GATE한다**: PASS여야
   ⑤ 커밋; **FAIL이면 슬라이스를 롤백**(`git restore`/리셋)하고 backlog에 블로커 기록 —
   미검증 코드는 절대 통과 안 시킨다(fail-close). 결정적 게이트(test/check/eval)가 1차,
   이 적대적 judge가 2차. + 사람의 최종 확인(아래 3).
2. **Comprehension debt** — *"루프가 당신이 안 쓴 코드를 빨리 내놓을수록, 존재하는
   것과 당신이 실제로 이해하는 것 사이 격차가 커진다."* push 금지·draft-first(Tier1 로컬 커밋)가
   1차 가드 — 일이 origin에 안 닿으니 사람이 *머지 시점*에 검토한다.
   **가드(비동기 리뷰 표면 — NON-blocking, 루프는 절대 안 멈춘다):** comprehension debt는 "읽기
   쉬운 리뷰 표면"으로 처리하지 *루프 halt*로 처리하지 않는다(실천가는 무한 자율 + PR 비동기
   머지 — Cherny). (a) **매 fire가 이해 다이제스트를 append** — 4줄(무엇/왜/리뷰지점/리스크) —
   `docs/goals/loop-digest.md`에(아무때나 읽는 비동기 로그). (b) **N fire마다(기본 3) 막지 않고**
   PushNotification으로 "N개 쌓였어요"만 알리고 **계속 진행**한다 — 사람을 기다리며 스핀하지
   않는다. 읽을지/언제/머지는 사람의 비동기 선택; 루프는 멈추지 않는다.
3. **Cognitive surrender** — *"루프가 스스로 돌면 의견을 갖길 멈추고 그냥 받는 게
   유혹적이다."* 같은 시스템이라도 *판단을 갖고* 설계한 것과 *생각을 피하려고* 설계한
   것은 정반대 결과를 낸다. 가드 = 루프는 **후보를 surface**할 뿐, 품질을 자기판정하지
   않는다(§3-1 게이팅 검증자 + §3-2 비동기 리뷰 표면이 사람을 *루프 밖에서* 검토하게 한다). 사람은
   "go를 누르는 사람"이 아니라 "엔지니어"로 남는다.

## 3.5 자율성 티어 — 블로그 루프만큼 자율적으로, floor는 안 깨고

블로그 루프(Cherny: 월 259 PR)는 *세상에 행동*한다 — PR 열고, 티켓 갱신하고. Muse 루프가
"로컬 커밋 후 정지"라 덜 자율적이었던 건 사실. 더 자율적으로 만들되, 핵심을 본다: **블로그의
"PR 열기"는 자율 *행동*이 아니라 사람이 머지하는 *구조화된 초안*이다** — 그게 draft-first와
정확히 같다. 그래서 자율성을 **티어**로 올린다(floor를 깨지 않고):

- **Tier 1 — 로컬 커밋 (기본, 안전).** 슬라이스를 커밋만, push 없음. 진안이 diff를 읽고 머지.
- **Tier 2 — 격리 브랜치 + draft PR (명시 opt-in).** 루프가 *자기 브랜치*(예
  `loop/<theme>`)에 push하고 **draft PR**을 연다. 더 자율적(작업이 구조화돼 리뷰 큐에 쌓임)
  이지만 **사람이 머지**한다 = draft-first 유지. 진안의 등록-시 scoped consent로만 켜진다
  (outbound-safety.md의 "recorded scoped consent" 패턴). PR 본문 = §3-2 이해 다이제스트.

**하드 floor (어느 티어든 절대 불가):** main 자동 머지 · 자율 outbound(제3자에게 메일/메시지/
post — outbound-safety.md) · banking/송금 · `--no-verify`/게이트 우회 · 검증 실패 슬라이스 커밋.
"더 자율적"은 *초안을 더 멀리 미는 것*이지 *사람의 머지/전송을 없애는 것*이 아니다.

## 4. 루프를 띄우기 전 체크리스트 (loop-creator가 강제)

- [ ] **목적 한 줄** — 이 루프가 *무엇을* 더 강하게 만드나.
- [ ] **6 프리미티브 전부 배선** — §1 표의 빈 칸 = 위험점. 없으면 명시.
- [ ] **검증가능 정지조건** — §2. 결정적/judge-backed. 못 쓰면 띄우지 않는다.
- [ ] **게이팅 검증자** — 별개 강한-티어(Opus) 적대 judge가 커밋을 GATE, FAIL=롤백. §3-1.
- [ ] **이해 표면(비동기·non-blocking)** — 매 fire 다이제스트 + N fire마다 알림(막지 않음, 루프 무한). §3-2.
- [ ] **자율성 티어 선택** — Tier1(로컬 커밋, 기본) 또는 Tier2(브랜치+draft PR, opt-in). §3.5.
- [ ] **토큰/스텝 캡** — fire당 1슬라이스, retry 2–3 상한, 예산 캡. [`loop-budget.md`](../../../../harness/loop-budget.md).
- [ ] **모델 티어링** — 정형 작업 Sonnet; **계획/설계는 Fable 5(가능 시) 아니면 Opus 4.8(1M)**; judge는 강한 티어. §1.5.
- [ ] **State 파일** — 무엇이 Done·다음은 무엇. 디스크에([`backlog.md`](../../../../docs/goals/backlog.md)).
- [ ] **불변식 불가침** — fabrication=0 floor + IMMUTABLE-CORE는 절대 약화 안 함.
- [ ] **게이트가 최종 diff를 덮나** — write-back/digest 後 staged diff에 lint+byte-hygiene 재확인. §4.5-6.
- [ ] **decompose-on-defer** — 큰 항목 defer 시 loop-sized로 쪼개거나 "진안 필요" 명시. §4.5-7.
- [ ] **ratchet 지표** — digest에 스코어보드 델타 1줄, 알림은 추세. §4.5-8.
- [ ] **중단 방법** — cron id 기록, 어떻게 멈추나(CronDelete/cmux), 무인 비용 경계.

## 4.5 루프 품질 가드 (2026-06-12, 라이브 dogfood 평가에서)

2 fire를 돌려보니 *기계*는 잘 도는데 *산출*이 저야망이었다 — 검증 쉬운 마이크로 슬라이스만
고르고, 테스트는 선언-only, 토큰 대비 산출 비쌈, 실패 경로 미검증. 그 4개를 가드로 박는다.

1. **가치 우선 — "검증 쉬운 것" 아니라 "가치 높은 것".** ②에서 최상단 ◦를 고른다. 그게
   어려워서(live 의존 등) DEFER하면 **digest에 *왜* deferred인지 명시**한다 — 조용히 쉬운 걸로
   내려가지 않는다. 어려운 항목도 fixture/mock로 검증 가능하면 시도한다(회피 ≠ 불가능).
2. **다양성 — 같은 패턴 반복 금지.** 최근 N fire(기본 3)가 *같은 종류* 슬라이스(예: 매번
   `groundedArgs` 한 줄)였으면, 다음 fire는 **다른 KIND**를 고른다(새 도구 / 행동 수정 /
   버그픽스). 한 backlog 항목을 토큰 들여 N번 두드리지 않는다.
3. **행동 acceptance — 선언-only 테스트 금지.** 정지조건의 테스트는 **결과 상태(OUTCOME)**를
   채점해야 한다([`team-roles.md`](../../../../harness/team-roles.md) · agent-testing.md "grade
   outcomes not paths"). "툴이 X를 *선언*하나"만 보는 테스트는 **불충분** — fabricated 값이 실제
   *드롭되는* end-to-end 케이스를 요구한다. 게이팅 검증자(§3-1)는 선언-only 테스트를 행동
   요구에 대해 **FAIL** 처리한다.
4. **토큰 효율 — 배칭 + 리스크-티어.** (a) **사소한 동종 변경은 한 fire로 묶는다** — 남은
   actuator N개에 `groundedArgs`를 N fire(각 ~140k)로 하지 말고 한 슬라이스로 쓸어 한 번
   빌드·한 번 검증(고정 검증비를 N개에 분산). 자연히 슬라이스가 커져 1·3을 같이 고친다.
   (b) **검증 깊이는 리스크에 비례** — 정형 저위험 변경엔 가벼운 체크, 새 경로·불변식 접촉·큰
   변경에만 Opus 풀 추적. 단 검증자는 *항상* 돈다(끄지 않는다 — floor).
5. **실패 드릴 — 롤백 경로를 *증명*한다 (CADENCE).** 게이팅 검증자가 실제로 FAIL→`git restore`
   롤백→블로커 기록하는지, **고의로 나쁜 슬라이스 1건**(불변식 약화 / inert / 깨진 테스트)을
   주입해 드릴-검증한다. 1회로 끝이 아니라 **N fire(기본 10)마다 또는 스킬 버전 bump마다** 재드릴
   — 그리고 digest에 judge PASS-rate를 기록한다. *장기 all-PASS 구간은 "worker가 좋아진 것"과
   "judge가 물러진 것"을 구분 못 하므로*(maker=judge인 단일-모델 honest constraint, agent-testing.md),
   all-PASS가 길어지면 드릴이 자동 트리거.

다음 셋은 **2026-06-13 라이브 평가**(6 fire 실측 + Osmani/Cherny/Karpathy/Anthropic 2026-06 대조)에서 추가:

6. **게이트가 최종 diff를 덮는다 — "게이트 後 트리 무편집".** ④ 게이트 통과 *후* write-back/digest로
   트리를 또 편집하면 그 바이트는 미검증으로 커밋된다(fire-1이 NUL 바이트를 이 구멍으로 흘렸고
   fire-2가 잡음). 커밋 *직전 마지막 행동*으로 **staged diff에 lint + byte-hygiene 재확인**.
   Osmani: "ship code you *confirmed* works" — 슬라이스만이 아니라 커밋의 모든 바이트.
7. **DECOMPOSE-ON-DEFER — defer는 막다른 길이 아니라 파이프라인.** 큰 항목을 defer-with-reason만
   하면 고가치 항목이 영원히 제자리(작은-버그 편향 = Karpathy가 관찰한 RLHF "cagy and scared"의
   루프 버전). Anthropic harness의 planner는 *큰 의도를 게이트-검증 가능한 작은 리스트로 쪼개는*
   것이 일. defer 시 강한-티어 1스텝으로 loop-sized ◦로 decompose해 backlog 기록(또는 "진안 필요"
   명시); 같은 항목 2회 defer면 escalate. *쪼개지 않는 defer가 안티패턴, 셋으로 쪼개는 defer가 처방.*
8. **RATCHET 지표 — 루프가 *나아짐을 증명*해야 한다.** boolean 게이트 통과만으론 Muse가 측정 가능하게
   좋아졌는지 알 수 없다(Karpathy의 immutable number 부재). 매 fire digest에 스코어보드 델타 1줄,
   3-fire 알림은 누적 개수가 아니라 *추세*를 보고. self-eval 스코어보드가 이미 있으니 digest에 델타로
   노출만 하면 됨.

## 5. 출처 (2026-06, 1차 → 심화)

오리진 3인 (2026-06):

- **Peter Steinberger** (@steipete) — 발화점 X 포스트, "designing loops that
  prompt your agents" — [x.com/steipete/status/2063697162748260627](https://x.com/steipete/status/2063697162748260627)
- **Boris Cherny** (Anthropic, Claude Code) — "I don't prompt Claude anymore" —
  [Crypto Briefing 정리](https://cryptobriefing.com/anthropic-claude-code-flexible-ai-workflows/) ·
  [officechai](https://officechai.com/ai/i-now-just-write-loops-to-prompt-claude-code-claude-code-creator-boris-cherny/)
- **Addy Osmani** (Google) — 캐노니컬 명명 글 —
  [Loop Engineering](https://addyosmani.com/blog/loop-engineering/) ·
  [Self-Improving Coding Agents](https://addyosmani.com/blog/self-improving-agents/) ·
  [Plan-Act-Observe 용어집](https://addyosmani.com/agentic-engineering/plan-act-observe/)

심화 (회사/실무자, 2026-06):

- **Langfuse** — [AI is eating the AI engineering loop](https://langfuse.com/blog/2026-06-09-ai-is-eating-ai-engineering) (관측/평가)
- **Cobus Greyling** — [Loop Engineering Playbook](https://cobusgreyling.medium.com/loop-engineering-playbook-4460e01e88d8) ·
  [패턴 레포](https://github.com/cobusgreyling/loop-engineering)
- **Data Science Dojo** — [From ReAct to Loop Engineering (2026 Guide)](https://datasciencedojo.com/blog/agentic-loops-explained-from-react-to-loop-engineering-2026-guide/) (계보)
- **Filip Verloy** — [Loop Engineering & the new security paradigm](https://medium.com/@filipv_74515/from-prompt-engineering-to-loop-engineering-why-the-agent-era-demands-a-new-security-paradigm-816385040e3d) (무인 루프 = 새 공격면 → §3 가드와 연결)

본 harness의 인접 계약: [`dev-loop.md`](../../../../harness/dev-loop.md)(슬라이스 선택·실행),
[`team-roles.md`](../../../../harness/team-roles.md)(maker≠judge), [`verification-and-guardrails.md`](../../../../harness/verification-and-guardrails.md)(게이트),
[`loop-budget.md`](../../../../harness/loop-budget.md)(예산), [`session-persistence.md`](../../../../harness/session-persistence.md)(state).
