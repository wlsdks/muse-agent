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

## fire (TOOL loop) — 2026-06-12 · mac reader 슬라이스 GATE FAIL → 롤백 (skill v1.9.0)

- **무엇:** `mac_reminders_read` 빌드했으나 ④b 게이팅 검증자 **VERDICT: FAIL** → `git restore` 롤백. backlog에 블로커.
- **왜:** 가치-우선으로 mac readers(새 역량) 선택, 기존 injectable-runner로 mock 행동검증(8 테스트, build green). 하지만 도구를 `actuator-tools.ts`(모델-노출 셋)에 **미배선 = inert** — 모델이 선택 못 함(tool-calling.md "선택 안 되면 전달 안 됨"). eval:tools 케이스도 없음.
- **리뷰지점:** 롤백돼 코드 변경 0(macos 66 tests 원복). backlog mac 항목에 블로커: **다음 슬라이스 = reader + actuator-tools.ts 배선 + eval-tool-selection.mjs 골든 케이스**(완전체).
- **리스크:** 없음(롤백). 교훈: "새 도구" 슬라이스 = 정의만 아니라 **배선+eval 선택 케이스까지**. 게이팅 검증자가 *test-green이지만 inert*를 잡음 — 정상 fire 첫 진짜 FAIL, "verifier you trust" 실증.

## fire (TOOL loop) — 2026-06-12 · mac Reminders read — COMPLETE (배선+eval), gate PASS (skill v1.9.0)

- **무엇:** `mac_app_read`에 `reminders` SOURCE 추가(새 도구 아님 — 작은-셋 규칙). osascript가 미완료 리마인더 title/due 읽음. 5 행동 테스트(fake runner) + eval:tools 골든 2건(EN+KO).
- **왜:** 직전 fire의 INERT 실패(미배선 별도 도구) 교훈을 적용 — Option A로 *이미 배선된* mac_app_read의 enum을 확장하니 배선 0 + 모델이 즉시 선택 가능. 가치-우선 mac readers의 첫 앱(Reminders) 완성.
- **리뷰지점:** `packages/macos/src/macos-tools.ts`(source enum+buildReadScript+parseReadOutput case+desc/keywords) + test 5건 + `scripts/eval-tool-selection.mjs` 2 케이스. 게이팅 검증자(Opus)가 **built dist의 enum에 reminders 실재** 확인(inert 아님) + read-risk(mutation 없음) + 무회귀(70/70).
- **리스크:** Calendar/Notes source는 아직(다음 fire, 같은 패턴). 리마인더 list 많으면 osascript 느릴 수 있으나 30s watchdog 캡. backlog: Reminders DONE, Calendar/Notes REMAINING.

## fire (TOOL loop) — 2026-06-12 · mac Calendar+Notes read (배칭) — mac readers DONE, gate PASS (skill v1.9.0)

- **무엇:** `mac_app_read`에 `calendar`(오늘 일정)+`notes`(최근 제목) source 2개를 **배칭**으로 추가(reminders 패턴 미러링). 8 행동 테스트 + eval 골든 4건(EN+KO). mac readers 3앱 완성.
- **왜:** backlog가 "Calendar/Notes는 같은 패턴 다음 슬라이스"라 명시 → 동종이라 **배칭 가드**로 한 fire에(토큰 절약, 2 fire→1). 직전 reminders 완전체 패턴 재사용.
- **리뷰지점:** `macos-tools.ts`(enum+script+parse+desc, calendar/notes case) + test 8건 + eval 4건. 게이팅 검증자(Opus, 리스크-티어 가볍게 — 검증된 경로 반복)가 둘 다 enum 도달·read-only(mutation 없음 정밀 확인)·무회귀(78/78) PASS.
- **리스크:** 캘린더 많으면 osascript 느릴 수 있으나 today 필터+30s watchdog. notes는 body 아닌 title만(거대 방지). mac readers 항목 Done → 다음 fire는 다른 KIND(다양성).

## fire (TOOL loop) — 2026-06-12 · tool-arg grounding: followup.cancel.reason, gate PASS (skill v1.9.0)

- **무엇:** `followup.cancel`의 optional free-text `reason`에 `groundedArgs: ["reason"]` 추가. 행동 드롭 테스트(조작 reason 드롭/진술 reason 유지, groundToolArguments 직접) + 선언 테스트.
- **왜:** 다양성 가드(최근 3=mac readers)로 다른 KIND. reminders 타겟이었으나 **fabricable free-text 필드 없음**(text/dueAt/recurrence) → 정직히 next-best(followup.cancel)로 피벗. anti-fabrication floor를 actuator 하나 더 확장.
- **리뷰지점:** `loopback-followups.ts`(한 줄) + agent-core 행동 테스트 2건 + mcp 선언 테스트. 게이팅 검증자(Opus)가 followup.cancel을 tasks/contacts와 동일 경로(agent-runtime:857-859)로 추적 — inert 아님. reason은 서버 기본값 fallback이라 드롭돼도 안전.
- **리스크:** 없음. mcp 1667·agent-core 1705·lint 0. 남은 actuator free-text 감사는 다음 fire 후보(또는 다른 KIND).

## fire (TOOL loop) — 2026-06-12 · per-tool not-when: followups family, gate PASS (skill v1.9.0)

- **무엇:** `followup` 3도구(list/cancel/snooze)에 "use when / NOT when" 클로즈 추가 — followup을 tasks/reminders와 디스앰비그(followup=에이전트 자동 캡처 thread, 사용자 항목 아님). + eval:tools `buildFollowupScenario`(6 positive + 4 disambiguation).
- **왜:** TOOL 테마 얇아진 가운데, followups가 **유일하게 not-when 0개 패밀리** = 8B 오선택 위험 최고 → value-first. 다른 KIND(설명/선택 하드닝, groundedArgs·mac 아님).
- **리뷰지점:** `loopback-followups.ts`(설명만) + `eval-tool-selection.mjs`(시나리오+main 배선). 게이팅 검증자(Opus)가 disambig 케이스 변별력·배선·expectTool 실재 확인 — 선택-변경의 행동 acceptance=eval:tools(tool-calling.md). 코드 behavior 무변경.
- **리스크:** 라이브 eval:tools 미실행(Ollama 필요, CI/smoke:live가 돌림) — 케이스는 golden 자산. mcp 1667·lint 0.
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

## fire (TOOL loop) — 2026-06-12 · web_download post-redirect SSRF re-check (EXPANSION-scouted), gate PASS (skill v1.9.0)

- **무엇:** `web_download`가 redirect 후 최종 `response.url`을 SSRF 재검사 안 하던 구멍을 닫음 — fetch 후·디스크 쓰기 전 assertPublicHttpUrl 재적용(형제 web-read/fetch-readable-url 미러링). 행동 테스트(메타데이터로 redirect→refused+미기록).
- **왜:** TOOL backlog 얇음 → 3단 사다리의 **EXPANSION gap-scout**가 진짜 보안 갭 발굴(busywork 아님). public→사설 redirect로 메타데이터/내부호스트 도달해 디스크 기록되던 실제 SSRF.
- **리뷰지점:** `web-download-tool.ts`(재검사 4줄, 쓰기 전·fail-closed) + `.test.ts`(redirect→private 케이스). 게이팅 검증자(Opus, security-grade full)가 순서·fail-closed·형제일치·happy-path·STABLE 3/3 확인 PASS.
- **리스크/잔여:** production lookup 미배선이라 sync-only(리터럴 사설IP는 잡고 DNS-rebinding은 못 잡음) — 기존 가드와 동일, 새 ◦로 backlog 기록. mcp 1668·lint 0.

## fire (TOOL loop) — 2026-06-12 · DNS-rebinding SSRF closed (FAIL→test-fix→re-PASS), gate PASS (skill v1.9.0)

- **무엇:** web_download/web_action의 `deps.lookup ? async : sync` 우회 제거 → 항상 async 가드(defaultLookup=node dns가 resolve+체크) → no-lookup production 경로도 DNS-rebinding(public-name이 private IP로 resolve) 차단. hermetic 테스트(주입 privateLookup + dns-stub no-lookup).
- **왜:** 직전 SSRF fire가 surface한 잔여 ◦(value-first 보안). sync 가드는 리터럴 사설IP만 잡아 rebinding 무방비였음.
- **리뷰지점:** `web-download-tool.ts`·`web-action-tool.ts`(우회 제거)·`run-actuator-by-name.ts`(lookup 배선) + 테스트들. **2-단계 게이트:** 1차 Opus가 가짜 테스트(NXDOMAIN 의존, rebinding 아님) FAIL → 테스트를 hermetic(주입 privateLookup + dns-stub)으로 고침 → 2차 Opus가 **bypass 재도입해 no-lookup 테스트 FAIL 확인**(진짜 변별) 후 PASS.
- **리스크:** 없음. production이 이제 매 web fetch에 실DNS lookup(보안 위해 수용). mcp 1670·lint 0. 교훈: production 옳아도 *테스트가 OUTCOME을 증명*해야 통과(behavioral acceptance).

## fire (TOOL loop) — 2026-06-12 · loopback-filesystem symlink-escape closed, gate PASS (skill v1.9.0)

- **무엇:** MCP filesystem 서버의 allowlist가 lexical-only라 symlink 탈출(/allowed/x→/etc/passwd) 가능하던 것을, `checkAllowed`에 realpath 2차 게이트 추가(path·root 둘 다 realpath, 실경로가 root 밖이면 refuse, throw/ENOENT면 fail-closed) read/list/stat 전부.
- **왜:** EXPANSION scout runner-up(value-first 보안, SSRF와 다른 벡터=경로/symlink). file_read엔 realpath 가드 있었으나 MCP 변종엔 없던 갭.
- **리뷰지점:** `loopback-filesystem.ts`(checkAllowed async 2-게이트 + injectable realpath) + 신규 test 8건. 게이팅 검증자(Opus full)가 escape 차단·boundary 정확·**optional realpath 구멍 아님**(production 항상 default realpath, caller grep 확인)·macOS /var 대칭·무회귀 PASS.
- **리스크:** realpath→read TOCTOU 잔여(모든 realpath 가드 공통, 회귀 아님). mcp 1678·lint 0.
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

## fire (TOOL loop) — 2026-06-13 · mac_screenshot arbitrary-write closed (FAIL→fix→re-PASS), gate PASS (skill v1.9.0)

- **무엇:** `mac_screenshot`의 무가드 `path`(임의 파일 덮어쓰기)를 닫음 — allowlist(~/Desktop·Downloads·tmp) + ~확장 + basename + parent realpath + **full-target realpath**(symlink-at-target 거부, fail-closed, runner 미호출). 6 행동 테스트.
- **왜:** EXPANSION scout가 "유일하게 남은 무가드 WRITE 경로"로 발굴(최고 severity 파괴적 write). 보안 sweep 마지막 항목.
- **리뷰지점:** `macos-tools.ts`(resolveScreenshotPath + injectable realpath) + test 6건. **2-단계 게이트:** 1차 Opus가 *silent* symlink-at-target 잔여(직전 fire 77004a6f가 닫은 class 재도입) FAIL → full-target realpath로 닫음 → 2차 Opus가 변별·무회귀 확인 PASS.
- **리스크:** realpath→write TOCTOU 잔여(모든 realpath 가드 공통). macos 83·lint 0. 보안 sweep(SSRF×2·symlink·write) 완료 → 다음 fire는 다른 KIND.
## fire (TOOL loop) — 2026-06-12 · web_download post-redirect SSRF re-check (EXPANSION-scouted), gate PASS (skill v1.9.0)

- **무엇:** `web_download`가 redirect 후 최종 `response.url`을 SSRF 재검사 안 하던 구멍을 닫음 — fetch 후·디스크 쓰기 전 assertPublicHttpUrl 재적용(형제 web-read/fetch-readable-url 미러링). 행동 테스트(메타데이터로 redirect→refused+미기록).
- **왜:** TOOL backlog 얇음 → 3단 사다리의 **EXPANSION gap-scout**가 진짜 보안 갭 발굴(busywork 아님). public→사설 redirect로 메타데이터/내부호스트 도달해 디스크 기록되던 실제 SSRF.
- **리뷰지점:** `web-download-tool.ts`(재검사 4줄, 쓰기 전·fail-closed) + `.test.ts`(redirect→private 케이스). 게이팅 검증자(Opus, security-grade full)가 순서·fail-closed·형제일치·happy-path·STABLE 3/3 확인 PASS.
- **리스크/잔여:** production lookup 미배선이라 sync-only(리터럴 사설IP는 잡고 DNS-rebinding은 못 잡음) — 기존 가드와 동일, 새 ◦로 backlog 기록. mcp 1668·lint 0.

## fire (TOOL loop) — 2026-06-12 · DNS-rebinding SSRF closed (FAIL→test-fix→re-PASS), gate PASS (skill v1.9.0)

- **무엇:** web_download/web_action의 `deps.lookup ? async : sync` 우회 제거 → 항상 async 가드(defaultLookup=node dns가 resolve+체크) → no-lookup production 경로도 DNS-rebinding(public-name이 private IP로 resolve) 차단. hermetic 테스트(주입 privateLookup + dns-stub no-lookup).
- **왜:** 직전 SSRF fire가 surface한 잔여 ◦(value-first 보안). sync 가드는 리터럴 사설IP만 잡아 rebinding 무방비였음.
- **리뷰지점:** `web-download-tool.ts`·`web-action-tool.ts`(우회 제거)·`run-actuator-by-name.ts`(lookup 배선) + 테스트들. **2-단계 게이트:** 1차 Opus가 가짜 테스트(NXDOMAIN 의존, rebinding 아님) FAIL → 테스트를 hermetic(주입 privateLookup + dns-stub)으로 고침 → 2차 Opus가 **bypass 재도입해 no-lookup 테스트 FAIL 확인**(진짜 변별) 후 PASS.
- **리스크:** 없음. production이 이제 매 web fetch에 실DNS lookup(보안 위해 수용). mcp 1670·lint 0. 교훈: production 옳아도 *테스트가 OUTCOME을 증명*해야 통과(behavioral acceptance).

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
## fire (TOOL loop) — 2026-06-13 · 정직 보고 + backlog hygiene (skill v1.9.0)

- **무엇:** 비싼 build 대신 "둘 다 마르면 정직 보고" 티어 실행 — backlog의 중복 항목(이전 fire들이 PROGRESS 추가하며 남긴 `(orig)` 짝)을 정리하고 TOOL 테마 상태를 정직 기록.
- **왜:** self-eval green·신호 scout clean(0)·보안 sweep 완료(scout가 입력경계 hardened 확인). 남은 ◦는 not-when/groundedArgs의 incremental 연속뿐 = 고가치 슬라이스 고갈. 가짜 일감 만들기 금지 → 정직 보고가 이번 fire의 산출.
- **리뷰지점:** `backlog.md`(not-when `(orig)` 제거, tool-arg grounding 2항목→1 통합, done-list 정리). 코드 변경 0. (origin 대비 미머지 0 — 진안이 비동기 머지 중, non-blocking 설계대로.)
- **리스크:** 없음. **추천: TOOL 고가치 벤이 말라 새 테마 필요** — 계속 같은 테마면 marginal increment(spotlight query-cap, web_download content-type 등)만 나옴. 다음 fire는 다양성 가드로 그 incremental 중 하나 또는 새 테마.

## fire (TOOL loop) — 2026-06-13 · mac wifi_status read (capability), gate PASS (skill v1.9.0)

- **무엇:** `mac_app_read`에 `wifi_status` shell-read source — "와이파이 연결됐어? 어떤 네트워크?"에 답. networksetup(-listallhardwareports→device, -getairportnetwork→파싱) read-only. 행동 테스트(연결/미연결) + eval 읽기-vs-쓰기 디스앰비그.
- **왜:** 보안 벤 고갈 후 capability scout가 발굴 — `mac_system_set`은 wifi 토글만 있고 read 없던 write/read 비대칭(calendar/notes 때와 같은 갭 패턴). value-first 역량·다른 KIND(보안 아님).
- **리뷰지점:** `macos-tools.ts`(parseWifiStatusOutput + wifi_status 브랜치, parseWifiDevice 재사용) + test 2건 + eval 5건. 게이팅 검증자(Opus)가 enum 도달·read-only(-setairportpower는 mac_system_set에 그대로)·읽기/쓰기 디스앰비그·무회귀 PASS.
- **리스크:** 없음. macos 85·lint 0. **scout 정직 노트: 표면 이제 broadly capable → 다음은 테마 전환 권장**(남은 capability 갭은 niche/live-only).

## fire (TOOL loop) — 2026-06-13 · mac ip_address + running_apps reads (배칭) — reader 표면 완성, gate PASS (skill v1.9.0)

- **무엇:** `mac_app_read`에 `ip_address`(shell: ipconfig getifaddr) + `running_apps`(osascript: System Events) source 2개 배칭. 8 행동 테스트 + eval 4건. capability scout의 마지막 niche 갭 2개 소진.
- **왜:** real-but-niche 역량(가짜 일감 아님 — busywork 가드는 *지어낸* 일감 금지지 niche 금지가 아님). 진안이 계속 firing = 루프 생산 유지 원함. ip_address는 wifi와 같은 networksetup 패턴이라 배칭.
- **리뷰지점:** `macos-tools.ts`(parseIpAddressOutput shell 브랜치 + running_apps osascript case, parseWifiDevice 재사용) + test 8 + eval 4. 게이팅 검증자(Opus)가 enum 도달·read-only(set은 로컬 문자열)·무회귀 PASS.
- **리스크:** ip_address는 Wi-Fi 디바이스만(Ethernet 제외, 스펙대로). macos 94·lint 0. **mac reader 표면 완성** — capability 갭 소진.
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


## [TOOL loop] fire 1 (v1.10.0, cron 23eff34a) — 2026-06-13 · 테마: TOOL expansion & hardening

- **무엇:** notes 패밀리 도구선택 커버리지(eval:tools buildNotesScenario 6케이스) + save/append 설명에 use-when/NOT-when 절. 부수로 main의 사전존재 회귀 2건 청소: scout raw-NUL byte-hygiene, SSRF-가드 fallout(web_action reserved-TLD 호스트 테스트 4건).
- **왜:** notes는 not-when 0개 + eval 부재였고, RED 베이스라인(live gemma4 3런)이 실제 save-vs-append 혼동(KO 노트 쓰기 → append 0/3 instead of save)을 드러냄 → 절 추가로 GREEN 12/12 STABLE 3/3. 회귀 2건은 pnpm check가 red여서(quick self-eval은 못 잡음) 커밋 전 필수 정리 — 회귀-우선 원칙.
- **리뷰지점:** loopback-notes.ts(save/append 설명) + eval-tool-selection.mjs(buildNotesScenario+등록) / run-log-analysis.ts:85(raw NUL을 backslash-u0000 escape로) / actuator-tools.ts·commands-approvals.ts(optional lookup DI seam)+테스트 4건. Fable-5 게이팅 검증자 PASS(SSRF: production은 lookup 미주입 → defaultLookup → 가드 무손상; notes 케이스 discriminating + 미과적합). 3 게이트 green: check 0·lint 0·eval notes 12/12.
- **리스크:** buildNotesScenario의 cases.filter(byName.has)는 도구명 drift 시 케이스를 조용히 드롭(검증자 비차단 노트). 남은 not-when 타깃: messaging/episodes/context. grounding floor 무관(설명·테스트·회귀픽스만, 게이트 로직 무변경).


## [TOOL loop] fire 2 (v1.10.0, cron 23eff34a) — 2026-06-13 · 테마: TOOL expansion & hardening

- **무엇:** @muse/calendar의 두 파일 스토어(LocalCalendarProvider, FileCalendarCredentialStore)에 quarantine-on-corrupt 도입 — 손상 파일을 조용히 비우는 대신 <file>.corrupt-<ts>로 보존. 공유 헬퍼 corrupt-quarantine.ts 1개를 4개 corrupt 분기에서 호출.
- **왜:** 손상(파싱실패/스키마불일치) 읽기가 빈 결과를 반환 → 다음 atomic 쓰기가 손상-하지만-복구가능한 원본을 영구 덮어씀 = 데이터 손실. sibling reminders-store는 이미 quarantine. 쓰기는 이미 atomic이라 빠진 건 quarantine뿐.
- **리뷰지점:** corrupt-quarantine.ts(신규 헬퍼) + local-provider.ts readAll(parse catch + events 비배열 분기) + credential-store.ts readAll(스키마불일치 + catch). TDD 3건 RED 3/3 → GREEN, calendar 152, check 0, lint 0. Fable-5 검증자 PASS(ENOENT/transient-IO는 미quarantine, predicate 불변=엄격히 더 안전, rename이 0600 보존, 동시성 안전). 부수로 fire-1 backlog write-back이 박은 raw NUL(backlog.md:63) 제거 — byte-hygiene 회귀.
- **리스크:** local-provider의 per-entry isPersistedEvent flatMap은 여전히 *개별* 손상 이벤트를 조용히 드롭(부분 손실, 로그 없음) — 범위 밖 별도 슬라이스로 backlog 기록. .corrupt-* 파일은 GC 안 됨(복구 자료, 설계상). grounding floor 무관(로컬 디스크 무결성, 모델/egress/게이트 무변경).
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


## [TOOL loop] fire 3 (v1.10.0, cron 23eff34a) — 2026-06-13 · 테마: TOOL expansion & hardening

- **무엇:** chat 경로의 embedder 마이그레이션 누락 수정 — refreshStaleNotesIndexForChat가 CONTENT 변경만 보고 early-return해, chat-only 사용자(desktop은 ask 안 함)의 레거시 v1 인덱스가 영영 v2-moe 쿼리와 mismatch. 모델 불일치도 staleness 트리거로.
- **왜:** v2-moe 쿼리 벡터를 v1 인덱스에 매칭 = cross-model cosine 노이즈가 0.5 authoritative floor 위로 떠 recall 품질 저하(grounding 품질 버그). ask는 재임베드하지만 chat은 안 했음.
- **리뷰지점:** chat-grounding.ts — 순수 헬퍼 notesIndexNeedsModelMigration(resolveIndexModel(existing,req)!=existing) + refreshStaleNotesIndexForChat을 export+DI deps화(staleness 게이트 前 모델 읽기, modelStale||contentStale로 재임베드). TDD 5(헬퍼 단위 1 + DI 행동 4: legacy-fresh→default 재임베드, default/custom-fresh→안함, content-stale→여전히 함) RED→GREEN. cli 2525, check 0, lint 0. Fable-5 검증자 PASS(매-턴 루프 없음·production 배선 live·fail-soft).
- **리스크:** embedder DOWN 중 model-mismatch 재빌드 시 reindexNotes가 prior-entry carry-forward 드롭 → 빈 인덱스 저장 가능(fail-close: zero hits→refusal, 날조 아님; 기존 경로). 별도 슬라이스로 backlog 기록. grounding floor 무관(인덱싱 경로, 게이트 로직 무변경).


## [TOOL loop] fire 4 (v1.10.0, cron 23eff34a) — 2026-06-13 · 테마: TOOL expansion & hardening

- **무엇:** muse.json.merge의 deepMerge 프로토타입 오염 수정 — 모델 args(JSON.parse)의 own "__proto__" 키가 result["__proto__"]= 할당으로 Object.prototype 셋터를 건드려 result 프로토타입 교체 + 상속 필드(isAdmin 등) 주입 + 키 소실. __proto__만 특수처리: getOwnPropertyDescriptor로 기존값 읽고 deepMerge 후 defineProperty로 own 데이터 prop 기록.
- **왜:** 모델-facing 도구 핸들러의 실제 프로토타입 오염 벡터. signal scout가 clean(0 cluster)이라 tier-2 codebase EXPANSION 스카우트(Fable-5)로 발굴. 큰 리팩터(#6 ask error-path)·architectural(calendar 암호화)·반복(not-when) 회피하고 작고 깨끗한 보안 슬라이스 선택.
- **리뷰지점:** loopback-json-server.ts deepMerge(__proto__ 분기) + mcp.test.ts(JSON.parse'd __proto__ overrides → 프로토타입 무손상 + 주입 필드 없음 + 키 데이터 보존) TDD 1 RED→GREEN. mcp 1679, check 0, lint 0. Fable-5 검증자 PASS(__proto__가 유일 셋터 벡터·constructor/prototype는 plain own·재귀 모든 깊이 보호). 부수로 #6/#7(big refactor)·calendar 암호화(architectural dep)를 ⏳ DEFERRED로 backlog 기록(WHY 명시).
- **리스크:** 없음에 가까움 — 정상 merge 의미 불변(키 strict 매칭), __proto__ 키를 충실히 데이터로 보존. grounding floor 무관(JSON 유틸 도구, 게이트 무변경). DEFERRED 2건은 다음 fire가 재선택 안 하도록 사유 기록.


## [TOOL loop] fire 5 (v1.10.0, cron 23eff34a) — 2026-06-13 · 테마: TOOL expansion & hardening

- **무엇:** muse.fs.stat의 symlink 계약 위반 수정 — 설명은 "symlink를 안 따르고 kind=symlink 보고"인데 fsLib.stat(따라감)을 써 절대 symlink로 못 냄. fs seam에 optional lstat 추가 + 기본 impl 배선 + 도구가 (fsLib.lstat ?? fsLib.stat) 사용.
- **왜:** 모델-facing 도구의 문서화된 계약이 충족 불가였음(symlink가 항상 target의 kind로 보고). fire-4 EXPANSION 스카우트의 runner-up. signal 보드 clean이라 codebase 갭.
- **리뷰지점:** loopback-filesystem.ts(lstat seam + 기본 + stat 도구 1줄) + loopback-filesystem.test.ts(lstat→isSymbolicLink → kind=symlink vs stat-follow → file) TDD 1 RED→GREEN. mcp 1680, check 0, lint 0. Fable-5 검증자 PASS(HEAD 샌드박스 컴파일로 RED 재현·realpath escape 가드 무손상·read/list 무변경). lexical path에 lstat이라 escape 가드는 stat 전에 이미 실행됨.
- **리스크:** read/list는 여전히 lexical path에서 symlink를 따름(설계상; realpath 가드가 escape 차단하나 symlink-swap TOCTOU 창 잔존 → 별도 슬라이스 backlog). runner-up atomicWriteFile tmp 누수 OPEN. grounding floor 무관(fs 메타 도구, 게이트 무변경).


## [TOOL loop] fire 6 (v1.10.0, cron 23eff34a) — 2026-06-13 · 테마: TOOL expansion & hardening

- **무엇:** atomicWriteFile(공유 sidecar-store 쓰기 프리미티브)의 tmp 누수 수정 — open→write→rename 중 어디서든 실패하면 <file>.tmp-<pid>-<uuid>가 고아로 남아 모든 sidecar 디렉터리(memory/tasks/reminders/action-log/…)에 litter 누적. open→write→rename→chmod를 try/catch로 감싸 실패 시 fs.rm(tmp,{force}) 후 원본 에러 rethrow.
- **왜:** 리소스 누수(디스크 litter) — fire-4/5 EXPANSION 스카우트의 마지막 runner-up. signal 보드 clean이라 codebase 갭.
- **리뷰지점:** atomic-file-store.ts(try/catch + rm) + atomic-file-store.test.ts(target=디렉터리→rename throw→rejection AND .tmp- 0개). TDD 1 RED→GREEN. mcp 1681, check 0, lint 0. Fable-5 검증자 PASS(HEAD 소스 swap으로 RED 재현·원본 에러 미swallow·UUID라 cross-writer race 없음). 비차단 노트: finally의 close()가 throw하면 writeFile 에러를 가릴 수 있음(기존 JS 의미, 본 수정과 무관).
- **리스크:** 없음에 가까움 — happy path 무변경, rm은 이 호출의 tmp만(UUID), force라 open 실패 시 no-op. grounding floor 무관(파일 IO 프리미티브, 게이트 무변경).
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
