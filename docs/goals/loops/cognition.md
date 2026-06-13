# Loop journal — cognition

> Per-loop append-only journal (loop-creator v1.14.0+). One entry per fire, newest at bottom.
> Schema (going-forward entries):
>
>     ## fire N · YYYY-MM-DD · skill vX.Y.Z · <commit-sha>
>     meta: value-class=micro-fix|new-capability|wiring|refactor · pkg=@muse/… · kind=… · verdict=PASS|FAIL · firesSinceDrill=N
>     ratchet: testFiles … · fabrication 0 · <eval delta>
>     - 무엇 …  - 왜 …  - 리뷰지점 …  - 리스크 …
>
> 테마: agent-core 인지 강화 (메모리/자기강화/grounding/오케스트레이션). Why per-loop (not a shared digest): 4 loops run concurrently; a shared
> append file collides every fire and pollutes the version↔outcome correlation. Disjoint
> paths → no merge race, no pollution. Convention: [README](README.md).
> (Entries below the schema line are MIGRATED from the old shared loop-digest.md, original headers kept.)

## [cognition loop] fire 1 — 2026-06-12 · 테마: agent-core 인지 강화 (메모리)

- **무엇:** `@muse/memory` recall-promotion.ts에 ACT-R base-level activation `actrActivation(ages, {decay,minAgeDays}) = ln(Σ tⱼ⁻ᵈ)` 추가 (+ 9-case positive/negative 배터리). 별 루프(TOOL 테마)와 구분되는 새 인지-테마 루프(cron 105c213f)의 첫 fire.
- **왜:** 기존 `scoreRecallHit`은 `hits·2^(-lastHitAge/half)` — 마지막 히트 recency × 빈도뿐, **spacing(분산 연습)** 을 못 잡음. ACT-R는 각 접근을 자기 시계로 감쇠·합산해 빈도+spacing을 한 공식에 담음(Anderson&Schooler 1991). 메모리(5대 테마 #1) 강화의 원칙적 코어.
- **리뷰지점:** `packages/memory/src/recall-promotion.ts`(함수 24줄, 순수·추가만) + `index.ts`(re-export) + `packages/memory/test/actr-activation.test.ts`(신규 9-case). maker=Sonnet worker / judge=Opus(나)가 **실제 코드 독립 검증** + 배터리 독립 재실행(350 memory tests green). pnpm check의 1 실패는 무관한 apps/cli "Ollama down" retrieval 플레이크 — 격리 실행 시 green(2498/2498), 내 변경(미사용 leaf)과 무관 확인.
- **리스크:** 함수만 SHIP, 아직 **미배선**(promotion 경로 미적용) — 그래서 backlog 항목 ◦ 유지(Done 아님). 다음 슬라이스가 per-access 타임스탬프 데이터-패스 + half-life 교체 A/B. grounding floor 무관(순수 랭킹 수학).

## [cognition loop] fire 2 — 2026-06-12 · 테마: agent-core 인지 강화 (메모리)

- **무엇:** recall-hit 스토어(`personal-recall-hits-store.ts`)에 바운드된 per-access 타임스탬프 배열 `recentAccessMs`(cap 20) 추가 — fire 1 ACT-R 함수가 먹을 데이터 기반. 관용적 마이그레이션(옛 레코드 필드 없어도 OK) + read 시 garbage(`["x",null,5,NaN,7]`→`[5,7]`) 정리.
- **왜:** 기존 스토어는 `lastHitMs`+`hits`만 — ACT-R의 spacing 항(`Σ tⱼ⁻ᵈ`)은 각 접근 나이가 필요. 이 배열이 그 데이터 풋홀드. fire 1(함수)→fire 2(데이터)→다음(배선)으로 ACT-R 인지 강화 thread 진행.
- **리뷰지점:** `packages/mcp/src/personal-recall-hits-store.ts`(상수+필드+op append/trim+`normalizeRecord` 헬퍼) + `packages/mcp/test/recall-hits-store.test.ts`(신규 4 케이스: 누적/cap트림/옛레코드관용/garbage정리). maker=Sonnet worker / judge=Opus(나)가 normalizeRecord 관용·정리 로직 실제 검증 + mcp 1666 tests 독립 재실행 green. additive(기존 hits/lastHitMs/summary 무수정).
- **리스크:** 아직 **미배선**(scoreRecallHit이 recentAccessMs 미소비) — 다음 fire가 배선+A/B. 동시 main 루프와 같은 @muse/mcp지만 store 파일이라 tasks/browser와 disjoint(충돌 없음). pnpm -r build 전체 tsc clean, lint 0(앞 fire의 apps/cli Ollama 플레이크 회피 위해 full check 대신 -r build로 타입 회귀만 결정적 확인).

## [cognition loop] fire 3 — 2026-06-12 · 테마: agent-core 인지 강화 (메모리) · ⚠️ 3-FIRE 리뷰 관문

- **무엇:** ACT-R 활성도를 recall-promotion 랭킹에 배선 — `recallActivation`(recentAccessMs 있으면 전체 이력, 없으면 lastHitMs 단일 접근으로 같은 로그스케일 graceful fallback) + opt-in `useActrRanking`를 selectPromotable/selectForgettable에 추가, `muse memory consolidate`/promote 호출부에서 ON. fire1(함수)+fire2(데이터)+fire3(배선)으로 ACT-R thread 1차 완성.
- **왜:** 기존 랭킹은 마지막-히트 recency×빈도뿐 — spacing(분산 접근) 반영 X. ACT-R 정렬은 자주+넓게 접근된 메모리를 더 위로. **스케일 안전**: actrActivation은 로그스케일(음수 가능)이라 eligibility GATE(score≥minScore/≤maxScore)에 넣으면 게이트가 깨짐 → 그래서 ACT-R는 **정렬 순서에만**, 게이트는 plain score 그대로.
- **리뷰지점:** `packages/memory/src/recall-promotion.ts`(recallActivation + useActrRanking, 게이트 filter는 byte-identical 유지) + `index.ts` + `apps/cli/src/commands-memory.ts`(2 호출부) + `recall-promotion.test.ts`(5 케이스: 셋동일·게이트불변·legacy폴백·flag-off회귀·forgettable). judge=Opus(나)가 게이트 filter가 plain score임을 실제 코드로 확인 + memory 355 독립 green + cli 전체의 1 실패는 격리 시 통과하는 parallelism 플레이크(내 변경 stash해도 동일 — 무관) 확인.
- **리스크/열린 결정:** ACT-R가 eligibility GATE까지 구동할지(로그스케일 임계 재보정 + 측정 A/B)는 **이 리뷰 관문에서 진안 결정** — 정렬은 라이브, 게이트-이행은 미정. cli 전체 스위트에 isolation-플레이크 테스트 있음(격리 통과/풀병렬 실패, 앞 Ollama 플레이크와 같은 류) — 별도 안정화 슬라이스 후보.

> ⚠️ **3-FIRE 리뷰 관문 — fire 1–3 누적. 진안 확인 전 fire 4(새 슬라이스) 시작 금지.**

> ✅ **리뷰 관문 CLEARED (2026-06-12, 진안):** ACT-R thread = RANKING-ONLY로 종결(게이트-이행 A/B 미추구 — 정렬 lift는 확보, 게이트는 scale-safe plain score 유지). T2-1 → Done. **fire 4 = ACE deterministic playbook delta-merge (T1-1, 자기강화 #2)로 진행.** fire 4–6이 다음 리뷰 사이클.

## [cognition loop] fire 4 — 2026-06-12 · 테마: agent-core 인지 강화 (자기강화/playbook)

- **무엇:** `deltaMergePlaybookStrategies`(ACE 결정적 delta-merge)의 **직접 anti-collapse invariant 배터리** 추가 (7 케이스: <2→undefined·whitespace dedup·more-specific 생존·distinct→NONE·identical→자기·**불변식 property**·3-element chain). 테스트 전용 — src 무수정. T1-1 완료.
- **왜:** 함수는 이미 구현+배선돼 있었지만(이전 루프) backlog T1-1이 요구한 "anti-collapse invariant test"가 **없었음** — 간접(mergePlaybookStrategies 경유) 3 케이스뿐. ACE의 핵심 안전속성(학습 전략을 조용히 드롭하지 않음 = context-collapse 방지)이 미검증 상태였음.
- **리뷰지점:** `packages/agent-core/test/playbook-merge.test.ts`(+7 케이스, import 확장). judge=Opus(나)가 불변식 헬퍼 `coversAllWords`가 건전한지(모든 input 토큰이 survivor의 substring) + non-vacuous(3 셋 모두 string 반환, 커버 검증)임을 실제 코드로 확인 + agent-core 1691 독립 재실행 green.
- **리스크:** 가드의 *defer 분기*(non-transitive lone-survivor-fails-recoverage)는 직접 안 닿음(3 셋 모두 커버하는 survivor 반환) — 대신 그 분기가 강제하는 안전 PROPERTY를 non-vacuously 단언(이게 실제 보장). distinct-NONE·<2 두 undefined 경로는 커버. 새 capability 아닌 기존-함수 검증 강화 — but 미검증 안전속성을 닫는 정직한 T1-1 완결.

## [cognition loop] fire 5 — 2026-06-12 · 테마: agent-core 인지 강화 (자기강화/grounding 진단)

- **무엇:** `reportSentenceGroundedness(answer, evidence, floor?)` 추가 (`@muse/agent-core/sentence-groundedness.ts`) — hallucinations_v1 스타일 **문장별 grounding 진단**. 답변을 문장 분리 후 각 문장을 게이트와 같은 토큰-커버리지(≥floor 0.5)로 supported/unsupported 라벨 + unsupportedCount/Fraction. 9-case 배터리.
- **왜:** 답변-레벨 게이트는 "전체가 grounded냐"만 판정 — 어느 문장이 못-grounded인지 못 짚음. 문장별 진단은 self-improvement가 "이 문장이 fabrication"을 짚게 함(더 actionable한 연료). 메모리(ACT-R)·playbook(ACE)에 이어 테마 다양화(grounding 진단).
- **리뷰지점:** 신규 `sentence-groundedness.ts`(순수, 게이트의 `lexicalTokens` + `splitPreservingSentencePunctuation` 재사용) + `index.ts` re-export + 신규 test. judge=Opus(나)가 커버리지 로직이 `summaryGroundedInTranscript` 패턴과 일치·**진단-only(게이트 verdict 무변경, 신규파일+export만)** 임을 실제 코드로 확인 + agent-core 1700 독립 green.
- **리스크:** **진단 함수만 SHIP, eval:self-improving 리포트에 미배선** → backlog ◦ 유지(Done 아님), 다음 배선. "contradictory" 라벨은 NLI 필요(비결정적, deferred — supported/unsupported가 결정적 코어). grounding FLOOR 무관(verdict 안 바꾸는 additive 진단). cli 풀스위트 isolation-플레이크는 여전(별도 안정화 후보).

## [cognition loop] fire 6 — 2026-06-12 · 테마: agent-core 인지 강화 (grounding 진단 배선) · ⚠️ 3-FIRE 리뷰 관문

- **무엇:** fire 5의 per-sentence 진단을 **non-inert로 배선** — `worstUnsupportedSentence(report)` 추가 + ask grounding-gap weakness가 그 worst 문장을 ledger `hint`로 기록. 이제 fuel이 "어느 문장이 un-groundable"인지 짚음(query 토픽만이 아니라). T1 hallucinations_v1 Done.
- **왜:** fire 5 라벨러가 export-only(inert)였음(§4.5 가치 가드). 답변-레벨 게이트는 "전체 실패"만, fuel은 토픽만 알았음 — 이제 그 구체 문장을 named fuel로. self-improvement/error-analysis가 정확한 fabrication 문장을 받음.
- **리뷰지점:** `sentence-groundedness.ts`(+`worstUnsupportedSentence`) + `index.ts` + `commands-ask.ts`(recordAskWeakness/Live에 optional hint 스레딩 + 호출부: grounding-gap일 때만 scored/tasks/events/reminders 증거로 hint 계산) + 2 테스트파일. judge=Opus(나)가 호출부 in-scope·게이트-verdict 무변경 확인 + **LIVE 조립 CLI 검증**: "광합성 화학 반응식"→hint가 ungrounded 수식 문장을 정확히 지목, abstain→거부 문장 지목. agent-core 1703 green.
- **리스크:** hint 계산이 record의 try/catch 밖이지만 scored 등은 글로벌 노트 인덱스로 항상 채워짐(undefined throw 미발생, 라이브 확인). grounding FLOOR 무관(verdict 안 바꾸고 hint만 강화). cli 풀스위트 routine isolation-플레이크 여전(무관). 

> ⚠️ **3-FIRE 리뷰 관문 — fire 4–6 누적. 진안 확인 전 fire 7(새 슬라이스) 시작 금지.**

## [cognition loop] fire 7 — 2026-06-12 · 테마: agent-core 인지 강화 (멀티에이전트 오케스트레이션 #3)

- **무엇:** MoA 오케스트레이터(`orchestrate.ts`)의 **정직한 contributor 귀속** — `attributeContributors(merged, proposals, floor=0.4)` 추가, multi-merge 반환에서 `contributors`를 "전부"가 아닌 "merged가 실제로 끌어쓴" proposer만(lexical 커버리지 ≥floor; 아무도 못 넘으면 전체 fallback).
- **왜:** 기존 코드는 `contributors = proposals.map(p=>p.id)`(전부) — 하지만 필드 문서는 "synthesized answer가 ACTUALLY 끌어쓴 ids"이고 aggregator는 off-topic을 버림 → 감사추적이 **과대-주장**(MAST reasoning-action-mismatch). "show its work" 정체성을 약화. 새 테마(멀티에이전트) 착수.
- **리뷰지점:** `packages/agent-core/src/orchestrate.ts`(헬퍼 + multi-merge 한 줄, 다른 3 반환경로 무변경) + `orchestrate.test.ts`(헬퍼 3 + 통합 2). judge=Opus(나)가 회귀테스트가 **fallback 아닌 FILTER 경로**를 비-vacuous하게 침(merged=k8s/container가 alpha+beta만 덮고 gamma=sourdough 배제 → 정확히 2)을 실제 코드로 확인 + 단일-생존자 경로 무변경 확인 + agent-core 1708 독립 green.
- **리스크:** lexical-overlap은 휴리스틱 — 심한 paraphrase 기여자가 누락될 수 있으나 fallback(전체)이 빈-추적을 막음 + 과소-주장이 과대-주장보다 정직. answer/mode/proposals/failedRoles 전부 불변(감사 필드만). grounding floor 무관. fires 7–9가 리뷰 사이클.

## [cognition loop] fire 8 — 2026-06-12 · 테마: agent-core 인지 강화 (멀티에이전트 오케스트레이션 #3)

- **무엇:** A2A council의 **수용측 hand-off 경계 강화** — `parseCouncilResponse`(parseCouncilRequest와 대칭) + `MAX_COUNCIL_REASONING_CHARS`(4000) 추가, `requestCouncilReasoning`의 인라인 체크를 이걸로 대체. 핵심 가치 = **길이 바운드**(피어가 초기자의 로컬 synthesis 컨텍스트를 flood 못 함).
- **왜:** REQUEST 경계는 typed parser 있었지만 RESPONSE(로컬 synthesis로 흘러드는 위험 방향)는 인라인 ad-hoc + 길이 무제한. wire의 "bounded compute" 목표가 producing 쪽만, accepting 쪽 미적용 — MAST "모든 hand-off를 경계에서 검증".
- **리뷰지점:** `packages/a2a/src/council-wire.ts`(parseCouncilResponse+const, requestCouncilReasoning 2줄) + `index.ts` + `council-wire.test.ts`(6 unit + 1 integration). **judge=Opus(나)가 실제 regression 잡음**: worker 초안이 fromPeerId 비었으면 REJECT했는데, producer(handler.ts:94)는 selfPeerId 없으면 `""` emit → 정당한 reasoning이 드롭될 뻔 → fromPeerId를 carry-through(rejection 사유 아님)로 **완화**. a2a 141 green, lint 0.
- **리스크:** 길이 바운드는 truncate(거부 아님)라 긴 reasoning도 capped 유지. 동작 보존(kind+reasoning 거부 규칙 동일) + 바운드만 추가. council.ts(agent-core)·mcp tasks/browser 무관. grounding floor 무관.

## [cognition loop] fire 9 — 2026-06-12 · 테마: agent-core 인지 강화 (멀티에이전트 오케스트레이션 #3) · ⚠️ 3-FIRE 리뷰 관문

- **무엇:** council 합성에 **"one member, one voice"** 강제 — `dedupeUtterancesByPeer`(peerId당 1개, last-wins, 순서보존) 추가 후 `synthesizeCouncilAnswer`의 usable에 적용.
- **왜:** 기존엔 raw utterances를 dedup 없이 합성 프롬프트에 투입 — 중복 peerId(중복 레지스트리 항목, 또는 selfId가 peer id와 충돌, 둘 다 gatherCouncil로 도달 가능)면 그 멤버가 **이중 가중** → MAST duplicated-work, 심의 왜곡. 경계에서 검증(fire 8과 같은 원리, 합성 입력에 적용).
- **리뷰지점:** `packages/agent-core/src/council.ts`(헬퍼 + usable 한 줄) + `index.ts` + `council.test.ts`(3 unit + 1 integration). judge=Opus(나)가 통합테스트가 **합성 프롬프트를 캡처(sink)** 해 dup peer → alice의 LAST reasoning만 등장·first 미등장·`[id]` 2줄(3 아님)을 단언함(비-vacuous) 실제 확인 + agent-core 1712 독립 green. usable만 변경, 나머지 불변.
- **리스크:** 트리거는 misconfig(dup peer/self-in-peers)라 일상 빈도 낮음 — but 심의 무결성 불변식을 경계에서 보장(방어적이지만 정당). a2a·mcp tasks/browser 무관. grounding floor 무관.

> ⚠️ **3-FIRE 리뷰 관문 — fire 7–9 누적. 진안 확인 전 fire 10(새 슬라이스) 시작 금지.**

> ✅ **리뷰 관문 CLEARED (2026-06-12, 진안):** fires 7–9(멀티에이전트 MAST 가드 3종) 승인 + **배치 머지 지시**. **fire 10 = 백그라운드/sleep consolidation (#5, 미착수 테마)** — consolidationPlan(promote/fade)에 fire1-3 ACT-R 연결 + 유휴시 백그라운드 메모리 공고화. fires 10–12가 다음 리뷰 사이클.

## [cognition loop] fire 10 — 2026-06-12 · 테마: agent-core 인지 강화 (백그라운드/sleep consolidation #5)

- **무엇:** `shouldConsolidateMemory({nowMs,lastRunMs,newHitsSinceLastRun,minIntervalMs?,minNewHits?})` 추가 (`@muse/memory`) — 백그라운드 메모리 공고화 tick의 **brake-first 스케줄 게이트**(신규 자료 ≥minNewHits AND 마지막 실행 후 ≥minIntervalMs 둘 다일 때만 실행).
- **왜:** `consolidationPlan`(promote/fade)은 수동 `muse memory consolidate`로만 돌고 daemon은 playbook만 공고화·메모리는 안 함 — #5 갭. 백그라운드로 돌리려면 먼저 strain 안 주는 브레이크 필요(loop-v2 "non-straining, brake-first"). 새 테마(#5) 착수.
- **리뷰지점:** `packages/memory/src/recall-promotion.ts`(순수 게이트 + 2 const) + `index.ts` + `consolidation-schedule.test.ts`(10 케이스: never-run·material/time 브레이크 양방향·경계·non-finite fail-safe·커스텀 임계). judge=Opus(나)가 게이트 로직(material-brake-first·nowMs 가드·never-run/NaN-lastRun→go·`>=` 경계) 실제 코드 확인 + 10/10 + memory 365 독립 green.
- **리스크:** 게이트만 SHIP, **daemon 미배선**(아직 백그라운드 실행 안 함) → backlog ◦ 유지, 다음 fire가 daemon tick 배선. ACT-R 랭킹(T2-1)은 이미 useActrRanking로 consolidationPlan에 연결됨. grounding floor 무관. (배치 머지는 main이 dirty라 이번에도 deferred.)

## [cognition loop] fire 11 — 2026-06-12 · 테마: agent-core 인지 강화 (백그라운드/sleep consolidation #5)

- **무엇:** `planMemoryConsolidationTick(records, state, options)` 추가 (`@muse/memory`) — fire10 브레이크 + `consolidationPlan`을 합친 **순수 decide-and-run 유닛**: lastRunMs 이후 재engage된 recall 레코드(=신규 자료) 카운트 → 브레이크 게이트 → 통과 시에만 consolidationPlan **위임** → {ran, plan?, nextState}(lastRunMs는 ran일 때만 전진).
- **왜:** daemon이 백그라운드로 메모리를 공고화하려면 "지금 돌릴까 + 돌리면 결과" 결정 로직이 필요. 이걸 순수 함수로 빼서 daemon 루프(테스트 어려움) 밖에서 완전 테스트. fire10(게이트)→fire11(tick 플래너)→fire12(daemon 글루).
- **리뷰지점:** `packages/memory/src/recall-promotion.ts`(순수 플래너 + 2 인터페이스) + `index.ts` + `consolidation-tick.test.ts`(7 케이스). judge=Opus(나)가 플래너가 plan을 **위임**(fabricate 아님 — 케이스6: result.plan == 직접 consolidationPlan 호출의 promoted keys)·stale-material 브레이크(케이스5)·nextState 전진 조건 실제 코드 확인 + 7/7 + memory 372 독립 green.
- **리스크:** **daemon 미배선**(아직 백그라운드 실행 안 함) → backlog ◦ 유지, fire12가 thin 글루(readRecallHits→플래너→log+persist, playbookConsolidateTick 미러). 순수·additive, grounding floor 무관. (배치 머지 main dirty라 또 deferred.)

## [cognition loop] fire 12 — 2026-06-12 · 테마: agent-core 인지 강화 (백그라운드/sleep consolidation #5) · ⚠️ 3-FIRE 리뷰 관문

- **무엇:** fire10(브레이크)+fire11(플래너)를 **daemon에 배선** — `runMemoryConsolidationTick`(testable sibling fn) readRecallHits→planMemoryConsolidationTick→promote/fade 로그, playbookConsolidateTick 옆에 daemon tick으로 등록. 백그라운드 메모리 공고화가 이제 daemon 스케줄로 **실행됨**(브레이크 게이트). REPORT-ONLY.
- **왜:** #5 스레드 완성(gate→planner→glue). consolidationPlan이 수동 CLI로만 돌던 걸 daemon이 유휴시 brake-gated로 돌리게. SELFLEARN-gated·fail-soft. (배치 머지도 이번에 main clean돼 fires7-9 완료.)
- **리뷰지점:** 신규 `apps/cli/src/memory-consolidate-tick.ts`(glue fn) + `commands-daemon.ts`(closure lastRunMs + tick 등록 + 2 import) + 신규 test 4건. judge=Opus(나)가 glue 로직(disabled/throw→fail-soft 무변경·report-only=write API 없음·nextState 전진) 실제 코드 확인 + daemon 등록(SELFLEARN gate·Date.now·readRecallHits 배선·1281 await) 확인 + 4/4 + cli 2515 green.
- **리스크:** REPORT-ONLY — promotion **persistence**(백그라운드로 persona에 graduate)는 자체 안전가드 동반 다음 슬라이스. 현재 tick은 plan을 surface만, mutate 안 함. mcp tasks/browser·macos 무관. grounding floor 무관.

> ⚠️ **3-FIRE 리뷰 관문 — fire 10–12 누적. 진안 확인 전 fire 13(새 슬라이스) 시작 금지.**

> ✅ **리뷰 관문 CLEARED (2026-06-12, 진안):** fires 10–12(백그라운드 consolidation: 브레이크→플래너→daemon glue) 승인 + 배치 머지 지시. **fire 13 = 서브에이전트 활용 (#4, 마지막 미착수 테마)** — harness planner→worker→evaluator 실런타임 경계 강화(트이핑 스키마 검증·maker≠judge·중복 서브작업 방지). 5대 테마 1바퀴 완주 진입. fires 13–15가 다음 사이클.

## [cognition loop] fire 13 — 2026-06-12 · 테마: agent-core 인지 강화 (서브에이전트 #4)

- **무엇:** MoA fan-out에 **중복 서브에이전트 방지** — `dedupeRolesById`(id별 first-wins, 순서보존)를 `orchestrateAnswer`의 roleList에 적용. 5대 테마 마지막(#4) 착수.
- **왜:** roleList의 각 role을 병렬 proposer로 돌리는데 id dedup 없음 — dup-id role이면 ① 중복 서브에이전트 추론(낭비) ② dup-id proposal이 fire-7 attributeContributors/contributors를 오염(id 충돌). MAST "no duplicated sub-agent work". 실제 상호작용 버그(fire-7 정합성 보호).
- **리뷰지점:** `packages/agent-core/src/orchestrate.ts`(헬퍼 + roleList 한 줄) + `orchestrate.test.ts`(헬퍼 3 + 통합 1). judge=Opus(나)가 통합테스트가 dedup FILTER 실제로 침(2 dup + 1 → proposals 정확히 2·unique ids, redundant proposer 미실행)·DEFAULT_ROLES 무영향(distinct→no-op) 실제 코드 확인 + agent-core 1718 독립 green.
- **리스크:** dup roles는 misconfig라 일상 빈도 낮음 — but 사실상 fire-7 attribution 정합성을 보호(dup-id면 contributors 깨짐) + 낭비 추론 차단. answer/aggregation 불변. grounding floor 무관. (fires-10-12 배치 머지는 main dirty라 계속 deferred — clean되면 자동.)

## [cognition loop] fire 14 — 2026-06-12 · 테마: agent-core 인지 강화 (서브에이전트 #4)

- **무엇:** MoA fan-out에서 **빈 proposer 출력 → failedRoles**(유효 proposal 아님). 한 조건 추가(`&& outcome.value.text.trim().length > 0`)로 fulfilled-but-empty를 throw처럼 failedRoles로.
- **왜:** 기존엔 fulfilled proposer를 무조건 proposal로 push — 빈/공백 텍스트(안 throw한 degraded 서브에이전트)도 포함 → aggregator candidate 오염 + proposals.length 부풀림. MAST "failure propagation surfaces, never silently swallowed".
- **리뷰지점:** `packages/agent-core/src/orchestrate.ts`(forEach 조건 1개) + `orchestrate.test.ts`(빈→failedRoles·whitespace·all-empty fail-close·회귀 4건). judge=Opus(나)가 partition 조건·non-vacuous(빈 thorough → proposals 2개·failedRoles=["thorough"])·onProposal/fail-close/aggregate 무변경 실제 코드 확인 + agent-core 1722 독립 green.
- **리스크:** onProposal은 빈 proposer에도 여전히 fire(스트리밍 표시 후 결과서 제외 — 경미, 콜백은 라이브 표시용). 비-빈 동작 불변. grounding floor 무관. (fires-10-12 배치는 이번 fire에 main clean돼 **머지 완료** `cac55bb0`; fires 13-14는 다음 관문서.)

## [cognition loop] fire 15 — 2026-06-13 · 테마: agent-core 인지 강화 (서브에이전트 #4) · ⚠️ 3-FIRE 리뷰 관문(자율)

- **무엇:** MoA **aggregator 실패 복원력** — `aggregate()` 호출을 try/catch로 감싸 throw→빈 merge→기존 fallback(best proposal). proposers는 allSettled로 복원력 있었지만 aggregator만 무방비였음.
- **왜:** 플레이키 로컬모델 aggregator throw가 전체 orchestration을 reject → 성공한 proposer 작업 전부 손실. proposer가 fail-soft면 aggregator도 그래야(반쪽 복원력 X). MAST graceful-degradation.
- **리뷰지점:** `orchestrate.ts`(aggregate 호출 wrap만; fallback/final-return/single-survivor 불변) + `orchestrate.test.ts`(throws→resolves·empty→fallback·success→merged 3건). judge=Opus(나)가 wrap·throws테스트가 reject 아닌 resolves(thorough proposal 반환)임 실제 확인 + agent-core 1725 독립 green.
- **리스크:** 없음 — 동작 보존 + aggregator throw만 graceful화. grounding floor 무관.

> ✅ **자율 리뷰관문 (fires 13–15, 진안 묻지 않음):** 서브에이전트(#4) 3슬라이스 — 중복역할 dedup(13)·빈 proposer→failedRoles(14)·aggregator 복원력(15). **5대 테마 1바퀴 완주**(메모리1-3·playbook4·grounding진단5-6·멀티에이전트7-9·백그라운드10-12·서브에이전트13-15). maker≠judge 매 fire PASS. **사이클2 방향(스스로 결정): #5 promotion-PERSISTENCE 잔여**(report-only daemon tick → 안전가드 동반 실제 persona graduate)부터 — 이후 gap-scout로 agent-performance levers 등. fires-13-15 배치 머지는 main clean되는 ORIENT에서 자동.

## [cognition loop] fire 16 — 2026-06-13 · 사이클2 · 테마: 백그라운드 consolidation #5 (promotion-persistence)

- **무엇:** 백그라운드 메모리 tick을 report-only → **실제 persona 승격(persist)**으로 업그레이드. `runMemoryConsolidationTick`에 optional `persist` dep 추가; daemon이 기존 `promoteRecalledMemories`에 바인딩(opt-in flag `MUSE_SLEEP_PROMOTE`, 기본 OFF). #5 스레드 완성(gate→planner→glue→persist).
- **왜:** fire12 tick은 plan을 surface만 했음. 실제 가치=유휴시 가장 recall-useful 메모리를 persona에 graduate(loop-v2 Sleep daemon). brake-and-proof-first: 백그라운드 persona mutation은 전용 flag 뒤 기본 OFF.
- **리뷰지점:** `apps/cli/src/memory-consolidate-tick.ts`(persist 분기, fail-soft) + `commands-daemon.ts`(MUSE_SLEEP_PROMOTE 게이트 + FileUserMemoryStore/resolveMemoryUserId로 promoteRecalledMemories 바인딩, 수동 경로 미러) + test +5건. judge=Opus(나)가 persist 분기(throw→fail-soft·state 전진)·default-OFF(flag 없으면 persist undefined→report-only)·brake-fail/disabled시 persist 미호출·resolveMemoryUserId 실존 확인 + cli 2520 독립 green.
- **리스크:** 백그라운드 persona 쓰기지만 **기본 OFF**(opt-in) + idempotent(PROMOTED_ 키만 clear+rewrite)·비파괴(실 user facts 무관)·비-outbound. brake+SELFLEARN 게이트 유지. 라이브 daemon 검증은 미실행(장기 프로세스); persist fn은 수동 promote 경로와 공유돼 이미 검증됨. grounding floor 무관. (사이클2 fires 16-18.)
## [cognition loop] fire 17 — 2026-06-13 · 사이클2 · 테마: 자기강화 #2 (correction-polarity 강건화)

- **무엇:** `classifyCorrectionContradiction`의 de-negation 정규식 강건화 — contraction 보조동사(WON'T/CANNOT/CAN'T/WOULDN'T/SHOULDN'T/COULDN'T) + 부정어와 CONTRADICT 사이 0-2개 끼어든 단어("NOT A CONTRADICTION"/"DOESN'T REALLY CONTRADICT") 커버.
- **왜:** 기존 de-negation은 NOT/NO/NEVER/DOESN'T+직결 CONTRADICT만 잡음 — 모델이 "WON'T CONTRADICT"/"NOT A CONTRADICTION"처럼 답하면 phantom CONTRADICT → 사용자가 가르친 전략을 잘못 decay(자기강화 무결성 훼손). gap-scout가 stale backlog 항목의 실 잔여 갭 발굴.
- **리뷰지점:** `packages/agent-core/src/correction-distiller.ts`(deNegated 정규식 1개 + 주석) + `correction-distiller.test.ts`(부정형 12+·genuine 5·passthrough). judge=Opus(나)가 genuine contradiction 미-over-strip(CONTRADICT/CONTRADICTS/THIS CONTRADICTS THE RULE → "contradict") + over-strip 잔여는 conservative-by-design(no-decay로 fail, phantom-decay 회피가 함수의 명시 posture)임 확인 + agent-core 99 독립 green.
- **리스크:** {0,2} window가 "NO ... CONTRADICTS"류 다중절을 over-strip할 수 있으나 "one word" 프롬프트라 비현실적 + over-strip은 안전방향(decay 안 함). grounding floor 무관. (사이클2 fires 16-18, fire 18 후 자율 관문.)

## [cognition loop] fire 18 — 2026-06-13 · 사이클2 · 테마: grounding-surface 품질 · ⚠️ 3-FIRE 리뷰 관문(자율)

- **무엇:** `enforceAnswerCitations`의 whitespace 정리(`[ \t]{2,}→" "` 등)를 **citation이 실제 stripped된 경우에만** 실행하도록 게이트. clean 답변은 byte-for-byte 보존.
- **왜:** 정리 로직은 제거된 `[...]` 마커의 seam을 닫으려는 것인데 무조건 전체 답변에 돌아 — citation 없는 clean 답변의 코드블록 들여쓰기/정렬 표를 뭉갬. gap-scout가 line-296 audit 클러스터의 실 버그 발굴.
- **리뷰지점:** `packages/agent-core/src/knowledge-recall.ts`(3 replace를 `if(stripped.length>0)`로 래핑) + `knowledge-recall-citation-gate.test.ts`(clean 코드블록 verbatim·stripping seam 정리 유지·valid citation+코드 verbatim 3건). judge=Opus(나)가 stripping 경로 불변(case2)·clean verbatim(case1) 실제 코드 확인 + agent-core 1732 독립 green.
- **리스크:** stripped>0 경로의 코드블록은 여전히 collapse될 수 있으나(드묾: 코드답+invalid citation) 잔여로 기록. grounding floor 무관(citation 게이트 verdict 무변경, 출력 정리만).

> ✅ **자율 리뷰관문 (fires 16–18, 진안 묻지 않음):** 사이클2 — #5 promotion-persistence(16)·#2 correction-polarity 강건화(17)·grounding-surface whitespace fix(18). maker≠judge 매 fire PASS. **사이클3 방향(스스로): gap-scout로 line-296 audit 클러스터 잔여 버그(casual-prompt 말해줘 over-match, dedup write-memoize 등) + agent-performance levers 중 결정적 슬라이스 우선.** fires-16-18 배치 머지는 main clean시 자동.


## [cognition loop] fire 19 — 2026-06-13 · 사이클3 · 테마: 메모리/상태일관성 (tool-call dedup)

- **무엇:** `ToolCallDeduplicator`가 모든 completed 결과를 memoize해 READ 결과가 in-loop write 후 stale되던 버그 수정 — 각 엔트리에 `mutating` 플래그, mutating(write/execute) record 시 READ 엔트리 무효화(write 엔트리는 유지=anti-double-write 보존). model-loop 양 record 사이트가 tool risk로 `mutating` 전달.
- **왜:** `tasks_list → tasks_add → tasks_list`(동일 args)가 add 이전 stale 리스트를 반환 → 에이전트가 낡은 상태로 행동. write 후 read 무효화로 fresh 재실행. (메모리 round-robin 사이클3, gap-scout가 line-297 audit 클러스터의 실 버그 발굴.)
- **리뷰지점:** `tool-call-deduplicator.ts`(MemoEntry+mutating 무효화) + `model-loop.ts`(2 사이트 risk 룩업) + test +6. **maker=Sonnet worker / judge=Fable 5 서브에이전트**(model:"fable", 새 티어링 첫 적용) — Fable judge가 anti-double-write 보존·not-inert(실 write 툴 risk 흐름)·양 사이트·1738 green을 적대 검증 후 VERDICT PASS.
- **리스크:** 비차단 nit 2(eviction 테스트 주석 오해소지·loop-level 통합테스트 없음=후속). unknown 툴→mutating false(수용). grounding floor 무관. (사이클3 fires 19-21.)

## [cognition loop] fire 20 — 2026-06-13 · 사이클3 · 테마: grounding/recall provenance (casual over-match)

- **무엇:** `isCasualPromptText`(verified-source footer 억제 게이트)의 social 정규식에서 `말해줘` 제거. "내 일정 말해줘"/"박지훈 전화번호 말해줘"는 recall imperative인데 casual로 오분류 → grounded 답변의 출처 footer가 억제되던 버그.
- **왜:** 출처 표시는 Muse의 핵심(grounded+cited). "말해줘"는 인사가 아니라 흔한 recall 명령 → 출처 억제는 제품 가치 훼손. casual "농담 말해줘"는 어차피 출처 없어 무해 → 제거가 net win. gap-scout가 line-297 클러스터의 실 버그 발굴.
- **리뷰지점:** `response-filters-verified-sources.ts`(정규식 1토큰 + WHY 주석) + `is-casual-prompt-text.test.ts`(recall imperative→false 3·social 여전 casual 4·greeting 경계 regression). **maker=Sonnet / judge=Fable 5**: Fable judge가 old-vs-new 시뮬레이션으로 non-vacuous(전엔 true·후엔 false)·over-removal 없음(casual 유지)·유일 consumer가 의도된 효과임 확인 → VERDICT PASS. agent-core 1741 green.
- **리스크:** 잔여 `전해줘`도 유사 over-match 소지 있으나 빈도 낮아 유지(차후). grounding floor 강화 방향(출처 더 보존). (사이클3 fires 19-21.)

## [cognition loop] fire 21 — 2026-06-13 · 사이클3 · 테마: anti-fabrication arg-grounding (API 정확성) · ⚠️ 3-FIRE 리뷰 관문(자율)

- **무엇:** `groundToolArguments`의 `dropped` 리포트 수정 — string-ARRAY 부분 드롭(일부 fabricated, 일부 grounded) 시 survivor를 keep하면서도 arg name을 `dropped`에 넣던 오보고. 이제 `dropped`=완전 제거된 arg만(부분 정리는 survivor keep + 미보고).
- **왜:** `dropped` 계약은 "드롭된 arg 이름". 부분-정리된 (살아있는) arg를 dropped로 보고하면 투명성 consumer가 "tags 드롭됨"으로 오인. .args 정리(보호)는 불변 — 리포트 정확성 버그. audit 클러스터의 in-scope 마지막 항목.
- **리뷰지점:** `tool-argument-grounding.ts`(array 분기 2-way + JSDoc) + `tool-argument-grounding.test.ts`(부분→미보고·전부fabricated→보고+제거·전부grounded→무변경·string regression; **버그 인코딩 테스트 1개 flip**). **maker=Sonnet / judge=Fable 5**: Fable judge가 **test flip이 정당한지**(old가 버그 인코딩, full-removal 테스트는 여전히 dropped 단언) + .args 보호 불변 + 3분기 전수 확인 → VERDICT PASS. agent-core 1746 green.
- **리스크:** .dropped는 런타임 미사용(agent-runtime:859는 .args만) → API 정확성 fix(저severity but 계약 정합). grounding floor 무관.

> ✅ **자율 리뷰관문 (fires 19–21, 진안 묻지 않음):** 사이클3 — line-295 audit 클러스터의 in-scope 버그 3종 정리: dedup stale-read-after-write(19)·말해줘 casual over-match(20)·groundToolArguments partial-array 오보고(21). 모두 Fable-5 judge 적대검증 PASS. **사이클4 방향(스스로): audit 클러스터 in-scope 소진 — 남은(consent header/web URL/encryption)은 범위밖/동시루프 영역. cycle4=fresh gap-scout(frontier queued: Mem0 UPDATE / ACT-R 후속 등) 또는 미감사 모듈 1개 정밀감사.** fires-19-21 배치는 main clean시 자동 머지.


## [cognition loop] fire 22 — 2026-06-13 · 사이클4 · 테마: grounding/CRAG confidence integrity

- **무엇:** `rankKnowledgeChunksWithHop`의 second-hop "bridge" 매치가 SEED-relative cosine을 달고 append돼 CRAG retrieval-confidence를 부풀리던 버그 수정 — bridge cosine을 **원 query 기준**으로 재계산(query 1회 embed, embedText 우선, 일관 공간), embed 에러 시 **fail-safe cosine:0**(절대 confidence 안 올림).
- **왜:** `KnowledgeMatch.cosine` 계약 = "query에 대한 절대 cosine"(CRAG 신호). near-dup 노트(seed 0.95/query 0.48)가 약한 retrieval을 "confident"로 뒤집어 → LOW-confidence 경고 억제 + proactive stay-quiet 게이트 무력화 + phantom clarify. "약하면 조용히" 아키텍처의 입력 신호 정합성 복구(verdict 로직 불변=IMMUTABLE-CORE safe).
- **리뷰지점:** `knowledge-recall.ts`(rankKnowledgeChunksWithHop append 재계산 + fail-safe; primary/score/RRF/cap/no-op 불변) + `two-hop-recall.test.ts`(+7: query-relative cosine·confidence-inflation regression·bridge 유지·primary 불변·embedText 선호·fail-safe·no-op). **maker=Sonnet / judge=Fable 5**: Fable judge가 **소스를 HEAD로 revert해 regression이 진짜 무는지 실증**(pre-fix 0.9997→confident 4 테스트 실패, post 0.48→ambiguous) + fail-OPEN 경로 없음 + verdict 미변경 확인 → VERDICT PASS. agent-core 1753 green, dependent autoconfigure 빌드 OK.
- **리스크:** 없음 — 입력 복구(verdict 무변경)·fail-safe·prod 추가 라운드트립 없음(caching embedder cache hit). gap-scout(Fable)가 발굴한 실 버그 — maturity-wall에서 진짜 가치 슬라이스. (사이클4 fires 22-24.)

## [cognition loop] fire 23 — 2026-06-13 · 사이클4 · 테마: weakness-ledger 바운드 성장

- **무엇:** `writeWeaknesses`에 `MAX_WEAKNESS_ENTRIES=2000` 캡 — overflow 시 selectors가 쓰는 순서(count desc, then recency)로 정렬·slice, stale one-off 축출. under-cap은 verbatim(무재정렬).
- **왜:** recall-hits(5000 trim)와 달리 무제한 — 새 (axis,topic) 행이 영원히 쌓여 디스크·read 비용 증가. Fable scout(fire22) runner-up #1. bounded-growth posture 일관성.
- **리뷰지점:** `packages/mcp/src/weakness-ledger.ts`(const+trim) + `weakness-ledger.test.ts`(+5). maker=Sonnet / judge=Fable 5 — under-cap order-pin이 non-vacuous([3,1,2] 입력)·over-cap 축출 genuine·scope가 tasks/browser/calendar 안 샘 확인 → VERDICT PASS. mcp 1683 green.
- **리스크:** 캡 2000 높아 일상 미발동. under-cap 동작 불변. grounding floor 무관. (사이클4 fires 22-24.)

## [cognition loop] fire 24 — 2026-06-13 · 사이클4 · 테마: grounding value-escalation 비용 · ⚠️ 3-FIRE 리뷰 관문(자율)

- **무엇:** `answerAssertsUnsupportedValue`가 문장초두 connective("However"/"Based"/"Therefore", LEXICAL_STOPWORDS에 없음)를 named entity로 오인해 불필요한 value-escalation judge 패스를 태우던 것 → `SENTENCE_OPENER_STOPLIST` 추가로 제외. 진짜 wrong-entity/number/email 검출은 불변(보존).
- **왜:** 챗봇이 문장을 connective로 자주 시작 → 매번 로컬 12B judge 추론 낭비(call-site는 fail-open이라 오escalation은 무해하지만 비용). gap-scout runner-up #2.
- **리뷰지점:** `knowledge-recall.ts`(stoplist+filter 한 줄) + `knowledge-recall-reverify.test.ts`. **maker=Sonnet / judge=Fable 5 — judge가 1차 FAIL**: 양성 테스트가 vacuous(throwing `never` judge를 fail-open catch가 삼킴 → fix 없어도 통과)를 stash-counterfactual로 적발 → `async()=>false`로 교정해 verdict가 갈리게 + **revert 시 3 opener 테스트 FAIL 직접 확인**(non-vacuous). agent-core 1760 green.
- **리스크:** stoplist의 "Given"/"Note" 등이 희귀 고유명사와 충돌 가능하나 fail-open이라 무해(escalation 한 번 덜 탈 뿐). genuine drift 불변. 교훈: fail-open 경로의 "judge 안 불림" 테스트는 throwing judge 말고 verdict-차이/call-count로 검증해야 non-vacuous.

> ✅ **자율 리뷰관문 (fires 22–24, 진안 묻지 않음):** 사이클4 — second-hop CRAG confidence 부풀림(22, Fable scout 발굴, 헤드라인)·weakness-ledger 바운드(23)·sentence-opener 오escalation(24). Fable judge가 22를 revert-counterfactual로 실증 PASS, 24는 vacuous-test 적발→교정. **사이클5 방향(스스로): Fable scout 재가동해 cognition 코어 다음 고가치 슬라이스 발굴(audit 클러스터 소진, 22가 보여준 scout의 가치) — 또는 진안이 원하는 "최신 논문 기반 검증-적용" 쪽으로.** fires-22-24 배치는 main clean시 자동 머지.


## [cognition loop] fire 25 — 2026-06-13 · 사이클5 · 테마: 메모리/associative recall (PAPER-GROUNDED, skill v1.11.2)

- **무엇:** **HippoRAG 2 (arXiv:2502.14802, 공개 ICML 2025 preprint)** 적용 — `associative-recall.ts`: note-link 그래프(공유 토큰 edge, 가중치 Σ1/df) + Personalized PageRank(결정적 power iteration). `rankKnowledgeChunksWithHop`에 opt-in `associative` 플래그로 배선(PPR>0 graph-reachable bridge만 append, fire-22 query-cosine fail-safe 경로 재사용).
- **왜:** Muse recall이 isolated(cosine+BM25+ACT-R)였음 — 그래프/spreading-activation 0. HippoRAG는 PPR로 임베딩이 못 잡는 연상 체인(rare-token chain)을 결정적으로 surface(논문: associative task +7%). 메모리 테마의 **논문-근거 신규 capability**(진안 지시: 공개 논문만, 방법 적용·코드 미복사).
- **리뷰지점:** 신규 `associative-recall.ts`(buildNoteLinkGraph + personalizedPageRank) + `index.ts` + `knowledge-recall.ts`(opt-in 배선, PPR>0 floor) + 테스트 14. **maker=Sonnet worker / scout+judge=Fable 5**: Fable scout가 WebSearch로 논문 검증·스펙, Fable judge가 **v1 FAIL 적발**(PPR>0 floor 누락 → unrelated PPR-0 노트 append + vacuous 통합테스트) → 정확 처방 → 재구현 + non-vacuous 테스트(bridge flag-off 부재/flag-on 그래프-체인 존재/unrelated 배제, counterfactual 검증). agent-core 1772 green.
- **리스크:** opt-in·flag-off byte-identical·verdict 무변경(floor-safe). LLM OpenIE/synonym edge는 deferred(결정적 rare-token 그래프로 대체 — PPR 코어가 충실한 부분). CLI ask 배선은 live multi-hop battery 後 follow-up. RATCHET: testFiles +1, fabrication 0 유지, 신규 capability(associative recall) 추가.

> NOTE: 이 fire는 **loop-creator skill v1.11.2로 신규 등록된 cron fecd6aef의 첫 fire** — 논문-근거(arXiv 인용)+공개논문-only+Fable scout/judge 모드의 첫 실증. 사이클5 fires 25-27.

## [cognition loop] fire 26 — 2026-06-13 · 사이클5 · 테마: 멀티에이전트 검증 (PAPER-GROUNDED, skill v1.11.2)

- **무엇:** **BoN-MAV (arXiv:2502.20379, 공개 CC-BY preprint)** 적용 — `verifier-vote.ts`: `aggregateVerifierVotes`(binary aspect 투표 합산, AggScore=approvals/count, argmax, 결정적 tie-break) + `DEFAULT_ASPECT_VERIFIERS`(on-topic/substantive/non-hedging). MoA aggregator 실패 fallback이 "thorough"를 맹목 선택하던 것 → 검증 투표로 best candidate 선택.
- **왜:** Muse는 "Bo-n"(MoA proposers)만 있고 "MAV"(후보 검증) 없었음 — aggregator throw 시 off-topic "thorough"도 그냥 골랐음. 다중 약한 검증기 투표 합산이 단일 verdict보다 낫다(논문). 멀티에이전트 테마 논문-근거 capability(fire25 메모리와 다른 KIND, 다양성).
- **리뷰지점:** 신규 `verifier-vote.ts` + `index.ts` + `orchestrate.ts`(fallback 한 줄, happy path 불변) + 테스트 14+. **maker=Sonnet / scout+judge=Fable 5**: Fable judge가 **orchestrate.ts를 HEAD로 revert해 behavior delta가 non-vacuous임 실증**(off-topic thorough vs on-topic skeptic → skeptic 선택, pre-change는 thorough) + honesty-safe(non-hedging은 상대 랭킹, all-hedge도 선택 반환, abstention 미전환, grounding/citation 파일 무수정) 확인 → VERDICT PASS. agent-core 1786 green.
- **리스크:** fallback 경로만 변경, happy path byte-identical, verdict/floor 무관. LLM aspect verifier + happy-path 적용은 deferred(현 슬라이스는 결정적 AV + 실패경로). RATCHET: testFiles +1(143), fabrication 0 유지, 신규 capability(candidate verification).

## [cognition loop] fire 27 — 2026-06-13 · 사이클5 · 테마: 자기강화/playbook lifecycle (PAPER-GROUNDED) · ⚠️ 3-FIRE 리뷰 관문(자율)

- **무엇:** **Memp (arXiv:2508.06433, 공개 preprint)** 적용 — playbook에 per-entry 결과 tally(reinforcements/decays) + Wilson-interval 게이트 lifecycle(deprecate/graduate). 기존 net-scalar reward("never used"와 "5↑5↓" 혼동)를 evidence 기반으로. 스토어 tally write + 4개 production projection carry + 랭킹 경로 consume까지 END-TO-END.
- **왜:** ReasoningBank(retrieve)·correction-distiller(build)는 있었지만 Memp의 Update/deprecate regimen 부재 — 자주 실패하는 전략이 영원히 살아남고 1회 reinforce로 졸업. evidence-conditioned로 confidently-bad는 강등, 충분-good만 졸업. 자기강화 테마 논문-근거(fire25 메모리·26 멀티에이전트와 다른 KIND).
- **리뷰지점:** `playbook.ts`(wilson/effectiveReward/planLifecycle+wiring) + `personal-playbook-store.ts`(tally write) + 4 projection(`context-engineering-builders.ts` + commands-ask ×3) + `decay-contradicted.ts`(real isInjectableStrategy import) + 테스트. **maker=Sonnet / scout+judge=Fable 5**: Fable judge **v1 FAIL**(projection이 tally strip → lifecycle INERT) 적발 → 4 projection carry-through 완성 + **assembled-path 테스트**(confident-bad이 real buildPlaybookProvider 통과 후 ranking서 제외 + counterfactual: stripped면 통과). agent-core 1805·autoconfigure 509·cli 2528 green.
- **리스크:** playbook=prompt-ranking only(floor 무관). delta===0→decay 잠재이슈 노트(현 미도달). RATCHET: testFiles +다수, fabrication 0, 신규 capability(evidence playbook lifecycle). 교훈: "store write + consume" 슬라이스는 중간 projection layer가 필드를 strip하면 inert — assembled-path 테스트로 end-to-end 증명 필수.

> ✅ **자율 리뷰관문 (fires 25–27, 진안 묻지 않음):** 사이클5 = **논문-근거 3연속**(전부 공개 arXiv, 자체 재구현, Fable scout 발굴+Fable judge 적대검증): 25 HippoRAG PPR 연상recall(2502.14802)·26 BoN-MAV verifier vote(2502.20379)·27 Memp playbook lifecycle(2508.06433). Fable judge가 25·27을 v1 FAIL시키고(누락 floor/inert) 재구현으로 통과 — verify-then-apply가 실제로 작동. **사이클6 방향(스스로): 계속 논문-근거 라운드로빈(서브에이전트·백그라운드 테마 차례) — gap-scout/Fable scout.** fires-25-27 배치는 main clean시 자동 머지.


## [cognition loop] fire 28 — 2026-06-13 · 사이클6 · 테마: 멀티에이전트 robustness (PAPER-GROUNDED)

- **무엇:** **MoA deception robustness (arXiv:2503.05856, 공개)** 적용 — `screenCouncilOutliers`: 패널 합의 대비 outlier(기만/off-topic) peer를 합성 前 격리(per-member 평균 pairwise Jaccard support, absFloor AND relFloor×median, panel≥3, majority-preserving cap). `synthesizeCouncilAnswer`에 dedupe 後 배선(prompt+validPeerIds는 kept만, excludedPeers 추가). DEAD `orchestrateAnswer` 회피, LIVE council seam.
- **왜:** A2A peer는 외부 untrusted agent — 기만 peer reasoning이 합성에 흘러들면 reverify judge가 "거짓이 곧 인용 증거"라 PASS(GROUNDED≠TRUE 구멍, 6번째 표면). 멀티에이전트 robustness(fire25-27과 다른 KIND).
- **리뷰지점:** `council.ts`(screen fn + 배선) + `index.ts` + `council.test.ts`. **maker=Sonnet / scout+judge=Fable 5**: scout가 inert seam(orchestrateAnswer dead) 회피 확인. judge **v1 FAIL** — 인라인 `\w+` 토크나이저가 ASCII-only라 **한국어(Muse 주언어)에서 깨짐**(기만 한국어 peer 영영 미screen) 실증 → CJK-aware `lexicalTokens` 재사용 + jaccard(∅)→0 + 한국어 테스트로 수정(counterfactual: old 토크나이저면 9 테스트 fail). agent-core 1815 green.
- **리스크:** **문서화된 한계** — cross-LANGUAGE 패널(EN 다수 속 정당 KO peer)은 token overlap 0이라 오격리(동종 패널·기만-peer 보안케이스는 정상). embedding 기반 cross-lingual 유사도 필요 → backlog ◦. 격리는 subtractive(floor/reverify 불변). RATCHET: testFiles +0(기존 파일), fabrication 0, 신규 방어 표면(council outlier). 교훈: 유사도/토크나이저 슬라이스는 영어 테스트만으로 green이어도 한국어에서 깨질 수 있음 — CJK 테스트 필수.

## [cognition loop] fire 29 — 2026-06-13 · 사이클6 · 테마: calibration/abstention 품질 (PAPER-GROUNDED)

- **무엇:** **Multi-group/multivalid conformal UQ (arXiv:2407.21057, Liu & Wu, CMU, open-access)** 적용 — `calibrateAbstentionByGroup`(conformal.ts: 그룹별 n≥minGroupN이면 자체 conformal tau, 얇은 그룹은 pooled fallback) + `scoreGroundingEval`에 per-`dominantScriptFamily` tally/calibration/`groupCoverageViolations`(pooled tau 하 coverage<1−α 그룹) 가산 + `renderGroundingEvalReport`가 per-group 행 + ⚠ 위반 줄 렌더. 더해 production `GROUNDING_EVAL_CORPUS`에 한국어 서브그룹(12 answerable + 4 must-refuse + 12 노트) 추가.
- **왜:** abstention 보정이 POOLED-only인데 보정 코퍼스가 EN-only → pooled "≥90% coverage"가 한국어(Muse 주언어) 서브그룹에서 60%로 조용히 무너지는 게 논문의 정확한 실패 모드. per-group 측정으로 그 격차를 드러냄. fire25-28(HippoRAG/BoN-MAV/Memp/MoA-robustness)과 다른 KIND(calibration). 가산 측정만 — verdict/threshold 무변경(fabrication floor 안전).
- **리뷰지점:** `conformal.ts`+`grounding-eval.ts`(+테스트) agent-core, `grounding-eval-runner.ts`+`grounding-eval-corpus.ts`(+테스트) cli. **maker=Sonnet / scout+judge=Fable 5**: judge **v1 FAIL(INERT)** — 메커니즘은 옳으나 production 코퍼스가 EN-only라 hangul 그룹이 영영 안 생겨 ⚠ 렌더 도달 불가(fixture에서만 발화). 한국어 코퍼스 추가로 수정 → judge **v2 PASS**: 실제 `muse doctor --grounding`(live Ollama, exit 0)가 latin+hangul 2그룹 렌더(hangul 0/12 FR, 4/4 faithfulness), 12 한국어 answerable 전부 hangul 라우팅·own tau(pooledFallback=false). counterfactual: production-corpus 테스트가 HEAD 코퍼스에서 hangul-assertion에 fail. cli 2533, agent-core 1825, lint 0.
- **리스크:** 낮음 — 가산 측정 + EN 케이스 byte-identical + verdict 불변. fabrication floor: 한국어 answerable 12개 모두 인용 노트가 답을 실제 포함(judge 검증), must-refuse 4개는 진짜 ungrounded. RATCHET: testFiles +1(conformal.test.ts)·+한국어 케이스 16, fabrication 0 유지, 신규 진단 표면(per-script-family coverage violation). 교훈: 측정 슬라이스는 "계산됨"이 아니라 "production 입력이 그 코드 경로에 실제 도달"해야 non-inert — fire27/28에 이은 inert-trap 재확인.

## [cognition loop] fire 30 — 2026-06-13 · 사이클6 · 테마: 메모리관리 (PAPER-GROUNDED)

- **무엇:** **MemoryBank Ebbinghaus 망각 루프 (arXiv:2305.10250, Zhong et al., AAAI 2024, open-access)** 적용 — 이미 *계산만* 되던 fade(`selectForgettable`, 3표면 report-only inert)를 닫음. `muse memory consolidate`가 `plan.fade` 키를 사이드카(`~/.muse/memory-fade.json`)에 WRITE → production 에피소드 recall 랭커(`StoreBackedEpisodicRecallProvider.resolve`, default-ON)가 READ해 faded 세션 similarity ×FADE_PENALTY=0.5(minScore 게이트 後, ranking-only) → 재recall된 메모리는 consolidate 재실행이 사이드카를 덮어쓰며 자동 reinstatement(추가 state 0).
- **왜:** fade가 세 표면 깊이 계산되나 *어디서도 적용 안 됨* = judge가 3 fire 연속 잡은 inert 씨앗 — 이번엔 닫음(신규 inert가 아니라 기존 inert 해소). KIND=메모리관리(fire27 playbook·28 multi-agent·29 calibration과 다름). 망각이 retrieval로 피드백되고 recall이 망각을 되돌리는 게 논문 핵심.
- **리뷰지점:** personal-recall-hits-store.ts(write/readFadedMemoryKeys)+index.ts(mcp)·provider-paths.ts(resolveFadedMemoriesFile)+context-engineering-builders.ts(autoconfigure)·episodic-recall.ts(fadedKeys+penalty)·commands-memory.ts(write+문구). **maker=Sonnet / judge=Fable 5 PASS**: 세션키 동일성 end-to-end(sessionId 전 hop 동일, file:line 추적)·default-ON reader·실writer·counterfactual robust(FADE_PENALTY=1.0이면 assembled+down-rank 테스트 5/5 fail, tie-break 아닌 strict inequality)·post-gate multiply-only(삭제 없음)·fail-open 3층. mcp1696·agent-core1831·cli2535·check0·lint0.
- **리스크:** 낮음 — ranking-only+additive+fail-open, down-rank만(삭제 안 함), fabrication 표면은 줄기만 함. 정직한 한계: consolidate는 수동/on-demand라 사이드카가 그때만 갱신 — 데몬 tick 자동갱신은 backlog remainder. RATCHET: testFiles +2(episodic-recall-fade, memory-fade-assembled), fabrication 0 유지, 신규: 닫힌 망각 루프(첫 fade-적용 표면). grounding floor 무관.


## [cognition loop] fire 31 — 2026-06-13 · 사이클7 · 테마: 서브에이전트 오케스트레이션 (PAPER-GROUNDED)

- **무엇:** **ReConcile 합의-게이트 라운드 예산 (arXiv:2309.13007, Chen/Saha/Bansal, ACL 2024, open-access)** 적용 — `muse swarm council`의 debate 라운드를 고정 카운트 → "최대"로: `hasCouncilConsensus`(전 멤버 평균 pairwise Jaccard support ≥ DEFAULT_COUNCIL_AGREE_AT=0.16)를 루프 조건에 추가. ANTI-INERT 핵심: `--rounds` 기본 `1→2` 범프(기본 1에선 debate 루프 자체가 안 돌아 게이트가 inert) — 합의 패널은 1라운드(현 비용)에 단축, 분쟁 패널만 (그동안 휴면이던) 2라운드 소비. screenCouncilOutliers의 support 수학을 `councilMemberSupports`로 공유 추출.
- **왜:** 유일한 LIVE 멀티에이전트 표면이 수렴-무관(round-blind) — 이미 합의한 패널도 전 멤버 재실행(MAST step-repetition + termination-unawareness, 로컬추론+peer HTTP 낭비). ReConcile: 합의 즉시 종료. 사이클7 = 미터치 테마(서브에이전트) 진입, KIND≠fire28(aggregation screen)·29(calibration)·30(memory).
- **리뷰지점:** council.ts(councilMemberSupports 리팩터+hasCouncilConsensus)+index.ts·commands-swarm.ts(기본2+루프조건+audit줄+단일 gather 클로저 seam)+program.ts·council.test.ts·commands-swarm.test.ts. **maker=Sonnet / judge=Fable 5 PASS**: 기본2 확인·counterfactual 둘 다 non-vacuous(기본→1이면 DIVERGING-2gather fail, 게이트→false면 AGREEING-1gather fail)·실 hasCouncilConsensus가 테스트 경로 구동·리팩터 행동보존(29/29 fire-28 케이스 포함)·floor-safe(게이트는 라운드 단축만, cap3+dedupe/screen/id-gate/reverify 불변). judge가 seam이 루프를 복제(드리프트 위험)라 지적 → **추가 fire에서 단일 루프로 dedup**(gather 클로저만 주입, grep 단일 루프 확인) → 테스트가 이제 production 루프 구동.
- **리스크:** 낮음 — termination-only+bounded, 다운스트림 honesty 게이트 불변. **백로그 노트(judge 발굴):** (1) KO/EN 혼합 합의 패널은 Jaccard support=0(토큰 미겹침)→오"분쟁"→바운드 1라운드 낭비(fire-28 CJK 위험 가족, embedding 유사도 필요), (2) mcp playbook-store weighted-eviction 테스트가 full-suite 병렬 부하 5s 타임아웃(고립 실행 1696/1696 통과 — 동시성 flake, stabilization 후보). RATCHET: testFiles +0(기존 파일 +14 케이스), fabrication 0 유지, 신규: 수렴-인지 council(서브에이전트 종료 가드). 기본 1→2는 의도적 bounded 행동변경(논문 이점).

## [cognition loop] fire 32 — 2026-06-13 · 사이클7 · 테마: 메타인지/Whetstone (PAPER-GROUNDED)

- **무엇:** **Bayesian Knowledge Tracing (arXiv:2105.00385, Badrinath/Wang/Pardos, pyBKT, EDM'21, open-access)** 적용 — Whetstone weakness 원장의 망각/해소 루프 닫음. `WeaknessEntry`에 BKT mastery `pKnown` 추가; `muse ask`의 grounded(non-action) 결과가 `recordWeaknessResolved`로 그 토픽 pKnown을 BKT 갱신(성공 obs); `selectRemediableWeaknesses`에 `!isMasteredWeakness(≥0.95)` 필터 → 이미 고친 grounding-gap을 recap이 더는 nag 안 함. 상수 PRIOR0.1/LEARN0.2/GUESS0.2/SLIP0.1.
- **왜:** 원장이 append-only 비관(실패만 기록) — 사용자가 노트 추가해 grounded로 답해도 recap이 30일간 "X 노트 추가하라" 계속 nag(실 UX 버그). Whetstone(진안 지시 3번째 코어 축)이 monitor→detect→classify→persist만 하고 *개선 관측*을 못 했음. BKT는 성공/실패 스트림→mastery의 canonical 학습과학 모델. KIND=메타인지(fire29 calibration·30 memory·31 council과 다름). 한 번의 운 좋은 grounded는 mastery 못 줌(0.2→0.62, slip/guess 노이즈 흡수 = pass^k 정신), 3회 필요.
- **리뷰지점:** weakness-ledger.ts(bktUpdate+isMasteredWeakness+recordWeaknessResolved+selector 필터)+index.ts·commands-ask.ts(recordAskWeaknessResolvedLive, 기본-ON 결과블록 :3804). **maker=Sonnet / judge=Fable 5 PASS**: writer 기본-ON(MUSE_SELFLEARN grep 0, deterministic 게이트 verdict가 성공신호)·reader 동일 selector(recap:314)·BKT 수학 독립 재계산 정확(53/85·2449/2705·실패 0.96→0.80)·counterfactual 둘 다 non-vacuous(mastery→false 3 fail, 1성공-mastery 2 fail)·no-match no-write·answer 경로 byte-identical·legacy(pKnown 부재) 무변. mcp1714·cli2544·lint0.
- **리스크:** 낮음 — 순수 additive 메타데이터+read-side nudge 필터, 게이트/citation/abstention/프롬프트/모델콜 무변(answer 경로 불변, fabrication=0 동일). **caveat(judge):** doctor의 nudge는 다른 selector(`selectDevFixableWeaknesses`, grounding-gap 구조적 제외)라 이 슬라이스가 고치는 건 recap nag 표면(실제 나깅); doctor raw 인벤토리 덤프는 여전히 mastered 토픽 나열(정직한 목록, nag 아님) → backlog. topic-key 충돌은 정확매칭+3회필요+실패시 재활성이라 낮음. RATCHET: testFiles +0(기존 파일 +59 케이스), fabrication 0 유지, 신규: Whetstone 해소 루프(첫 mastery 추적). grounding floor 무관.

## [cognition loop] fire 33 — 2026-06-13 · 사이클7 · 테마: 자기강화/playbook RETRIEVAL (PAPER-GROUNDED)

- **무엇:** **MemRL Two-Phase Value-Aware Retrieval (arXiv:2601.03192, Zhang et al. 2026, open-access)** 적용 — playbook 전략 SELECTION을 2단계로: (A) 관련도가 eligibility 게이트(relevanceOnly>minScore, k1=2·topK 캡), (B) 후보 풀 내 z-score 정규화 합성 `0.5·rel̂+0.5·Q̂−reflected`로 재랭크. `scoreStrategy`(raw additive blend) 제거 → `relevanceScore`+`zScoreNorm`+`rankEligible(relevanceOf,utilityOf)`.
- **왜:** 기존 blend가 unbounded 토큰겹침 + bounded ±2.5 reward를 raw 합산 → fire27 Memp 증거 tally가 긴 쿼리선 소멸, 희소 쿼리선 관련도 게이트를 넘어 leak. MemRL: 관련도로 GATE, 효용은 관련 후보 내에서만 re-rank(off-topic을 절대 못 끌어올림). KIND=자기강화/playbook retrieval(fire30 memory·31 council·32 BKT와 다름), 항상-켜진 ask 경로.
- **리뷰지점:** playbook.ts(relevanceScore/zScoreNorm/rankEligible 2단계, 두 랭커 재배선)+playbook.test.ts. **maker=Sonnet / judge=Fable 5 PASS**: judge가 **실제 revert**(playbook.ts stash, 테스트 유지, 재빌드)로 raw blend선 헤드라인 3 테스트 fail 실증(counterfactual a/b + applyPlaybook 렌더 — off-topic 고효용 "bake bread"가 옛 코드선 실제 [Learned Strategies] 블록에 등장) → 복원 47/47. Phase A reward-free·두 분기 게이트·scoreStrategy 완전제거·avoided/probation/recency-floor/reflected/small-bank 불변·σ=0→0 NaN없음. agent-core1856·cli2544·lint0.
- **리스크:** 낮음 — selection-only(이미 injectable 중 재랭크), Phase A는 TIGHTEN만(reward가 sub-minScore 못 구함), 게이트/citation/reverify/wording 불변. **정직한 caveat(judge):** (1) 스펙의 "cli playbook test"는 실제 추가 안 됨(agent-core applyPlaybook 테스트가 assembled-path 증명) — 과장 안 함; (2) scale-invariance/b-direct 테스트는 theatre/vacuous(a/b/assembled trio가 증명 담당); (3) recency-floor top-up이 raw-composite를 Phase-B z-score와 섞어 정렬 → 블록 ORDER만 영향(membership 무관) → backlog. RATCHET: testFiles +0(기존 파일 +12 케이스), fabrication 0 유지, 신규: 가치-인지 playbook 선택(fire27 tally가 실제 주입 지배). grounding floor 무관.

> ✅ **자율 리뷰관문 (fires 31–33, 진안 묻지 않음):** 사이클7 = **논문-근거 3연속**(전부 공개 arXiv, 자체 재구현, Fable scout 발굴 + Fable judge 적대검증; 사이클 테마 = 서브에이전트·메타인지·자기강화로 라운드로빈 완주): 31 ReConcile 합의-게이트 council 종료(2309.13007)·32 BKT weakness mastery 해소(2105.00385)·33 MemRL 2단계 가치-인지 playbook retrieval(2601.03192). Fable judge가 31의 seam-복제 드리프트(→단일루프 dedup), 32의 doctor-selector caveat, 33의 실제-revert counterfactual을 모두 적대검증; inert/vacuous 없음. 공통 패턴: 항상-켜진 경로 + 실제-revert/assembled-path로 non-inert 증명, 정직한 caveat은 backlog. **사이클8 방향(스스로): 라운드로빈 1바퀴 완주 → gap-scout가 다음 고가치 테마 자율결정(논문-근거 유지); 후보 = 백그라운드-스레드(단 default-off MUSE_SELFLEARN inert 함정 주의, default-on 소비경로 필수) 또는 메모리/오케스트레이션 신규 메커니즘.** fires-31-33 배치는 main dirty(동시 루프 macos 편집)라 머지 deferred → 다음 clean ORIENT에서 3-way 머지.

## [cognition loop] fire 34 — 2026-06-13 · 사이클8 · 테마: 메모리-consolidation 충실도 (PAPER-GROUNDED)

- **무엇:** **non-compressive detail retention (arXiv:2511.17208, Zhou & Han UIUC 2025, open-access)** 적용 — 압축(compaction) 요약이 잃던 salient 디테일을 보존. 신규 `salient-facts.ts`: `extractSalientFacts`(user/assistant 턴만, tool 제외; NUMERIC/DECISION/ENTITY, VERBATIM 부분문자열) + `mergeSalientFacts`(키-정규화 newest-wins+cap) + `[Key details]` 블록 render/parse/strip. `buildCompactionSummaryText`가 한 블록만 emit(중복 제거), `persistConversationSummaryFromRequest`가 StructuredFact를 wipe 대신 merge.
- **왜:** compaction이 세 결함(숫자/날짜/결정 손실 + 라운드마다 요약 중복 + 설계됐으나 죽은 facts 필드 wipe) — "마케팅 예산 1,250만원"이 compact-out되면 사라져 chat NUMBER 오값 게이트가 anchor할 진실값을 잃음. 항상-켜진 compaction seam(기본-ON, MUSE_LLM_WORKING_BUDGET_TOKENS=0이 opt-OUT)이라 [Key details]가 다음 턴 system 메시지에 들어감(non-inert). KIND=메모리-consolidation 충실도(이전 fire들과 다른 신규 영역).
- **리뷰지점:** salient-facts.ts(신규)+index.ts(memory)·memory-token-trim.ts·context-transforms.ts(agent-core). **maker=Sonnet / judge=Fable 5 — 적대검증 5회 FAIL→수정(이 슬라이스의 핵심 가치)**: v1 inert→고침; v2/v3/v4 FLOOR 오염(verbatim≠faithful) — KO 복합단위 숫자가 truncate(`5천만원`→`5천` 1만배 오류, `$3-4M`→`$3`)→**CONT-집합 maximal-token 특성화**(digit∪구분자∪scale단위∪한글수사, 4방향 대칭 boundary guard: 완전한 금액이거나 DROP)로 해결; v5 DECISION mid-cut(한국어 verb-final이라 >140자 결정문이 끝의 부정어 손실→의미 역전) + 공백 guard가 ASCII만→**drop-if-over-cap(slice 금지)** + `/\s/u` guard로 해결; v6 PASS. counterfactual로 두 fix 모두 non-vacuous 입증. memory417·agent-core1860·lint0·byte-hygiene clean.
- **리스크:** FLOOR-안전 by construction — 추출값은 user 턴의 VERBATIM 부분문자열(생성 0→fabricate 불가), tool 턴 제외(신뢰경계), 숫자는 maximal-token-or-drop, 결정문은 fit-or-drop, merge는 무관 키 안 지움. 게이트/threshold/프롬프트 무변경(answer 경로 불변) — floor를 STRENGTHEN(오값 게이트가 압축후 진실값 회복). **정직한 DROP scope(backlog):** Latin-unit 숫자(`42 people`), KO 다중-세그먼트 복합(`3억 5천만원`=3.5억, 공백분리)은 신뢰 파싱 불가라 DROP→전용 KO numeral parser slice 필요; 레거시 "Tools kept/Recent topics" 줄 중복은 별도. 비용: scout1+worker6+judge6(floor-critical이라 정당). RATCHET: testFiles +3, fabrication 0 유지(STRENGTHEN), 신규: compaction salient-fact 보존. grounding floor 직접 강화.

## [cognition loop] fire 35 — 2026-06-13 · 사이클8 · 테마: retrieval 쿼리 처리 (PAPER-GROUNDED)

- **무엇:** **RAG-Fusion (arXiv:2402.03367, Rackauckas 2024, open-access)** 적용 — 복합 질문("내 MTU랑 집세 날 각각 뭐야?")을 결정적으로 절(clause)로 쪼개 각각 embed → per-clause cosine 랭킹을 기존 `fuseByReciprocalRank`에 추가 list로 융합. 신규 `splitCompoundQuery`(KO/EN 등위 마커 이랑·랑·하고·그리고·및·and·also·?경계; 2-3절 & 각 ≥2 content token일 때만, 아니면 []; 각각은 의미 한정사라 제외) + `diversifyAskChunks`에 optional `subqueryEmbeddings`.
- **왜:** headline `muse ask` 노트 검색이 질문을 ONCE embed → 복합질문은 두 토픽 사이에 blended되어 topK=3에서 한 답 청크가 탈락 → 코퍼스가 다 커버하는데도 반쪽답/오거부(cited-recall wedge 침식). RAG-Fusion: 변형별 검색 후 RRF 병합. 결정적 splitter라 논문의 topic-drift 실패모드 구조적으로 회피 + 추가 LLM콜 0. KIND=retrieval 쿼리처리(fire31 council·32 BKT·33 playbook·34 compaction과 다름), **저-floor-risk 형태(순수 ranking/selection, 텍스트 생성 0)** — fire34 추출-슬라이스 6라운드 교훈 반영.
- **리뷰지점:** compound-query.ts(신규)+index.ts(agent-core)·commands-ask.ts(diversifyAskChunks subqueryEmbeddings + 호출부, fail-open). **maker=Sonnet / judge=Fable 5 PASS(1라운드)**: judge가 **실제 revert**(subqueryEmbeddings 무시)로 non-vacuity 테스트가 정확히 fail함을 실증(fusion이 load-bearing) + FLOOR 불변(per-chunk score=full-query cosine, clause-hot 청크도 confidence "ambiguous" 유지 — 소스+라이브 probe 둘 다 검증; fusion은 confidence 저하만 가능, 절대 inflate 불가) + 비복합시 byte-identical/추가embed 0 + splitter 보수적(headline KO 정확 분할, over-split은 full-query list#0이라 무해). agent-core1875·cli2550·lint0.
- **리스크:** 낮음 — 순수 selection(사용자 자기 노트 청크 중 어느 것이 프롬프트에 들어갈지만 변경, 텍스트 주입 0), score 불변이라 게이트/confidence 입력 동일, embed 실패 fail-open, 비복합 무변경. **non-blocking 노트(judge):** must-refuse 테스트가 score 동일성만 assert(verdict 명시 assert 누락 — judge가 직접 검증; backlog 보강), 이론적 eviction은 zero-cosine 기하에서만(비현실). RATCHET: testFiles +2, fabrication 0 유지, 신규: 복합질문 multi-query 검색. grounding floor 강화(복합질문 joint recall).

## [cognition loop] fire 36 — 2026-06-13 · 사이클8 · 테마: 멀티에이전트 hand-off 검증 (PAPER-GROUNDED) — DEFERRED

- **무엇:** **Prompt Infection 방어 (arXiv:2410.07283, Lee & Tiwari 2024, open-access)** 시도 — council hand-off에서 미검증 peer 텍스트가 round-2 debate digest(전 peer + 자기 모델로 재방송)에 흘러드는 self-replicating 인젝션 채널을 결정적 quarantine으로 차단. screenCouncilInfection(findInjectionPatterns 재사용) 메커니즘은 구축+judge-PASS(fail-close all-infected→null, non-inert, fire-28/31 불변). **그러나 DEFERRED**: 슬라이스 revert, backlog 블로커 기록.
- **왜 DEFER:** 탐지기 CALIBRATION이 tar-pit. @muse/policy의 sharedInjectionPatterns는 적대적 USER 입력용이라 fluent MODEL 추론을 스크리닝하면 정직한(소수의견) peer를 over-quarantine — 4 judge 라운드 연속 새 FP 발견(environment_extraction "envision", credential_extraction "token...give", sandbox_escape "without approval check", cross_user_access "another"의 other, training_data_extraction "print internal context", role_override의 debug-mode 서브패턴 "enable debug mode for this test"). 서브패턴 whack-a-mole 미수렴 — unanchored 매처가 prose에 FP 내는 게 근본 원인. over-quarantine은 정직한 peer 침묵 = 용납 불가(deliberation 오염·은밀한 검열). fire-34 numeric tar-pit과 동형 → "한 FP 더 나오면 defer" 룰 준수.
- **리뷰지점:** 슬라이스 전체 revert(council.ts/index.ts/commands-swarm.ts/테스트 HEAD 복원), docs만 커밋. backlog ⏳ 블로커에 4라운드 FP 인벤토리 + 경로(council-local prose-safe 패턴셋, 큰 (정직추론, 진짜인젝션) 코퍼스로 실증 보정; 4라운드 생존 clean 패밀리 코어 명시; screenCouncilInfection 메커니즘 재사용) 기록 → 재개 저렴.
- **리스크:** 없음(슬라이스 미적용, 트리 fire-35 HEAD와 동일). 교훈: 공유 인젝션 패턴(USER 입력 분포)을 MODEL-prose 스크리닝에 재사용하면 양방향 miscalibrate — 새 입력 분포엔 새 탐지기 필요(fire-34 verbatim≠faithful과 같은 분포-불일치 교훈). maker≠judge가 4회 FP를 잡아 floor 회귀(정직 peer 드롭)를 막음 — 정확히 적대 검증의 가치. RATCHET: 코드 무변동(defer), fabrication 0 유지, backlog에 연구된 블로커 +1. grounding floor 무관(차단 미적용, 회귀 0).


## [cognition loop] fire 37 — 2026-06-13 · 사이클9 · 테마: 플래닝 검증/수리 (PAPER-GROUNDED)

- **무엇:** **ISR-LLM (arXiv:2308.13724, Zhou et al. ICRA 2024, open-access)** 적용 — `muse chat --mode plan_execute`의 실행-前 플랜 검증을 인자(argument)까지 확장 + 1회 verifier-backed 수리. `validatePlan`에 `toolSchemas` 추가(스텝별 `coerceToolArguments`→`validateRequiredToolArguments`로 누락 필수인자 플래그, coercible은 통과) + 정확-중복 스텝 검출 + `dedupeExactSteps`; `streamPlanExecute`가 dedupe→validate→(invalid면 검증오류 피드백으로 generatePlan 1회 재호출→재검증, 여전히 invalid면 기존 throw).
- **왜:** 기존 게이트는 step수+tool등록만 검사, 인자 미검증 → 후행 스텝 인자 누락 시 선행 스텝(리마인더/캘린더/노트 WRITE 가능)이 먼저 실행되고 막힘 → 부분 부작용(τ-bench no-partial-side-effects 위반) + 죽은 run. ISR-LLM: 실행 前 검증→오류 피드백→bounded 수리. KIND=플래닝(fire34 memory·35 retrieval과 다름), **저-floor-risk(구조적 스키마 검증, 추출/공유탐지기 아님)**. 기존 validateRequiredToolArguments/coerceToolArguments를 plan-time으로 끌어올림(재구현 0).
- **리뷰지점:** plan-execute.ts(validatePlan 인자/중복 + dedupeExactSteps)·plan-execute-loop.ts(dedupe+1회 수리)·reflection-guard.test.mjs(신규 surface 등록). **maker=Sonnet / judge=Opus 4.8(Fable5 불가 fallback) PASS**: 수정된 기존 테스트 3개 정당(unavailable-tool throw→direct-answer는 안전불변 보존[toolResults=0·무변이], hard throw는 신규 repair-stays-invalid 테스트가 증명; maxToolCalls/oversized는 distinct-args 필요[dedup 간섭]·경계 assert 유지); no-partial-side-effects 실제-revert로 non-vacuous(인자검증 제거 시 6테스트 fail, headline zero-executeToolCall 포함); non-inert(toolSchemas가 라이브 경로 request.tools에서 채워짐); 수리 bounded(1라운드)+검증자-backed+오류텍스트-fed; 인자검사 보정됨(coercible/optional/required-present 미플래그=오거부 없음). agent-core 1893·reflection-guard 1·lint 0.
- **리스크:** 낮음 — 검증은 어떤 tool 실행보다 先, 플랜만 차단/수리(답변/citation/grounding 게이트 불변), 수리는 同 validator 재검증(bare retry 아님), terminal은 기존 fail-close throw(부작용 strictly 감소). toolSchemas 부재 시 byte-identical(back-compat). dedup은 정확-중복만(write 도구 중복 부작용 방지, 정당). 정직한 defer: `plan-repaired` 스트림 이벤트(union 엄격 타이핑)→backlog. RATCHET: testFiles +1, fabrication 0 유지, 신규: 실행-前 인자검증+verifier 수리(부분부작용 구멍 차단). grounding floor 무관(플랜 게이트, 답변 경로 불변).

## [cognition loop] fire 38 — 2026-06-13 · 사이클9 · 테마: 답변측 self-consistency (PAPER-GROUNDED)

- **무엇:** **Self-Consistency (arXiv:2203.11171 Wang et al. ICLR 2023) + Rating Roulette (arXiv:2510.27106 Haldar & Hockenmaier EMNLP 2025)** 적용 — 라이브 grounding reverify judge를 단일 샘플→k-샘플 합의로. `judgeConsensus(verdicts, mode)`(length>0 && every YES) + `verifyGroundingWithReverify`에 `reverifySamples`(clamp 1-5, 기본 1=back-compat); 3개 분기 각각 단일 reverify()→up-to-k 순차 호출(첫 false에 early-exit)→judgeConsensus. CLI 라이브 사이트(commands-ask :3598 main verdict, :3611 best-of resample confirm) k=3.
- **왜:** verifyGroundingWithReverify가 weak→grounded UPGRADE을 단일 judge 샘플로 결정 — Rating Roulette: judge intra-rater 신뢰도 낮음("almost arbitrary"). 노이즈 YES 하나가 weak를 grounded로 올리면 fabrication-floor 누출. k-샘플 unanimous fail-close = 엄격히 더 보수적(단일 PASS를 불일치 시 FAIL로만, 새 grounded 절대 admit 안 함). KIND=답변측 self-consistency(fire34 memory·35 retrieval·37 planning과 다름), **저-floor-risk(투표 집계 validation)**. 항상-켜진 ask 경로 유일하게 multi-sample 합의 없던 곳.
- **리뷰지점:** knowledge-recall.ts(judgeConsensus + reverifySamples 3분기)+index.ts·commands-ask.ts(k=3 2사이트). **maker=Sonnet / judge=Opus 4.8(Fable5 세션 내 미가용 fallback) PASS**: 3분기 모두 strictly-more-conservative 증명(k=3 grounded ⟹ sample#1=YES ⟹ k=1도 grounded → 새 grounded admit 불가); 실제-revert counterfactual로 비공허(consensus→verdicts[0]로 바꾸면 3분기 dissent 테스트 전부 grounded로 flip); early-exit outcome-equivalent + 에러 라우팅 불변(weak→ungrounded·low-coverage/value-check→base); 기본1 byte-identical(다른 caller 전부 k=1, 라이브 2사이트만 3). agent-core 1909·reflection-guard 1·lint 0.
- **리스크:** 낮음 — fabrication=0 STRENGTHEN(엄격히 보수적), 임계값 무변경, 에러/empty 경로 불변, 기본1 back-compat. 비용: weak/low-coverage/value-check 밴드에서 최대 3× judge 호출(밴드 한정·early-exit 완화 — 매 ask 아님). _mode는 현재 동일 reducer(문서용, future-divergence) — floor 무관. 정직한 backlog: CI-SC early-exit 합의(2511.12309)·per-claim judge 합의·band-width 적응 k. RATCHET: testFiles +0(+23 케이스), fabrication 0 STRENGTHEN, 신규: 답변 게이트 self-consistency. grounding floor 직접 강화.

## [cognition loop] fire 39 — 2026-06-13 · 사이클9 · 테마: 멀티에이전트 result-validation (PAPER-GROUNDED) — DEFERRED

- **무엇:** **MAST FM-2.3 task derailment + FM-3.2 incomplete verification (arXiv:2503.13657)** 시도 — council 합성 前 질문-관련성 게이트(screenOffTopicUtterances)로 off-topic peer 드롭(2-peer council은 outlier 스크린이 안 도는 유일 미가드 벡터). 메커니즘 건전(deny-only·majority-cap·fail-open·cross-script 가드·non-inert judge확인=합성 프롬프트에서 실제 제외). **그러나 DEFERRED**: 슬라이스 revert + backlog 블로커.
- **왜 DEFER:** SIGNAL이 부적합 — lexical 질문↔reasoning 토큰겹침이 정직한 SAME-SCRIPT 패러프레이즈/동의어 peer를 false-drop(judge: 현실적 KO+EN on-topic peer 5/5 드롭; 결정적 사례 — 올바른 패러프레이즈 "임대료 125만원"은 드롭, 표면토큰 흉내낸 틀린 숫자 "월세 130만원" peer는 KEEP). 한국어 교착어 토큰화상 동의어는 구조적으로 0겹침. 정직한 dissent 침묵 = 실 harm(downstream 게이트가 fabrication=0은 지켜도). cross-SCRIPT는 dominantScriptFamily로 이미 가드했으나 same-script 패러프레이즈는 못 함.
- **리뷰지점:** 슬라이스 전체 revert(council.ts/index.ts/테스트 HEAD 복원), docs만 커밋. **★ESCALATE: 2연속 council-screening defer(fire36 injection + fire39 relevance) 동일 root** — lexical/pattern 신호가 Muse 다국어+패러프레이즈 콘텐츠를 over-screen. 언블로킹 전제 = council 경로에 embedding-cosine 의미유사도 primitive(질문↔reasoning, peer↔peer)를 먼저 깔기(임베더가 council 경로에 아직 안 붙음); 그 위에서 relevance/injection/outlier 스크린이 prose-safe하게 동작. 그 전엔 lexical council-screening 슬라이스 금지.
- **리스크:** 없음(슬라이스 미적용, 트리 HEAD와 동일). 교훈(fire28/34/36/39 누적): lexical/공유-패턴 신호를 다른 입력분포(다국어·model-prose·패러프레이즈)에 쓰면 양방향 miscalibrate — 의미유사도(임베딩)가 정답. maker≠judge(Opus, Fable5 세션 미가용)가 5/5 false-drop을 실증해 정직-peer-드롭 회귀를 차단. **사이클10 방향(스스로): council-screening OFF(semantic primitive 깔기 전까지); 임베딩 의미유사도 인프라 슬라이스 또는 council 아닌 신규 영역(recall/orchestration/verification 비-lexical).** RATCHET: 코드 무변동(defer), fabrication 0 유지, backlog 연구된 블로커 +2(relevance defer + root-cause escalate). grounding floor 무관.
