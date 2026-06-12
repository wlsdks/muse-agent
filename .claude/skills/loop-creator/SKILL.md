---
name: loop-creator
version: 1.11.2
description: Use when 진안 wants to start (register) an autonomous improvement loop on the Muse repo — "루프 돌려줘", "loop 등록", "X를 계속 강화하는 루프", or just a theme to iterate on. Generates a principle-compliant recurring loop prompt from its bundled loop-engineering.md contract AND registers the cron itself, then reports the prompt + cron id + how to stop. The autonomous successor to hand-written ad-hoc loop prompts.
---

> **Versioning.** This skill carries a `version` (above). On any change to the
> skill or its `references/loop-engineering.md` contract, **bump it** (patch =
> wording, minor = new guard/behavior) and add a `CHANGELOG.md` entry. Stamp the
> current version into each `loop-digest.md` fire entry (`(skill vX.Y.Z)`) so that
> after many loops we can correlate fire OUTCOMES ↔ skill version and improve.
> History: [`CHANGELOG.md`](CHANGELOG.md).

# loop-creator — 원칙을 지키는 자율 루프를 생성하고 등록한다

## Overview

한 번 호출하면 끝까지 한다: **테마/목적을 받아 → 루프-엔지니어링 계약을 채워 →
재귀 루프 프롬프트를 생성 → cron으로 등록 → 멈추는 법까지 보고.** 진안이 루프를
자주 돌리므로, 매번 손으로 ad-hoc 프롬프트를 짜지 않게 이 스킬이 대신한다.

계약 본체는 [`loop-engineering.md`](references/loop-engineering.md) —
6 프리미티브 · 검증가능 정지조건 · maker≠judge · 3대 실패모드 가드. 이 스킬은 그
계약을 *적용*하는 생성기다. 단일 슬라이스 빌드는 하지 않는다(그건 루프가 돌며 함).

## 결합 (정직하게 — "스킬만 빼가도 되나?")

- **고유 계약은 번들됨.** loop-engineering 원칙은 단일 소비자라 `references/`에 함께 들어
  있다 — 스킬 폴더가 자기 계약을 들고 다닌다.
- **단, 이건 Muse-native 스킬이다**(improve-muse처럼). 생성하는 루프가 Muse의 실제 seam을
  가리킨다: `backlog.md` · `self-eval` · `eval:*` · 진짜 공유 harness 레이어
  ([`dev-loop.md`](../../../harness/dev-loop.md) — improve-muse도 씀 · `loop-budget.md` ·
  `team-roles.md`). 그래서 *폴더만* 다른 레포에 떨궈도 그대로 돌지 않는다 — 그 배선을
  바꿔야 한다. **완전 이식**(Muse 배선 파라미터화)은 별도 작업. 지금 범위 = "고유 계약은
  스킬과 함께, 공유 harness 레이어는 참조".

## 입력 해석

- **테마/목적이 있으면** (예: "브라우저 강화", "agent-core 하드닝") → 그걸 목적으로 채운다.
- **간격이 있으면** (예: "20분") → 그 간격. 없으면 기본 **20m**(세션 루프).
- **테마가 없으면** → 스킬의 **1번 작업이 곧 "무엇을 할지 알아내기"**다(§1 DECIDE THE WORK):
  backlog가 명확하면 거기서, 얇거나/없으면 **gap-scout를 즉시 돌려 발굴**해 정한다.
  "할 게 없다"는 금지 — 모르면 멈추는 게 아니라 스카웃한다.

- **자율성 티어** — 기본 **Tier1**(로컬 커밋, push 없음). "더 자율적으로"/"PR로"/"브랜치
  파서"/"무인으로 머지 전까지" 같은 신호가 있으면 **Tier2**(브랜치+draft PR, 사람이 머지)로,
  단 그건 push 권한 부여라 등록 시 진안의 명시 opt-in을 1회 확인한다(§3.5).

요지: 진안이 한 줄만 던져도 나머지는 스스로 채운다. 모호한 포크가 있을 때만 1개 질문.

## 파이프라인 (생성, 그다음 등록)

### 1. DECIDE THE WORK — 무엇을 할지 *결정*한다 (모르면 *알아낸다*)

이 스킬의 **1번 작업은 "이번 루프가 무엇을 할지 결정"하는 것**이다 — backlog를 *읽기만* 하는
게 아니라, 모르면 *능동적으로 알아낸다*. 결정 순서(위에서 멈추는 곳이 답):

1. **기준선 먼저.** `pnpm self-eval` non-zero면 **등록하지 않고** 회귀를 보고한다(아래 상세 불릿)
   — 깨진 기준선 위엔 루프를 안 띄운다. (루프가 *돌 때* 회귀를 만나면 그건 그 fire의 일.)
2. **테마가 정해졌고 backlog에 그 항목이 있으면** → 가치 우선 top ◦(§2). 끝.
3. **테마가 없거나 / backlog가 얇거나(≤2) / stale / 부재면 → 지금 알아낸다** (gap-scout, 순서대로):
   - **(a) 신호 먼저** — `node scripts/scout-signals.mjs`: `.muse/runs/`의 *실패* 트레이스
     (ungrounded/failed)를 빈도순 클러스터링 → 진짜 반복 실패가 일감(2026 주류 triage 패턴).
   - **(b) 신호 깨끗하면** → 코드 확장 gap-scout(EXPANSION-PLAYBOOK) — 새 역량/하드닝 발굴.
   - **(c) 둘 다 마르면** → **진안에게 정직히 보고하고 멈춘다**(가짜 일감 금지).
   발굴 결과를 **backlog.md에 써넣고** 그걸로 테마/슬라이스를 정한다. **"할 게 없다"는 금지** —
   모르면 멈추는 게 아니라 *스카웃*, 그래도 없으면 *멈추되 솔직히*(억지로 지어내지 않음).

보조 입력: [`loop-engineering.md`](references/loop-engineering.md) §1 표·§4 체크리스트,
`git log --oneline -5`(최근 무엇), 동시 자동-push 루프 여부.
**backlog.md는 스킬이 *읽고/스카웃으로 채우는* repo 아티팩트지(dev loop·improve-muse·gap-scout가
유지) 매번 새로 만드는 건 아니다** — 부재 시 최소 스켈레톤(`# Muse dev backlog`)을 만들고 위 3을 탄다.
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
| **게이팅 검증자** | 빌드와 별개 **강한-티어(Opus) 적대 judge**가 슬라이스를 판정 → **PASS여야 ⑤ 커밋, FAIL이면 롤백**(`git restore`)+블로커 기록. 결정적 게이트(test/check/eval) 1차, judge 2차. ([`loop-engineering.md`](references/loop-engineering.md) §3-1) |
| **이해 표면 (비동기·non-blocking)** | 매 fire가 `docs/goals/loop-digest.md`에 4줄 append(아무때나 읽는 비동기 리뷰 로그) + **N fire(기본 3)마다 막지 않고 PushNotification 알림만 + 계속 진행** — 루프는 절대 안 멈춘다. 검토/머지는 사람의 비동기 선택. §3-2 |
| **자율성 티어** | **Tier1**(로컬 커밋, push 없음 — 기본) 또는 **Tier2**(`loop/<theme>` 브랜치 push + draft PR, 사람이 머지 — 명시 opt-in). 하드 floor: main 자동머지·자율 outbound·banking·`--no-verify` 절대 불가. §3.5 |
| 토큰/스텝 캡 | fire당 1슬라이스, retry 2–3 상한, 예산 캡([`loop-budget.md`](../../../harness/loop-budget.md)) |
| **모델 티어링** | 정형 빌드/검색/문서 → Sonnet(`model:"sonnet"`); **계획·설계·모호함·적대적 검증 → Fable 5(`model:"fable"`)를 *가능할 때*, 불가하면 Opus 4.8(1M)**. 개발은 Opus/Sonnet 무관. maker=Sonnet / **judge=강한 티어(Fable5 가능 시, 아니면 Opus)**. 오케스트레이터는 얇게. (Muse 런타임 모델 gemma4는 고정 — [`loop-engineering.md`](references/loop-engineering.md) §1.5) |
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
② <테마>의 **최상단 ◦(가치 우선, "검증 쉬운 것" 아님)**. 최근 3 fire가 같은 KIND였으면 다른 KIND를 고른다(다양성). 비면 gap-scout 리필.
   **논문-근거 우선(가능할 때, 테마-스코프)**: 강한-티어(Fable5) scout가 **WebSearch로 검증된 2024-2026 AI-agent 논문**(내부 프로세스·자기개선·검증/grounding·메모리·오케스트레이션)을 확인하고 *적용가능 메커니즘 + arXiv ID*로 슬라이스를 스펙 → verify-then-apply. 단순 correctness 버그픽스보다 논문-기반 capability/방법 적용을 우선 — **단 이는 capability/method/research 테마에 한한다; hardening/correctness/security 테마에선 그 보안·correctness 작업 자체가 곧 가치이므로 "단순 버그픽스"로 깎아 deprioritize하지 않는다**(예: 프로토타입 오염·계약 위반 수정은 하드닝 루프의 최고 산출). floor를 깨는 회귀면 예외적으로 먼저. 적용 시 소스/다이제스트/커밋에 arXiv ID 인용.
   **공개/오픈 논문만**(진안 지시): arXiv preprint·오픈액세스 등 *누구나 자유롭게 참조·사용 가능한* 논문에 한정. published 방법/알고리즘을 **적용**하는 것이지 proprietary/비공개 자료나 코드를 복사하는 게 아님 — 출처(arXiv ID) 명시 + 자체 재구현.
   **DECOMPOSE-ON-DEFER**: 너무 커서(>1 fire) defer하면 *조용히 쉬운 걸로 안 내려가고* — 강한-티어(Fable5/Opus) 1스텝으로 그 항목을 loop-sized ◦ 슬라이스들로 **쪼개 backlog에 기록**(Anthropic planner 패턴), 또는 "loop-decompose 불가, 진안 필요"를 명시. 같은 항목이 2회 defer되면 3-fire 알림에 escalate(defer가 일방 ratchet이 되지 않게).
③ harness/dev-loop.md §3에 따라 검증가능 슬라이스를 TDD-first로. **행동 acceptance: 결과 상태(OUTCOME)를 채점 — 선언/config-only 테스트 금지(fabricated 값이 실제 드롭/동작하는 end-to-end 케이스).** 사소한 동종 변경(예: 남은 actuator들)은 **한 슬라이스로 배칭**(토큰 절약). 새 도구는 tool-calling.md + eval:tools 골든.
④ 결정적 검증(정지조건): **먼저 만진 패키지를 빌드**(pnpm --filter @muse/<pkg> build) → 가장 좁은 테스트 → pnpm check → 관련 eval(<해당 eval>) → pnpm lint. **pnpm check가 실패하면 첫 진단은 clean-rebuild 재실행**(cross-package 실패는 대개 동시 루프發 stale-dist — [[project_stale_dist_from_loop]]; 한 번 재실행 後에도 빨가면 진짜 회귀).
④b 게이팅 검증자: 별개 강한-티어 서브에이전트가 적대 판정(acceptance가 *행동*을 검증하나 — **선언-only면 FAIL**? 불변식 약화 없음? 무관 state 안 깸?). 깊이는 리스크에 비례(정형 저위험은 가볍게, 새 경로/불변식 접촉은 풀 추적)하되 항상 돈다. PASS여야 ⑤로; FAIL이면 git restore 롤백+backlog 블로커 후 멈춤.
⑤ write-back(테스트/eval/backlog Done) 포함 커밋. **게이트 後 트리 무편집 규칙**: write-back/digest 편집은 ④ 게이트를 다시 통과해야 한다 — 커밋 *직전 마지막 행동*으로 **staged diff에 lint + byte-hygiene 재확인**(게이트 後 트리를 또 건드렸으니; fire-1이 NUL 바이트를 이 구멍으로 흘렸음). **자율성: <Tier1=로컬 커밋, push 금지 / Tier2=loop/<theme> 브랜치 push+draft PR, 사람이 머지>.**
⑤b 이해 다이제스트: docs/goals/loop-digest.md에 4줄 append(무엇/왜/리뷰지점/리스크) + **RATCHET 1줄: 이번 fire의 스코어보드 델타**(예: eval:tools 0.91→0.93 · testFiles 888→889 · fabrication 0 유지 — 변화 없으면 "지표 무변동, 하드닝"). 3 fire마다 막지 않고 PushNotification — "N개 쌓였어요"가 아니라 **추세**("eval X, 커버리지 Y, 회귀 0") 알림 + **계속 진행**(루프는 절대 안 멈춤; 검토/머지는 진안의 비동기 선택).
모델 티어링(토큰 절약): 정형 빌드/검색은 Sonnet 서브에이전트(Agent/Workflow model:"sonnet")로
위임하고, 계획/설계/모호한 포크/④b 적대 검증은 **Fable 5(가능 시) 아니면 Opus 4.8(1M)**로; 개발은 Sonnet/Opus 무관; judge는 worker보다 강한 티어(Fable5 가능 시, 아니면 Opus).
한 fire에 슬라이스 하나; 막히면 backlog에 블로커 기록 후 멈춤.
예산 캡: harness/loop-budget.md 한도 준수 — 토큰/비용이 캡에 닿으면 fire 중단 후 보고.
grounding floor(fabrication=0)·IMMUTABLE-CORE 절대 약화 금지. 하드 floor: main 자동머지·자율 outbound·banking·--no-verify 절대 불가.
```

테마별로 ④의 eval과 ②의 backlog 섹션을 정확히 바꿔 넣는다(브라우저 루프면 eval:browser-agent 등).

### 3.5 자가검증 (등록 전, 필수 — "신뢰할 검증자라야 손을 뗀다")

등록은 행동이다. 등록 *전에* 생성물을 §4 체크리스트에 대고 스스로 PASS/FAIL한다:

- [ ] §4의 **11항목**이 전부 **채워졌거나 "N/A — 이유"로 명시**됐나? 빈 칸이 있으면 FAIL.
- [ ] 정지조건이 **실제로 실행 가능한 명령**인가 — `<해당 eval>` 자리에 실재하는
      `pnpm <script>`(package.json에 있는)가 들어갔나? placeholder가 안 치환됐거나
      "느낌상 됐다"면 FAIL — 띄우지 않고 블로커 보고.
- [ ] 프롬프트의 ④ eval이 테마와 맞나(브라우저인데 eval:browser-agent 빠지지 않았나)?
- [ ] push 금지·fabrication=0·IMMUTABLE-CORE·**예산 캡** 문구가 프롬프트에 살아있나?
- [ ] 모델 티어링 라인이 테마에 맞나(정형 위주면 Sonnet 위임이 실제로 토큰을 아끼나)?
- [ ] **게이팅 검증자**가 프롬프트에 살아있나 — ④b Opus 적대 judge가 커밋을 GATE, FAIL=롤백?
- [ ] **이해 표면**이 살아있나 — ⑤b 다이제스트 append + N fire마다 알림(막지 않음, 루프 무한)?
- [ ] **자율성 티어가 명시**됐나 — Tier1/Tier2 중 무엇인지 ⑤에 박혔고, Tier2면 진안 opt-in 받았나?
      하드 floor(main 자동머지·자율 outbound·banking·--no-verify) 금지 문구가 살아있나?
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
3.5 **자가검증** — 11항목 PASS(정지조건 `eval:browser-agent` 실재 확인, 같은 테마 cron 없음 `CronList`, 게이팅 검증자·이해 체크포인트·자율성 티어(Tier1) 박힘), push-금지·floor·예산 문구 살아있음 → 통과.
4. **등록** — `Skill(skill:"loop", args:"20m <생성한 프롬프트>")` → 세션 cron id 반환 + 첫 fire 즉시 실행.
5. **보고** — 프롬프트 전문 + cron id(세션) + "각 fire: browser ◦ 1슬라이스 TDD→check→eval:browser-agent→커밋" + 첫 fire 결과 + `CronDelete <id>`로 중단 + fire당 1슬라이스 비용 경계.

## 계보·출처 (왜 이 모양인가)

이 스킬의 원칙은 2026-06 "Loop Engineering" 합의에서 왔다 — **Peter Steinberger**
("designing loops that prompt your agents"), **Boris Cherny**(Anthropic, "I don't
prompt Claude anymore"), **Addy Osmani**(명명·정리). 전체 출처·심화 글은
[`loop-engineering.md`](references/loop-engineering.md) §5. 토큰 효율
(모델 티어링)은 그 합의가 "Agent Orchestrator"의 핵심 craft로 꼽은 것과 일치.

## 멈추기

등록한 cron의 id를 §5에서 보고했다. 진안이 "루프 그만"이라 하면 `CronList`로 찾아
`CronDelete <id>`. 별도 cmux 백그라운드 루프는 cmux에서 중단([[feedback_no_loop_collaborate]]).
