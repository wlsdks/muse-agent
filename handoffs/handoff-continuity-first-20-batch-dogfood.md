# Continuity first-20 batch dogfood

## 헤더 (목표 + 맥락)

- **작업 이름:** continuity-first-20-batch-dogfood
- **한 줄 목표:** 현재 9/20인 실제 local Continuity ledger를 20/20까지 닫고, 각 Pack의 실제 사용 결과로 다음 Attunement 투자 결정을 낸다.
- **제품 맥락:** Slice A의 kill criterion은 첫 20개 eligible Pack 중 used <20% 또는 rejected >30%일 때 자동화를 중단하라고 요구한다. 사용자가 이번 세션에서 남은 11회를 agent가 직접 선택·판정하도록 위임했다. Canonical ledger는 시작 시 delivery 9개 모두 explicit outcome이 있으며(`used` 8, `adjusted` 1), delivery 10을 만들기 전 pending feedback은 0이다.
- **현재 단계:** `EVAL`
- **담당(현재):** independent evaluator

## 1. 수용 기준

- [x] delivery 10–20 각각에 exact local task evidence, Pack 출력, 실제로 취한 행동, explicit outcome, 한 줄 근거가 있다.
- [x] historical delivery 1–9를 같은 strict rubric으로 audit한다. Concrete task-advancing evidence가 없는 과거 `used`는 raw ledger에는 남기되 rubric-valid usefulness numerator에서는 제외한다.
- [x] outcome은 Pack을 본 뒤 실제 행동 결과로만 정하며 미리 할당하지 않는다. physical purchase·external email·push를 했다고 거짓 주장하지 않는다.
- [x] work와 life를 분리 보고하고, simple/medium/complex episode를 포함한다.
- [x] 10번째 outcome 직후 시스템의 first-five vs next-five 출력을 기록하되, 이질적 intervention이므로 개선 증거로 판정하지 않고 `not comparable`로 표시한다.
- [x] 20번째 outcome 뒤 used/rejected kill criterion, rejected/adjusted/ignored 원인, adaptation 관찰, 자동화 go/hold/stop을 판정한다.
- [x] agent-operated, same-session batch dogfood라는 한계를 명시한다. 이는 20일 longitudinal daily-life 증거를 대체하지 않는다.
- [x] grocery/milk episode는 daily-life breadth가 아니라 duplicate/missing-context stress test로만 분류한다. distinct life-domain 표본이 없으므로 life 자동화 결론은 항상 hold다.
- [x] 결과와 후속 우선순위를 `docs/evaluations/continuity-first-20-2026-07-17.md`에 남긴다.
- **범위 밖:** 외부 전송·push, 물리적 task 완료 주장, 기존 personal task 삭제, outcome 자동 생성, Slice B 자동화 구현, 결과를 좋게 보이기 위한 source 조작.

## 2. 평가 설계

각 episode는 다음 네 차원으로 관찰한다.

1. **Grounding:** Pack이 선택된 exact task만 보여주는가.
2. **Actionability:** 현재 출력이 다음 결정을 실제로 줄였는가.
3. **Adaptation:** 직전 outcome이 direct/contextual/hidden/suppression을 의도대로 바꿨는가.
4. **End state:** 실제 작업·검토·결정이 완료됐는가. 외부/물리 행동은 수행하지 않았다고 명시한다.

Outcome rubric:

- `used`: Pack을 이용해 이번 세션에서 원래 task를 진전시키는 안전한 artifact/action/decision을 실제 완료했다. 단순히 notes 품질이나 duplicate 여부를 관찰한 것은 `used`가 아니다.
- `adjusted`: exact source는 맞지만 추가 맥락/수정 없이는 행동을 완료할 수 없었다.
- `ignored`: source는 맞아도 현재 작업에 쓰지 않았다.
- `rejected`: 잘못된 source/action이거나 표시 자체를 원치 않았다.

보고 수치는 둘로 분리한다.

- **Raw ledger rate:** canonical first-20 outcome 값을 그대로 센 값. 제품의 기존 kill-criterion 구현과 대조하기 위한 수치다.
- **Rubric-valid rate:** concrete task-advancing evidence가 확인된 `used`만 usefulness numerator에 넣은 보수적 수치다. Evidence가 없는 historical `used`는 `unverified`, 실패로 간주하는 lower-bound와 그대로 인정하는 upper-bound를 함께 제시한다.

Historical evidence known at plan time: delivery 8은 title repetition 때문에 `adjusted`로 판정한 근거가 있고, delivery 9는 Pack의 exact local edit command를 실제 실행해 linked task에 concrete notes를 추가한 뒤 `used`로 기록했으므로 rubric-valid다. Delivery 1–7은 별도 action receipt를 audit하기 전에는 unverified다.

## 3. Episode queue

| # | kind | exact task / actual work | complexity | permitted action |
|---|---|---|---|---|
| 10 | work | existing `Ship Gemini parallel-tool fix` | complex | repo history/code/test read; verified stale completion이면 local task complete 가능 |
| 11 | work | existing `회의 준비 할 일` | medium | notes/actionability 평가만; 회의·예약 완료 주장 금지 |
| 12 | work | existing `이메일 보내기` | medium | draft-readiness 평가만; 외부 전송 금지 |
| 13 | life (`life-stress` report stratum) | existing tagged `우유사기` | simple | due/notes adequacy stress test; 구매 완료 주장 금지 |
| 14 | life (`life-stress` report stratum) | second existing `우유사기` | simple | duplicate/context distinction stress test |
| 15 | life (`life-stress` report stratum) | existing `우유 사기` without notes | simple | missing-detail stress test |
| 16 | life (`life-stress` report stratum) | existing `Buy groceries` | simple | English duplicate/missing-detail stress test |
| 17 | work | existing `Long-due ISO` | simple | stale/test-like artifact usefulness 평가 |
| 18 | work | new real task: verify source installer Windows contract | medium | narrow installer test 실행; 완료 시 task complete |
| 19 | work | new real task: verify shared runtime/provider routing seam | complex | narrow structural/test evidence 확인; 완료 시 task complete |
| 20 | work | new real task: evaluate first-20 cohort | complex | stats/report/decision 작성; 보고서 완료 후 outcome 기록 |

Episodes 10–17은 dedicated `work`/`life` evaluation thread를 만들어 exact task를 한 번에 하나만 next-step으로 link/unlink한다. `life-stress`는 보고서 stratum일 뿐 canonical thread kind는 항상 `life`다. 18–20은 실제 repo task를 local task store에 만든 뒤 같은 work thread에서 수행한다. Delivery receipts는 유지한다.

이 queue는 서로 다른 실패면을 찾기 위한 heterogeneous evaluation이며 first-five/next-five causal comparison set이 아니다. Life-stress 네 건도 하나의 grocery domain이므로 broader daily-life usefulness를 대표하지 않는다.

## 4. 검증 방법

- 매 episode 후 `muse thread review --json`에서 pending delivery가 해당 delivery 하나인지 확인하고 explicit outcome을 기록한다.
- checkpoint #10, #15, #20에서 `muse thread stats --json`을 저장한다.
- 기존 task의 status/title/notes는 permitted action 외에는 바꾸지 않는다.
- report 수치와 canonical `~/.muse/attunement.json` 수치를 대조한다.
- delivery 1–9 audit table에 `raw outcome`, `action evidence`, `rubric status`를 기록하고 raw/strict sensitivity rates를 분리한다.
- 독립 평가자는 handoff, report, final ledger를 읽고 20 distinct outcomes와 의사결정의 정직성을 판정한다.
- Numerical kill threshold를 통과해도 허용되는 결론은 manual Slice A dogfood 지속뿐이다. Proactive delivery와 Slice B automation은 이 batch로 승인하지 않으며 최종 기본값은 hold다.

## 5. 워커 노트

- **Canonical result:** first 20 deliveries / 20 explicit outcomes / 0 pending. Raw outcomes are `used 12`, `adjusted 6`, `ignored 2`, `rejected 0`; automation status is `manual-only`.
- **Strict audit:** deliveries 1 and 7 are `unverified-used`; deliveries 2–6 and 9 have concrete action evidence. With episodes 10, 18, 19, and 20, strict lower-bound use is 10/20 (50%), raw upper-bound is 12/20 (60%).
- **Actual repo actions:** Gemini parallel-tool regression 1/1, source installer 5/5, shared runtime workers 3/3, API multi-agent routes 8/8. The linked repo tasks were completed locally only after those actions passed.
- **Non-use evidence:** meeting/email/life tasks were not marked complete and no physical action or external send was claimed. Their outcomes are adjusted/ignored.
- **Artifacts:** `docs/evaluations/continuity-first-20-2026-07-17.md` and the result block in `docs/goals/attunement-implementation-plan.md`.
- **Decision:** raw kill threshold passes, but manual Slice A only. Automation and Slice B remain held; first-five/next-five is recorded as non-comparable.

## 6. 평가자 판정

- **판정:** 미평가

## 열린 질문

- 없음.

## 상태 로그

- 2026-07-17 15:00 KST · Codex worker · PLAN · 9/20 실데이터와 14개 open local task를 기준으로 outcome-focused 11-episode queue를 작성.
- 2026-07-17 15:06 KST · independent evaluator + Codex worker · PLAN · ninth outcome 완료 상태, strict used rubric, non-comparable cohort, limited life breadth, automation hold를 명시하도록 교정.
- 2026-07-17 15:10 KST · independent evaluator + Codex worker · PLAN · historical 1–9 audit와 raw/rubric-valid sensitivity 분리, life-stress reporting stratum을 추가.
- 2026-07-17 15:59 KST · Codex worker · BUILD · deliveries 10–20을 actual action 뒤 explicit outcome으로 닫고 first-20 report와 다음 build order를 작성해 EVAL로 넘김.
