# Loop digest — 무인 루프가 매 fire 남기는 이해 체크포인트

> comprehension-debt 가드(harness 루프-엔지니어링 §3-2). 진안이 머지 전 읽는 곳.
> 한 fire = 4줄: 무엇 / 왜 / 리뷰지점 / 리스크. 3 fire마다 리뷰 관문.
> 각 fire 헤더에 `(skill vX.Y.Z)` 스탬프 — 나중에 fire 결과 ↔ 스킬 버전 대조용
> ([loop-creator CHANGELOG](../../.claude/skills/loop-creator/CHANGELOG.md)).
> 이력: fire 1–2 = v1.5.1 · fire 3(리뷰 관문) = v1.6.0 산출 · fire 4+ = v1.6.0.

---

## fire 1 — 2026-06-12 · 테마: TOOL expansion & hardening

- **무엇:** `muse.tasks.update` 툴에 `groundedArgs: ["notes"]` 추가 (+ 선언 검증 단위테스트).
- **왜:** update의 free-text `notes`가 anti-fabrication 경계 밖이라, 8B가 사용자가 말 안 한 notes를 지어내 디스크에 저장 가능했음(tasks add·calendar는 이미 보호). 그라운딩 엣지 확장.
- **리뷰지점:** `packages/mcp/src/loopback-tasks.ts`(update 툴 def 한 줄) + `packages/mcp/test/tasks-reminders-tool-schema.test.ts`(테스트). 게이팅 검증자(Opus)가 런타임 경로 추적해 PASS — `agent-runtime.ts:857-860`이 groundedArgs를 generic하게 적용하므로 선언으로 충분.
- **리스크:** 테스트가 *선언*만 검증(드롭 *동작*은 공유 메커니즘+상류 테스트가 보장). projection 배선 회귀는 이 테스트가 못 잡음. `title`은 의도적으로 ungrounded(rename 의도). 빌드/테스트(mcp 1655)·lint 0.

## fire 2 — 2026-06-12 · 테마: TOOL expansion & hardening

- **무엇:** `add_contact` 툴에 `groundedArgs: ["relationship"]` 추가 (+ 선언 검증 테스트).
- **왜:** contacts add의 free-text `relationship`("doctor"/"manager")가 anti-fabrication 경계 밖 — "Bob 추가해" 했는데 8B가 관계를 지어내 저장 가능. tool-arg grounding 항목의 다음 actuator(fire 1 tasks.update에 이어).
- **리뷰지점:** `packages/mcp/src/contacts-tool.ts`(한 줄) + `packages/mcp/test/contacts-tool.test.ts`. 게이팅 검증자(Opus)가 *다른 등록 경로*(직접 MuseTool, MCP loopback 아님)를 추적해 확인 — `toModelTool`(tools/index:385)이 groundedArgs를 carry, `agent-runtime:857-859`이 적용. inert 아님.
- **리스크:** fire 1과 동일(선언 테스트, 드롭 동작은 공유 메커니즘 보장). `name`은 required라 ungrounded. vision-auto(`commands-ask:2573`)는 결정적 추출 경로라 위협모델 밖. mcp 1656·lint 0.

> ⚠️ **다음 fire(fire 3) = 리뷰 관문.** 빌드 멈추고 fire 1–2 누적 다이제스트를 진안이 머지 전 읽도록 요청.

## fire 3 — 2026-06-12 · 리뷰 관문 + 루프 자기개선

- **무엇:** fire 1–2 리뷰 관문에서 진안이 평가 → 루프 4개 약점을 계약·스킬에 가드로 박음(§4.5): ①가치 우선(검증 쉬운 것 아님, defer는 명시) ②다양성(같은 패턴 반복 금지) ③행동 acceptance(선언-only 테스트 금지) ④토큰(배칭+리스크-티어) ⑤실패 드릴. + **fault-injection 드릴 실행**.
- **왜:** 2 fire가 *기계*는 잘 돌았지만 *산출*이 저야망(같은 마이크로 패턴·선언-only 테스트·비싼 토큰·실패 경로 미검증). 메커니즘 신뢰를 위해 실증 필요.
- **리뷰지점:** `loop-engineering.md §4.5`(가드) + `SKILL.md` ②③④b. **드릴 증거:** 고의 inert 슬라이스(tasks add에 스키마에 없는 `category` grounding) 주입 → Opus 게이팅 검증자가 **VERDICT: FAIL**(inert·행동테스트 없음·기존 테스트 깸 3축) → `git restore` 롤백 → mcp 1656 green 복구.
- **리스크:** 4개 가드는 *프롬프트 지시*라 다음 fire들이 실제로 따르는지는 라이브에서만 확인됨(드릴로 ④b는 실증). 드릴은 1회(반복 드릴은 토큰).

## fire 5 — 2026-06-12 · 회귀 수정 (skill v1.8.0)

- **무엇:** main의 실패 테스트 `program.test.ts > pluralises 'day' (goal 129)`를 고침 — 하드코딩 날짜(2026-05-13~15)를 `daysAgoIso(n)` 상대 날짜로.
- **왜:** 회귀-우선 규칙(①). `muse routine` window가 `Date.now()-30d`(commands-routine.ts:122, 주입 불가)라 하드코딩 날짜가 시간 흘러 window 밖으로 밀려나 0세션 → "across 1 day" 기대가 깨짐. **production pluralise 코드는 정상**(line 147), brittle 테스트가 원인.
- **리뷰지점:** `apps/cli/test/program.test.ts`만 변경(tsIso 값만). 어설션 불변. 게이팅 검증자(Opus)가 "테스트 약화 게이밍 아닌가" 적대 판정 → UTC 날짜 카운팅·off-by-one 없음 확인 PASS.
- **리스크:** 동종 시간-폭탄 테스트가 더 있을 수 있음(다른 하드코딩 날짜). cli 2492 green·lint 0. (별개 flake: chat-grounding "fails soft" 5s 타임아웃 — 이번엔 통과, 미해결.)

## fire 6 — 2026-06-12 · 신호 scout 하드닝 (skill v1.8.1)

- **무엇:** 신호 scout(`run-log-analysis.ts`)가 **빈-답(non-answer) ungrounded를 실패로 안 세도록** 제외 + 스크립트가 answer 추출.
- **왜:** 가치-우선으로 scout의 #1 발견(browser-read ungrounded ×7)을 잡았더니 **dev 노이즈**였음 — 2026-06-11 내 브라우저 테스트의 빈 답(tools []). 막 만든 발굴 도구의 #1이 노이즈면 신뢰 불가 → 도구 자체를 고침(diversity: fire 5와 다른 KIND).
- **리뷰지점:** `apps/cli/src/run-log-analysis.ts`(isFailureEvent: success===false 먼저 short-circuit, 그 후 ungrounded+빈답만 제외) + test 3건 + `scout-signals.mjs`(answer 추출). **end-to-end 증명:** 실데이터 재실행 1 클러스터 → **0 클러스터**(노이즈 제거) + "clean board → tier 2" 메시지로 3단 사다리 작동. backlog의 노이즈 항목은 Dropped로 정정.
- **리스크:** 실패한 run(success:false)은 빈 답이어도 여전히 카운트(검증자 확인). 패러프레이즈 병합·실사용 vs 합성 트레이스 구분은 future. cli 2495·lint 0.
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

> ✅ **리뷰 관문 CLEARED (2026-06-12, 진안):** fires 4–6 승인. **배치 머지됨 → 로컬 main `427193c3`**(branch+25 ↔ main+3 동시-루프 커밋, 3-way; loop-digest만 충돌→양쪽 보존; 머지 후 -r build clean + memory 355·agent-core 1703 green). push는 보류(진안이 origin). **fire 7 = 멀티에이전트 오케스트레이션(#3, 미착수 테마)** — MAST 실패모드(step repetition·reasoning-action mismatch·unaware-of-termination)를 council/MoA/harness 경계에서 결정적 가드. fires 7–9가 다음 리뷰 사이클.

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
