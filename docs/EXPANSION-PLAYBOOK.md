# Muse Expansion Playbook — `/goal` 실행 조건

> 이 문서는 `/goal`에 인라인으로 넣으려던 자율 루프의 **standing contract**다.
> `/goal`은 조건 텍스트를 4000자로 제한하는데 이 계약은 그보다 길어(4202자)
> 인라인으로 넣을 수 없으므로 여기에 보관한다. 자율 세션을 시작할 때 이 파일
> 전체를 읽고 그대로 따른다. 충돌 시 `.claude/rules/*.md`와 `CLAUDE.md`가 이
> 문서를 override한다.

## 어떻게 명령하나

긴 계약 본문을 매번 붙일 필요 없이, 이 문서를 가리키는 한 줄로 시작한다.

한 슬라이스만 돌릴 때:

```
/goal docs/EXPANSION-PLAYBOOK.md 를 처음부터 끝까지 읽고 그 계약대로 따른다.
가장 가치 높은 슬라이스 하나를 골라 라이브 검증(LOCAL Ollama gemma4:12b)까지
끝내라. 검증 안 된 건 done 아님.
```

자율로 길게 돌릴 때(종료 조건을 함께 준다):

```
/goal docs/EXPANSION-PLAYBOOK.md 를 처음부터 끝까지 읽고 그 계약대로 루프를
돌려라. 종료 조건: 라이브 검증된 커밋 12개 OR 약 6시간/60턴 중 먼저 도달하는
쪽. 그 시점에 요약하고 멈춘다. 시작 전에 Ollama 가용 확인
(curl -s localhost:11434/api/tags); 안 되면 그걸 되살리는 게 첫 슬라이스.
```

특정 영역에 치우치게 하려면 끝에 한마디 덧붙인다 (예: `… 이번엔 grounding
게이트 surface 커버리지에 집중`).

---

이 에이전트(Muse) 자체의 기능·성능을 공개된 연구/레퍼런스에 근거해 계속 더 강하고·
정확하고·안전하게 만든다. 새 제품 기능 추가가 아니라 "에이전트 내부 역량의 심화·확장·측정·
수리"가 핵심. 작업 디렉토리: /Users/jinan/side-project/Muse. 한 번에 하나씩, 반드시 라이브로
검증해서 끝낸다. 추측 금지 — 모든 주장은 실제 실행으로 before/after를 측정한다.

중요: 무엇을 할지는 어디에도 적혀 있지 않다(작업 목록 docs는 의도적으로 삭제됨). 네가
서브에이전트를 써서 (1)코드 현재 상태와 (2)공개된 최신 기법을 직접 조사해 격차를 찾아내고,
가장 가치 높은 것 하나를 골라 작업한다.

## 강화 대상 (이 두 축에서만 고른다)

A. 논문기반 기능 — 이미 들어가 있는 것들을 "모든 surface에 적용 + 측정 + 약점 수리":
   · CRAG 신뢰게이트(Corrective RAG)  · RGV(rubric grounding verifier)
   · self-consistency / MaTTS(test-time scaling)  · claim-level ISSUP(Self-RAG / Chain-of-Note)
   · RARR repair(`muse ask --repair`)  · MAST 검증게이트 + evaluator-optimizer(멀티에이전트)
   → "또 하나 추가"보다 "안 거치는 surface를 게이트에 넣고, 측정하고, 뚫린 곳을 수리"가 우선.

B. 에이전트 자체 성능 — 코드에 실재하는 것들:
   · ReAct/계획 루프 (packages/agent-core: plan-execute-loop.ts, plan-execute.ts, model-loop.ts)
   · HITL (approval/guard-pipeline, draft-first, outbound-safety)
   · 보안 (guards.ts, 인젝션 패턴, spotlighting, fail-close — 프롬프트가 아니라 코드)
   · 멀티에이전트 (packages/multi-agent, council.ts)
   · 서브에이전트 (harness: planner→worker→evaluator 역할, handoff)
   · 내부 기능 (reflection-synthesis, playbook, skill-merge, grounding-eval, 메모리/episodic)

## 무엇을 할지 스스로 찾기 (매 작업 시작 시 — 서브에이전트로)

독립적인 조사는 서브에이전트로 병렬 위임한다(겹치지 않게 범위를 명확히, 각자 한 가지만):
1. [현재 상태 스카우트] 서브에이전트에게 위 A/B 중 한 영역의 코드 실재 상태를 codegraph/grep으로
   조사시킨다: 어떤 게이트/루프/가드가 있고, 어디에 구멍이 있나(예: 어떤 recall surface가 RGV를
   안 거치나? 어떤 서브에이전트 handoff가 typed-schema 검증을 안 하나?).
2. [공개 레퍼런스 조사] 다른 서브에이전트에게 그 기법의 1차 출처를 WebSearch/WebFetch로 찾게 한다.
   허용 출처만: arXiv 논문, 공식 문서, 평판 있는 엔지니어링 블로그 등 "공개되어 참조해도 문제없는"
   자료. 출처 URL과 핵심 기법(무엇을, 왜 효과적인지)을 1차 사실로 가져온다.
3. [격차 합성] 두 조사 결과를 네가(리드) 종합한다(maker≠judge — 서브에이전트가 자기 결론을
   스스로 채점하지 않게). "최신 기법 X" vs "Muse 현재 Y"의 격차 중 가장 가치 높고 한 커밋으로
   끝낼 수 있는 것 하나를 고른다. 막연하면 더 좁힌다.
   (서브에이전트는 비싸니 남용 금지 — 단순 단일 슬라이스는 인라인으로. 조사·적대적 리뷰처럼
    진짜 독립적이고 병렬적인 일에만 쓴다. 중첩 깊이 1.)

## 일하는 방식 (고른 작업마다)

1. 먼저 계약/맥락을 읽는다(추측 금지): .claude/rules/{architecture, agent-testing, tool-calling,
   outbound-safety, commits, code-style, codegraph}.md · CLAUDE.md · docs/{SYSTEM-MAP, FEATURES}.md ·
   관련 docs/design/*.md · 메모리 MEMORY.md. 구조 질문은 codegraph_* 먼저.
2. 근거를 명시한다: 1번 조사에서 가져온 공개 출처(URL)와 그 기법이 Muse 코드의 어디에 어떻게
   매핑되는지 1~2줄. 출처 없는 변경 금지.
3. 최소 범위로 구현한다: 보안·정책·게이트·종료조건은 deterministic 코드(프롬프트 지시 아님).
   maker≠judge(검증은 별도 호출). 소형 로컬 모델(gemma4:12b 기본)는 "프롬프트로 시키기"보다 "코드로 보장"이
   거의 항상 옳다. 관련 없는 리팩터/동작변경 금지.
4. 라이브로 검증한다 — done의 유일한 근거(LOCAL OLLAMA gemma4:12b, 클라우드 금지):
   · 닿는 게이트의 실제 배터리: eval:tools / eval:judge / eval:adversarial / eval:self-improving /
     eval:agent / eval:plan-quality 중 해당 것
   · 요청/응답 경로면 smoke:live · grounding이면 `muse doctor --grounding`
   · 멀티/서브에이전트면 typed-handoff 검증 + 종료/중복-방지 assert(agent-testing.md)
   · 불변식: fabrication-rate=0 (faithfulness 1.00 / false-refusal 0.00) 무회귀 · pnpm lint 0/0 ·
     변경 패키지 테스트 green · 교차패키지면 pnpm check
   · before/after를 수치로 실측(낙관·추측 금지). 안전·grounding-critical은 pass^k(k≥3, all-pass).
5. 자기 diff를 적대적으로 검토한다(필요하면 서브에이전트 레드팀): "inward churn인가? 가짜 검증인가?
   8B에 무효한 프롬프트 변경인가? 정상 경로를 hijack하는가?" 하나라도 걸리면 되돌리고 재선택.
6. 끝낸다: 의미있는 변경이면 1 Conventional Commit (COMMIT ONLY · push는 진안 승인 후 ·
   메시지 끝 Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>).
   그리고 한국어로 짧게 보고: 무엇을 · 왜(공개 출처 URL) · before/after 수치 · 남은 리스크.

## 서브에이전트 규율 (논문 합의)

· 동질 멀티에이전트 debate는 소형 8B에서 해롭다(arXiv 2605.00914) — Muse 자체 동작은 분해+검증+
  캐스케이드를 격리 컨텍스트의 단일 모델로. (단 네가 작업할 때 조사/리뷰용 서브에이전트는 OK.)
· 위임은 네-요소 brief로: 목표 · 출력형식 · 도구범위 · 경계. 범위 겹치면 중복 작업 발생.
· 핸드오프는 typed schema로 검증. 종료는 명시적(스텝 상한). maker≠judge 항상.

## 절대 규칙 (위반 금지)

· 로컬 우선: MUSE_LOCAL_ONLY 기본 ON, 클라우드 LLM/voice egress 금지. "escalate"는 더 큰 로컬
  모델 또는 정직한 "모르겠다"지 클라우드 아님.
· grounding floor는 천장이 아니라 바닥: 어떤 강화도 fabrication-rate=0을 깨면 안 됨.
· 보안은 deterministic 코드로(프롬프트 please-be-careful 금지). 아웃바운드는 draft-first+fail-close
  (outbound-safety.md). 금융계좌·송금은 영구 out of scope.
· 도구는 한 방에 옳게(tool-calling.md): ≤5~7개 노출, 단일목적 이름, 예시 든 스키마.
· "검증 안 된 건 존재하지 않는다": 라이브 배터리 green 없이 done 선언 금지. tsc만 통과는 검증 아님.
· 공개 자료만 참조(라이선스 OK). 사내/비공개 자료 가져오지 말 것.
