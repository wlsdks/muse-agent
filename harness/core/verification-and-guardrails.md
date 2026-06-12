---
title: 검증 게이트 & 가드레일 (Verification & Guardrails)
audience: [개발자, AI 에이전트]
purpose: 하네스의 평가자·게이트를 실제로 신뢰할 수 있게 — 채점 루브릭, 입출력 가드레일, 게이트 운용 규칙
status: draft
updated: 2026-06-13
sources_basis: [LLM-as-a-Judge practical guide, OpenAI Agents SDK guardrails, Anthropic building-effective-agents, Cognition don't-build-multi-agents]
related: [team-roles.md, handoff-template.md, ../host/muse-mapping.md, ../README.md]
---

# 검증 게이트 & 가드레일 (Verification & Guardrails)

> **왜 이게 "최고의 하네스"의 핵심인가?** 하네스의 병목은 만드는 게 아니라 **맞는지 확인하는
> 것**입니다([team-roles §0](team-roles.md)). 이 문서는 [team-roles](team-roles.md)의 평가자·게이트를
> 실제로 믿을 수 있게 만드는 규칙 — 채점을 일관되게 하는 법, 들어오고 나가는 것을 막는 가드레일,
> 게이트를 언제 어떻게 거는지 — 을 검증된 2026 레퍼런스에 근거해 정리합니다. (말로만, 코드 없음.)
>
> **1차 출처(Boris Cherny, Claude Code 창시자, 2026):** 검증은 품질에서 **가장 중요한 것** — "Claude에
> 자기 작업을 검증할 방법(다른 에이전트로 결과 확인·stop 훅 자가검증·UI를 열어 테스트)을 주면 최종
> 품질이 **2~3배**가 된다." 우리의 평가자·완료 게이트·훅이 정확히 그 피드백 루프다.

## 1. 평가자가 잘 판정하게 (채점 루브릭)

평가자가 후하거나 들쭉날쭉하면 게이트가 무의미합니다. 검증된 LLM-as-judge 실무 규칙:

- **명확하고 구체적인 루브릭.** "좋은가?"가 아니라 "무엇이 참이어야 통과인가"를 항목으로 정의합니다
  (핸드오프 양식의 수용 기준이 그 역할).
- **단순한 척도.** 1~10 같은 잔금 척도보다 **합격/불합격** 또는 1~3처럼 낮은 단계가 더 일관됩니다.
- **예시로 보정.** 통과/탈락 예시 몇 개(few-shot)를 주면 판정이 기준에 맞게 정렬됩니다.
- **편향 차단.** 위치 편향(앞에 온 답 선호), 장황함 편향(긴 답 선호), **자기선호 편향**(자기 답
  선호)을 의식적으로 막습니다 — 그래서 **만든 자와 판정하는 자를 반드시 분리**합니다.
- **결과만이 아니라 과정도 본다.** 에이전트 평가는 ① 작업 완료(목표 달성?) ② 경로 품질(단계가
  효율·논리적이었나) ③ 도구 선택의 적절성 — 이 세 축을 함께 봅니다.

> **1차 출처 검증(Anthropic Outcomes, 2026-05 Code with Claude):** 별도 grading agent가 **태스크
> 에이전트의 추론 체인을 못 보고 출력만** 루브릭으로 채점하니 **모델 변경 없이** 품질 +8.4%(Word)/
> +10.1%(PPT) 향상. 우리 "만든 자 ≠ 판정하는 자 + 루브릭 채점"이 정확히 그 구조 — Anthropic이 같은
> 설계로 정량 이득을 입증했다(우리 `.claude/agents/harness-evaluator`는 쓰기 권한 없음으로 분리를
> 도구 권한으로도 강제).

## 2. 들어오고 나가는 것을 막는다 (가드레일)

평가가 "끝나고 채점"이라면, 가드레일은 "도중에 즉시 차단"입니다. 두 종류:

- **입력 가드레일** — 처리 전에 사용자 입력을 검사(주제 이탈·악의적 요청 등). 걸리면 본 작업을 시작도
  안 하고 멈춥니다.
- **출력 가드레일** — 결과가 나가기 전에 검사(정책 위반·민감정보 노출 등).
- **트립와이어(즉시 차단).** 위반을 감지하면 바로 신호를 올려 실행을 **즉시 중단** — 비용·지연을
  아낍니다.
- **병렬로 싸게 먼저 거른다.** 본 작업(비싼 모델)과 **나란히** 빠르고 싼 검사를 돌려, 걸리면 일찍
  끝냅니다.

> Muse 맥락: 입력/출력 방어와 결정론적 안전 게이트는 이미 제품에 있습니다(SYSTEM-MAP #12).
> 하네스의 가드레일은 그 사상을 **에이전트 팀 경계에도** 적용하는 것입니다.

## 3. 게이트를 언제 거는가 (운용)

- **계획 승인 게이트(앞단)** — 구현 전에 계획을 한 번 본다. 나쁜 코드를 고치기보다 나쁜 계획을 고치는
  게 훨씬 쌉니다.
- **완료 게이트(뒷단)** — 작업 완료 시 수용 기준 대조 + (가능하면) 자동 테스트 실행. 통과해야 다음
  단계/병합.
- **막힘 우선(fail-closed).** 검증이 실패·불확실하면 통과시키지 않습니다. 근거 없이 PASS 금지.
- **루프 한도.** 무한 반복을 막는 명시적 종료 조건(반복 횟수·시간 상한). 안 끝나면 사람에게 올림.
- **재시도·반성엔 외부 검증자 필수.** 검증 신호 없는 "다시 생각해봐" 재시도는 같은 위반을
  ~85% 반복하고(arXiv 2510.18254), 내재적 자기교정은 오히려 정확도를 떨어뜨립니다(2310.01798) —
  효과가 있는 건 도구로 접지된 비평뿐(CRITIC: 코드 실행·검색 결과를 들고 하는 수정). 그래서
  BUILD↔EVAL 반복은 반드시 평가자의 구체 피드백(어느 기준을 어떻게 어겼나)을 들고 돌아야 하고,
  피드백 없는 맨 재시도는 루프 낭비로 간주해 끊습니다. (Muse 쪽 강제:
  `.claude/rules/agent-testing.md`의 reflection-schedule guard — 모든 재시도 표면에 검증자 등록.)

## 4. 실패에 강하게 (관측 & 복구)

- **전 과정 추적.** 입출력만이 아니라 **추론·도구 호출·중간 결정**까지 단계별로 남깁니다. 비결정적
  행동의 디버깅은 트레이스가 유일한 길입니다. 계층적 기록(오케스트레이터→워커→도구)이 좋습니다.
- **단계·비용 추적.** 단계별·실행별 토큰/비용을 관측합니다(멀티에이전트는 토큰을 크게 더 씀).
- **체크포인트에서 재개.** 긴 자율 작업은 의미 있는 분기점에서 상태를 저장하고, 실패 시 처음부터가
  아니라 **마지막 체크포인트에서 재개**합니다.
- **멱등성.** 반복 실행이 중복 부작용을 내지 않게 합니다(같은 전송을 두 번 보내지 않기 등).
- **회로 차단·백오프.** 도구 실패·연쇄 오류엔 재시도(백오프)와 회로 차단으로 번지지 않게 합니다.

## 5. 한 줄 요약 (게이트 체크리스트)

1. 수용 기준은 **구체적**인가(합격/불합격로 판정 가능)?
2. 판정자는 **만든 자와 다른가**, 편향을 막았는가?
3. 입력·출력에 **가드레일**이 있고, 위반 시 **즉시 중단**되는가?
4. 계획 앞단·완료 뒷단에 **게이트**가 있고, 불확실하면 **막히는가**?
5. **트레이스·비용**이 남고, 실패 시 **체크포인트에서 재개**되는가?

---

## 출처 (검증 기반)

- [LLM-as-a-Judge: A Practical Guide](https://towardsdatascience.com/llm-as-a-judge-a-practical-guide/) (명확한 루브릭·낮은 단계 척도·few-shot 보정·편향 차단)
- [OpenAI Agents SDK — Guardrails](https://openai.github.io/openai-agents-python/guardrails/) (입력/출력 가드레일·트립와이어·병렬 조기종료)
- Anthropic — [Building Effective Agents](https://www.anthropic.com/engineering/building-effective-agents) (단순성·투명성·게이트)
- Anthropic — [Outcomes: agents that verify their own work](https://platform.claude.com/cookbook/managed-agents-cma-verify-with-outcome-grader) (2026-05; 출력만 보는 별도 grading agent → 모델 불변 +8.4%/+10.1%)
- Cognition — [Don't Build Multi-Agents](https://cognition.ai/blog/dont-build-multi-agents) (전체 맥락 공유·충돌하는 암묵적 결정·단일 스레드 우선)
- 자기교정의 한계 — [Illusions of Reflection (2510.18254)](https://arxiv.org/abs/2510.18254) (반성 재시도가 같은 위반 ~85% 반복) · [LLMs Cannot Self-Correct Reasoning Yet (2310.01798)](https://arxiv.org/abs/2310.01798) · [CRITIC (2305.11738)](https://arxiv.org/abs/2305.11738) (도구 접지 비평만 효과)
- Boris Cherny (Claude Code 창시자) — [Latent Space 인터뷰](https://www.latent.space/p/claude-code) (검증이 품질에서 가장 중요; 자기검증 피드백 루프가 최종 품질 2~3배; harness=모델 위 최소 래퍼)
