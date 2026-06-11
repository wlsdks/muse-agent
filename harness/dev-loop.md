---
title: 개발 루프 — 매일 Muse를 더 강하게 만드는 방법 (Development Loop)
audience: [AI 에이전트, 개발자]
purpose: "다음에 뭘 개발하지"를 매번 즉흥적으로 정하는 비효율을 없애고, 공개된 에이전트-개발 방법론에 근거한 하나의 루프로 고정한다. `improve-muse` 스킬이 활성화하는 본체.
format: harness layer (vendor-neutral)
updated: 2026-06-08
---

# 개발 루프 — Development Loop

> **이 파일은 "무엇을·어떻게 개발하는가"의 계약입니다.** [`AGENTS.md`](AGENTS.md)가
> *역할·핸드오프·게이트*(한 슬라이스를 어떻게 실행하나)라면, 이 파일은 *그 슬라이스를
> 어떻게 고르고, 검증하고, 학습을 누적하나*입니다. `.claude/skills/improve-muse`가
> 0–2단계(ORIENT+FIND)를 돌려 다음 슬라이스를 *추천*하고 — "할 게 없다"는 금지 출력 —
> 선택된 슬라이스가 3–7단계를 따릅니다. 매번 "뭘 만들지" 프롬프트를 쓰지 않게.

## 0. 이 루프가 고치는 비효율 (왜 만들었나)

증상(진안, 2026-06-08): *"내가 비효율적으로 개발하고 있다는 느낌. 매번 뭘 개발할지
프롬프트로 알아봐야 한다."* 근본 원인 = **MEASURE 절반은 강한데 ANALYZE+COMPOUND
절반이 없다** → 매 세션이 오리엔테이션 비용을 처음부터 다시 낸다(treadmill). 두 얼굴:

1. **방향이 누적되지 않는다.** 단일 진입점이 없고, 영속 backlog가 삭제돼 있어 "다음에 뭘"을
   매 슬라이스마다 비싼 scout 서브에이전트로 재발견하고 버린다. → 고친다: [`backlog.md`](../docs/goals/backlog.md)를
   한 번 쓰면 다음 fire가 먼저 읽는다.
2. **데이터가 슬라이스를 안 고른다.** `.muse/runs/`에 트레이스가 쌓이는데 아무도 안 읽고,
   "느낌상 가치 높은 것"으로 고른다. → 고친다(점진적): 결과 로깅 계측 → 실패 클러스터링이
   슬라이스를 고르게. (지금은 라벨이 없으니 backlog가 우선; [`backlog.md`](../docs/goals/backlog.md) 참고.)

## 1. 원칙 (공개 방법론 전반의 합의 — 따를 것)

모두 1차 출처로 교차 검증됨(§4). 충돌 시 [`CLAUDE.md`](../CLAUDE.md) + `.claude/rules/*.md`가 우선.

1. **데이터가 슬라이스를 고른다, 느낌이 아니라.** 자기 트레이스를 읽고 → 실패를 분류하고 →
   빈도로 순위를 매겨 Pareto가 일을 고르게. AI 개발에서 가장 ROI 높은 활동(Husain; NurtureBoss는
   3개 모드 고쳐 실패 60%+ 제거). 라벨이 충분히 쌓이기 전엔 backlog 최상단 항목으로 대체.
2. **고정된 작은 모델에서는 *하네스*가 레버다 — 모델 크기가 아니라.** 에이전트=LLM이 도구를
   루프로 도는 것; 역량=도구×플래너(Weng·Willison·Huyen·Ng; Ng의 "GPT-3.5 루프 > GPT-4 zero-shot").
   약한 모델일수록 하네스 품질에 성능이 크게 흔들린다(METR ~23.8pt). 단, 첫 액션을 맞혀라 —
   8B는 3+스텝 추론에서 일관성이 무너진다([`tool-calling.md`](../.claude/rules/tool-calling.md)).
3. **뺄셈으로 개선한다.** 도구를 ablate해 기여 없는 건 제거(Huyen); CLAUDE.md 100줄 상한;
   subtractive correction-decay. 계약·스킬·backlog는 늘리기만 하면 8B가 무시하는 소음이 된다 —
   한 줄 추가하면 한 줄 쳐낸다.
4. **안쪽 루프는 단일 스레드 기본. 서브에이전트는 *병렬·읽기 위주·독립* 탐색에만.** 긴밀히
   결합된 build/fix 결정은 한 에이전트에 둔다(Cognition "Don't Build Multi-Agents"; Anthropic 멀티에이전트는
   +90%지만 ~15× 토큰, 병렬 가능한 일에만). gap-finding 같은 폭넓은 조사가 서브에이전트의 올바른 쓰임.
   컨텍스트 공학(write/select/compress/isolate)·context rot 주의.
5. **검증하고 나서 주장한다 — fail-closed, maker≠judge, pass^k.** 터미널 상태/결과를 채점;
   이진 판정(temp 0); green 배터리 없으면 done 아님; evaluator는 worker와 다른 인스턴스 +
   eval:judge 메타평가로 같은-모델 판정을 보정. "tested"는 절대 tsc-only가 아니다.
6. **학습을 write-back으로 누적한다 — 모두가 빼먹고, treadmill을 flywheel로 바꾸는 그 단계.**
   실패는 영구 golden case로, 반복 교정은 rule 한 줄로, 고른/버린 방향+출처 URL은 backlog로.
   Voyager의 스킬 라이브러리·Generative-Agents의 memory+reflection이 이 누적의 학술 뿌리.
   누구도 신뢰할 자동 자기개선은 없으니([[obra/superpowers는 수동 의식]]), write-back은 *완료 게이트*다.
7. **load-bearing 조각은 코드로 소유한다 — 프레임워크 마법이나 프롬프트 부탁이 아니라**(12-Factor).
   정책·게이트·surface→battery 맵은 버전관리에 둔다(머릿속이 아니라).

## 2. 정전(正典) 지도 — 기법 → 출처 → Muse 상태

개발-루프 기법과 평가 기법. HAVE=있음 / PARTIAL=부분 / MISSING=없음 / N-A=무관.

| 기법 | dev/eval | 출처 | Muse |
|---|---|---|---|
| ReAct (추론↔행동 교차) | dev | arXiv 2210.03629 | HAVE (plan-execute/model-loop) |
| Reflexion (피드백→언어적 자기강화) | dev | 2303.11366 | HAVE (correction-decay) |
| Self-Refine (생성→비평→수정) | dev | 2303.17651 | HAVE (ask --repair + judge) |
| Voyager (성장하는 callable 스킬 라이브러리) | dev | 2305.16291 | HAVE (playbook/skills) |
| Generative Agents (memory stream+reflection) | dev | 2304.03442 | HAVE (episodic+reflection) |
| Self-RAG / CRAG (신뢰 게이트 retrieval) | dev | 2310.11511 / 2401.15884 | HAVE (grounding gate) |
| 에러분석 플라이휠 (look at your data) | dev | Husain · Yan · Google AgentOps | **PARTIAL — fuel 없음(트레이스 라벨링 필요)** |
| pass^k 신뢰도 | eval | τ-bench 2406.12045 | HAVE (MUSE_EVAL_REPEAT) |
| 이진 LLM-judge + 메타평가 | eval | Husain · Google rubric_v1 | HAVE (eval:judge) |
| trajectory vs final 분리 + match 모드 | eval | Google ADK criteria | **MISSING (backlog)** |
| 문장단위 groundedness (hallucinations_v1) | eval | Google ADK | **MISSING (backlog)** |
| 비용통제 평가 (단순 베이스라인 먼저) | eval | "AI Agents That Matter" 2407.01502 | PARTIAL |

> 핵심 읽기: **개발-루프 기법은 거의 다 HAVE다.** 비어 있는 곳은 *평가 정밀화*와 *에러분석
> 플라이휠의 연료*다. 그래서 다음 일은 "또 기법 추가"가 아니라 "측정과 누적의 구멍 메우기".

## 3. THE LOOP — 매일 한 번의 fire

각 fire = 검증된 슬라이스 하나. 비용 낮은 단계부터, fail-closed.
`improve-muse` 스킬은 0–2단계를 실행해 후보를 랭킹·추천하고 거기서 멈춘다(진안
또는 standing 자율 지시가 pick); 3–7단계는 pick 이후의 실행 계약이다.

0. **PRE-FLIGHT** — Ollama 가동 확인(`curl -s localhost:11434/api/tags`); `git fetch`로
   동시 auto-push 루프와 reconcile; 만진 의존 패키지 rebuild(stale dist가 버그로 위장하는 세금 제거).
1. **ORIENT (회귀 우선)** — `pnpm self-eval`. 이전에 통과하던 게이트가 떨어졌으면 *그걸* 고치는 게
   이번 fire의 전부 — 여기서 멈추고 고친다.
2. **FIND WORK (자율 — 점진적 강등)** — (a) 회귀 있으면 그게 일. (b) 없으면 [`backlog.md`](../docs/goals/backlog.md)
   최상단 ★ OPEN 항목 — 단 ★ OPEN 중 다른 항목의 선행조건(PREREQUISITE)으로 선언된 것이 그게 막는
   기능보다 우선. (c) backlog가 비었으면 EXPANSION-PLAYBOOK의 gap-finding(scout 서브에이전트:
   현재상태+공개레퍼런스+격차합성)으로 후보를 *생성*하고 backlog에 적어 누적. (d) 라벨된 실패가
   ~20-30개 쌓이면 에러분석이 (b)보다 우선. **사람에게 "뭘 만들까" 안 묻는다 — 데이터/backlog가 고른다.**
3. **PLAN** — WHAT+WHY+강화할 게이트를 [`handoff-template.md`](handoff-template.md)에 한 줄 계약으로.
   사소하면(오타·한 줄) 생략하고 5로 단락(skill 자가 게이트).
4. **BUILD** — 한 수직 슬라이스, 최소 범위, 결정론 코드(프롬프트 아님). 프롬프트/스키마/제어흐름을
   소유; 게이트 하나를 강화하거나 verb_noun 도구 하나 추가. 새 프레임워크 추상화 금지.
5. **VERIFY (fail-closed)** — `node scripts/pick-evals.mjs`가 diff→정확한 eval/smoke 부분집합을
   매핑해 출력(외워서가 아니라 코드; grounding/safety엔 MUSE_EVAL_REPEAT=3 자동) + 불변식
   (fabrication=0 *실트레이스에도*, lint 0/0, 변경 패키지 test, 교차패키지면 `pnpm check`).
   grounding/safety는 pass^k k≥3. 독립 evaluator = harness-evaluator 서브에이전트(write 도구 없음),
   eval:judge 메타평가로 보정. green 아니면 done 아님.
6. **WRITE-BACK (완료 게이트 — 이거 없이 done 선언 불가)** — (a) 고친 실패를 STABLE-3/3 golden case로;
   (b) 진안의 반복 교정을 `.claude/rules/*.md` 한 줄로(after-correction); (c) 고른+버린 방향+출처를
   [`backlog.md`](../docs/goals/backlog.md)에, 영속 사실을 MEMORY.md에; (d) before→after를 self-eval 스코어보드에.
   set이 늘면 stale 한 줄 prune.
7. **COMMIT** — Conventional Commit 하나(커밋만; push는 진안 명시 승인 시에만) + 짧은 한국어 보고
   (무엇/왜+URL/before→after/잔여 리스크). 다음 fire의 ORIENT는 더 두꺼운 rule·golden suite·backlog를
   읽으니 *엄밀히 더 싸다*.

## 4. 안티패턴 (이 루프가 스스로를 망치는 길 — 막을 것)

- **사소한 일에 의식(ceremony).** 한 줄 수정에 orient→analyze→spec→handoff는 순수 오버헤드.
  → 스킬이 자가 게이트: 사소하면 build+verify+commit로 단락. 안 그러면 우회당하고 스킬은 죽는다.
- **얇은 데이터로 에러분석 연극.** 실패 4개를 "택소노미"로 만드는 건 가짜 엄밀. ~20-30개 미만이면
  손으로 읽고 명백한 것 하나 고치고 backlog로 폴백. NurtureBoss 수치를 법칙처럼 베끼지 말 것.
- **프라이버시 누출 (가장 Muse적인 리스크).** 트레이스 원문을 클라우드 모델에 보내거나 taxonomy에
  그대로 커밋하면 정체성 위반("다 털어놔도 된다"+MUSE_LOCAL_ONLY). → 클러스터링은 LOCAL gemma4만,
  taxonomy는 redacted 라벨+카운트만. 코드로 강제(프롬프트 아님).
- **maker=judge 붕괴.** 단일 로컬 모델이라 evaluator·judge가 worker를 고무도장 찍을 수 있다(TNR<25%).
  → 결정론 스코어러 먼저; judge는 tie-breaker + eval:judge 메타평가 통과 후에만 신뢰. 같은-모델 judge를
  fabrication-critical 주장의 유일 게이트로 두지 말 것.
- **golden suite 과적합.** write-back이 back-catalog만 추가하면 suite가 굳어 새 drift를 못 잡는다.
  → 매 fire 신선한 트레이스 재샘플; suite는 *분포*로 성장.
- **계약/스킬 비대화.** 누적이 8B가 감당할 한계를 넘으면 역효과. → 한 줄 추가 시 한 줄 prune;
  SKILL.md가 everything-doc로 자라면 progressive disclosure가 무너진다.
- **하네스 무한 연마.** scaffold 이득은 일찍 compound하고 곧 saturate(METR은 이미 elicited된
  에이전트에 +8pp 비유의). 루프가 타이트해지면 메타 엔지니어링을 멈추고 capability로 복귀.

## 5. 정직한 한계 (2026-06-08 will-it-work 적대적 리뷰)

이 루프가 *무엇을 못 하는지* — 6-경로 리뷰가 코드로 확인한 천장. 무시하면 깨진다.

- **네트워크/데이터 절.** `MUSE_LOCAL_ONLY`는 **LLM/음성 egress만** 막는다 — 공개 eval 데이터셋
  내려받기는 허용. 단 `apps/cli/scripts/fixtures/`에 vendoring + checksum 고정 + 커밋해 오프라인
  재현 가능하게. (이 절이 없으면 에이전트가 스킬이 세운 게이트에 *스스로* 막혀 멈춘다.)
- **단일 모델에선 maker=judge — `eval:judge`는 advisory.** 같은 gemma가 같은 gemma를 toy
  fixture로 채점하니 이번 슬라이스의 진위에 신호가 거의 없다. fabrication-critical 주장은
  **결정론 스코어러 우선**, 아니면 **opus harness-evaluator(별도의 더 강한 모델 세션, write 도구 제거)**.
  이게 환원 불가능한 "더 강한 모델/사람이 필요한 지점"이다 — 고정 12B는 자기가 막 만든 grounding
  주장을 self-certify 못 한다.
- **WRITE-BACK은 이제 기계적이다.** `scripts/guard-writeback.mjs`(commit-msg 훅)가 non-trivial
  `feat`/`fix`에 test/golden-case/backlog 갱신 중 하나를 스테이지하도록 강제(escape `[writeback: n/a]`).
  prose 게이트가 아니라 코드. 그래도 *내용*(좋은 golden case인가)은 사람/리뷰의 판단.
- **자율은 시드 길이만큼만.** write-back은 *소비한* 항목의 출처를 적을 뿐 새 actionable 일을
  만들지 않는다("한 줄 추가 시 한 줄 prune"이 성장을 캡). 영속 refill은 error-analysis인데 그건
  트레이스 결과 로깅에 막혀 있고, 그 연료는 *진안이 Muse를 쓰는 데서* 쌓이지 dev fire에서가 아니다.
  → ★ OPEN이 마르면 refill fire(gap-scout 또는 사람 방향)가 그 자체로 일. 자율을 "무한 자기개선"으로
  과대평가하지 말 것 — 이건 *검증된 슬라이스 실행을 싸게 + 누적되게* 만드는 도구지, 감독 없는 자기진화가 아니다.

## 6. 출처 (1차, 검증됨)

- Anthropic: [Building effective agents](https://www.anthropic.com/research/building-effective-agents) · [Multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) · [Writing tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents)
- OpenAI: [A practical guide to building agents](https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf) · Google: [ADK eval criteria](https://google.github.io/adk-docs/evaluate/) · [Agents Companion 백서](https://www.kaggle.com/whitepaper-agent-companion)
- 12-Factor Agents (Dex Horthy/HumanLayer): https://github.com/humanlayer/12-factor-agents
- Eval-driven: Hamel Husain [Your AI product needs evals](https://hamel.dev/blog/posts/evals/) · [LLM-as-judge](https://hamel.dev/blog/posts/llm-judge/) · Eugene Yan [LLM-evaluators](https://eugeneyan.com/writing/llm-evaluators/) · Shreya Shankar (who-validates-the-validators)
- 실무자: Lilian Weng [LLM Powered Autonomous Agents](https://lilianweng.github.io/posts/2023-06-23-agent/) · Chip Huyen [Agents](https://huyenchip.com/2025/01/07/agents.html) · Simon Willison (agent 정의) · Andrew Ng (4 agentic patterns) · Jason Liu (RAG flywheel)
- 멀티에이전트/컨텍스트: Cognition [Don't Build Multi-Agents](https://cognition.ai/blog/dont-build-multi-agents) · LangChain (context engineering) · Chroma [Context Rot](https://research.trychroma.com/context-rot)
- 하네스: SWE-agent/ACI (2405.15793) · METR task-harness · 논문 canon: ReAct 2210.03629 · Reflexion 2303.11366 · Self-Refine 2303.17651 · Voyager 2305.16291 · Generative Agents 2304.03442 · τ-bench 2406.12045 · "AI Agents That Matter" 2407.01502
