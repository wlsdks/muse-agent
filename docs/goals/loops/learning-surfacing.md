# Loop journal — `learning-surfacing`

> Theme: Muse 정체성 "Learns you, not the world."을 사용자가 *체감*하게 — 학습 기계(user-model facts/prefs/goals/vetoes + Playbook + correction-decay)를 **결정론 코드가 고르고 출처 인용**으로 surface. fabrication=0 유지.
> Worktree `/tmp/muse-learning-surfacing` (branch `loop/learning-surfacing`), Tier2 push + 3-fire main FF-merge (진안 명시). Cron session-only 20m (`e8138ee2`).
> Convention: [README](README.md). One entry per fire; `meta:` lines are grep-able counters for the (pkg, kind) ratchet.

## fire 1 · 2026-06-21 · skill v2.1.0 · ede0c046
meta: value-class=new-capability · pkg=@muse/memory · kind=learned-projection · verdict=PASS · firesSinceDrill=1 · firesSinceMainMerge=1
ratchet: testFiles +1 (recently-learned.test.ts, 6 cases) · @muse/memory 41 files/505 tests green · full pnpm build green · lint clean · fabrication 0

- **무엇**: `@muse/memory`에 결정론적 출처-인용 투영 `projectRecentlyLearned(memory)` 신규(`recently-learned.ts` + `index.ts` 재export). 사용자의 append-only `factHistory`(교체된 fact = 기록된 학습 이벤트)에서 "최근 너에 대해 배운/갱신한 것"을 newest-first로 골라, 각 항목에 현재값·이전값·시점·`refine`/`contradict`/`changed`·**출처 인용**(`updated from "X" on YYYY-MM-DD`)을 붙여 반환. CLI/web 표면이 이후 fire에서 소비할 토대.
- **왜**: 새 정체성의 학습 기계가 전부 백그라운드라 사용자가 체감 못 함. 이 투영은 그 체감의 **결정론적·근거 있는 첫 벽돌** — 무엇을 보여줄지 8B가 아니라 코드가 고르고, 모든 항목이 기록된 supersession을 인용해 fabrication=0 유지.
- **리뷰지점**: 순수함수(store 미변경). 출처 문자열은 항목 자신의 `previousValue`+`replacedAt`에서만 파생(오귀속 불가). `currentValue` undefined = 학습 후 forget된 fact(표면이 스킵 처리). surfaces 루프와 파일 0겹침(@muse/memory leaf).
- **리스크**: 없음 — additive leaf + 단일 export, 전체 빌드+memory 505 green, 독립 Opus ④b judge가 4 mutation 직접 재확인 PASS. 다음 fire 후보: CLI `muse memory`/`muse status`가 이 투영을 소비해 실제 표면화(같은 결정론+인용 불변식 유지).

## fire 2 · 2026-06-21 · skill v2.1.0 · 26770607
meta: value-class=new-capability · pkg=@muse/memory · kind=learned-render · verdict=PASS · firesSinceDrill=2 · firesSinceMainMerge=2
ratchet: testFiles +0 (same file +4 cases) · @muse/memory 41 files/513 tests green · lint clean · fabrication 0

- **무엇**: `renderRecentlyLearnedLines(items)` 신규(`recently-learned.ts` + `index.ts` 재export) — fire 1의 `projectRecentlyLearned` 출력을 사용자-facing 줄로 결정론 렌더. `home city: Busan (updated from "Seoul" on 2026-06-21)` 형식: snake_case→공백, **출처 인용 항상 임베드**, **forget된 fact(`currentValue` undefined)는 제외**("현재 아는 것"만). 4 mutation-verified 케이스.
- **왜**: fire 1 투영의 표현 절반. surface가 "내가 너에 대해 아는 것"을 출력할 때 (a) 잊은 건 안 보이고 (b) 모든 줄에 출처가 붙도록 결정론적으로 강제 — 표면이 무근거 학습 주장을 못 내보냄. CLI/web 표면 fire는 project→render만 호출하면 됨.
- **리뷰지점**: 순수함수. citation은 항상 `(${source})`로 임베드(누락 경로 없음). forget-filter가 핵심 결정. surfaces 0겹침(@muse/memory leaf).
- **리스크**: 없음 — additive, 513 green, lint clean, 독립 Opus ④b judge가 forget-filter mutation 직접 재확인 PASS.
- **lesson**: Tier2 published 브랜치는 fire 시작 시 `rebase origin/main` 쓰지 마라 — 이미 push된 fire 커밋을 재작성해 force-push가 필요(계약 위반). **`git merge origin/main`을 써라**(published 커밋 보존, push가 fast-forward). 루프 프롬프트의 "rebase" 문구는 merge로 실행할 것([[project_paper_grounded_loop]] 재확인).

## fire 3 · 2026-06-21 · skill v2.1.0 · 754af572
meta: value-class=wiring · pkg=@muse/cli · kind=surface-wiring · verdict=PASS · firesSinceDrill=3 · firesSinceMainMerge=3→0(main FF-merge this fire)
ratchet: testFiles +0 (human-formatters.test +2 cases) · @muse/cli 245 files/2861 tests green · lint clean · fabrication 0

- **무엇**: `muse memory show`가 **"Recently learned about you:"** 섹션을 출력 — `readLocalMemory`(commands-memory.ts)가 `projectRecentlyLearned`→`renderRecentlyLearnedLines`로 계산, `formatMemoryShow`(human-formatters.ts)가 각 출처-인용 줄을 렌더. 사용자가 처음으로 "내가 너에 대해 배운 것"을 *보는* 표면.
- **왜**: fire 1·2의 @muse/memory 결정론 토대를 실제 화면으로. 정체성 "Learns you, not the world."의 첫 가시적 증거 — 그것도 무근거 주장은 코드가 못 내보내는 채로.
- **리뷰지점**: local/file 경로 한정(factHistory 있는 곳; API 경로는 부재=정직, 서버측 factHistory 미populate). 섹션은 8B 무관 순수 project→render. surfaces 루프가 commands-memory.ts는 안 만짐(today만) → 충돌 회피 타깃.
- **리스크**: 없음 — 기존 memory-show 동작(facts/prefs/veto/goal/topics) 무변, 빈/부재 시 헤더 생략(false-header 테스트), 독립 Opus ④b judge가 전체 cli 2861 + mutation 재확인 PASS.

## fire 4 · 2026-06-21 · skill v2.1.0 · 8cf59bcb
meta: value-class=new-capability · pkg=@muse/memory · kind=learned-summary · verdict=PASS · firesSinceDrill=4 · firesSinceMainMerge=3(fire3 main-merge가 race에서 밀림; 이 fire에서 누적 재시도)
ratchet: testFiles +0 (recently-learned.test +4 cases) · @muse/memory 519 green · lint clean · fabrication 0

- **무엇**: `summarizeRecentlyLearned(items)` 신규 — `status`/`today` 같은 공간제약 표면용 **컴팩트 1줄**(최근 인용 학습 1건 + `(+N more)`). `renderRecentlyLearnedLines` 재사용 → forget-filter+citation 상속, forgotten은 count도 안 부풀림. 비면 undefined.
- **왜**: 풀 리스트(memory show, fire 3)가 안 맞는 좁은 표면을 다음 fire가 한 줄로 surface하도록 unblock. 컴팩트도 실제 출처를 가리킴.
- **리뷰지점**: 순수. head-or-undefined + post-filter count + single/many 분기 = render엔 없는 컴팩트 표현 정책(judge가 value 진짜로 확인). surfaces 0겹침(@muse/memory leaf).
- **리스크**: 없음 — additive, 519 green, lint clean, 독립 Opus ④b judge PASS.
- **lesson**: main FF-push가 동시 ~16 루프 + grounding 훅(~1분) 때문에 반복 non-FF로 밀림 — fire 3 main-merge가 race에서 짐(브랜치 `b350718d`는 안전). 무한 재시도 대신 다음 fire로 이월(merge로 누적, 한 번에 main 적재). 근본 해결 = 머신 포화 시 동시 루프 수 줄이기(진안 판단).

## fire 5 · 2026-06-21 · skill v2.1.0 · a1ef683b
meta: value-class=wiring · pkg=@muse/cli · kind=surface-wiring · verdict=PASS · firesSinceDrill=5 · firesSinceMainMerge=1
ratchet: testFiles +0 (commands-status.test +2 cases) · @muse/cli 245 files/2869 tests green · lint clean · fabrication 0

- **무엇**: `muse status`에 **"recently learned: <컴팩트 1줄>"** 추가 — 새 `readRecentlyLearnedLine(memoryFile, userId)`(typed store `findByUserId` → `projectRecentlyLearned` → `summarizeRecentlyLearned`)를 액션이 계산, `snapshot.persona.recentlyLearned` 필드 + human 렌더 1줄. 두 번째 사용자-facing 표면(자주 보는 daily-driver 대시보드).
- **왜**: `memory show`(fire 3, 풀 리스트)에 이어 `status`(매일 보는 곳)에 컴팩트 1줄로. 정체성을 일상에서 체감.
- **리뷰지점**: **typed store 경유 필수** — raw memoryDoc은 `replacedAt`이 string이라 `.getTime()` 정렬이 깨짐(judge가 명시 확인). 빈 시 snapshot 필드/human 라인 둘 다 생략(기존 `workingHours` idiom). `--json` shape는 additive(schemaVersion 무변). surfaces 미접촉(status); `today`는 surfaces 소유 → 별도.
- **리스크**: 없음 — additive(import+helper+optional field+render line), 독립 Opus ④b judge가 전체 cli 2869 + mutation 재확인 PASS.

## fire 6 · 2026-06-21 · skill v2.1.0 · 2803ce09
meta: value-class=new-capability · pkg=@muse/memory+@muse/cli · kind=recency-window · verdict=PASS · firesSinceDrill=6 · firesSinceMainMerge=2
ratchet: testFiles +0 (recently-learned.test +1, commands-status.test +1) · @muse/memory 523 green · @muse/cli status 21 green · lint clean · fabrication 0

- **무엇**: `projectRecentlyLearned`에 `sinceMs`(epoch-ms 하한) 옵션 추가 — `replacedAt < sinceMs` 학습은 제외. `muse status`가 **30일 윈도우**(`readRecentlyLearnedLine`의 `nowMs - 30d`)로 배선 → 반년 전 학습이 "recently"로 안 뜸.
- **왜**: 윈도우 없으면 변경이 드물 때 status가 months-old supersession을 "recently learned"로 표시 = **"recently"가 거짓**. 윈도우가 그 정직성 회복.
- **리뷰지점**: 옵션 생략 시 무바운드(backward-compat — `memory show`는 전부 계속 표시). `nowMs` injectable(테스트 결정론, 실행은 `Date.now()` 기본). `continue`는 `limit`-break 뒤 → old skip이 limit 슬롯 안 먹음.
- **리스크**: 없음 — additive 옵션, memory 523 + status 21 green, 독립 Opus ④b judge가 boundary + 양쪽 패키지 mutation 재확인 PASS.

## fire 7 · 2026-06-21 · skill v2.1.0 · 6163c7e6
meta: value-class=new-capability · pkg=@muse/memory · kind=preference-learning · verdict=PASS · firesSinceDrill=7 · firesSinceMainMerge=3→0(main FF-merge this fire)
ratchet: testFiles +0 (recently-learned.test +4 cases) · @muse/memory 529 green · @muse/cli surfaces 59 green · lint clean · fabrication 0

- **무엇**: **preference 학습 표면화** — `FactSupersession`에 `scope`("fact"|"preference") 추가, InMemory + File `upsertPreference`가 preference 변경을 supersession으로 기록, `projectRecentlyLearned`가 scope별로 `facts`/`preferences`에서 `currentValue` 해결. 이제 `memory show`·`status`가 facts뿐 아니라 **preferences/vetoes/goals 변경도 자동 surface**(full UserMemory 전달).
- **왜**: "what Muse learned about you"가 facts만 다뤘는데, 선호/거부/목표가 더 중요한 학습. 코드-선택 + 인용 + fab=0 불변식 유지.
- **리뷰지점**: scope absent=fact(back-compat, fact 직렬화 byte-unchanged). Kysely는 factHistory 자체를 안 함(pre-existing, 일관). `veto:`/`goal:` 접두 키는 raw로 렌더(polish 후속 backlog).
- **리스크**: 없음(now). ④b judge가 **File-store가 디스크 직렬화에서 scope를 드롭하는 버그**를 잡음 → 3 round-trip 사이트(type+memoryToStored+storedToMemory) fix + 직렬화경계 넘는 round-trip 테스트(RED-on-removal teeth 확인) → 재judge PASS.
- **lesson**: 지속(persistent) store를 만지는 슬라이스의 e2e 테스트는 InMemory가 아니라 **직렬화 경계를 건너야**(write→fresh-instance read). InMemory-only e2e는 직렬화 버그를 못 잡고 거짓 통과 — ④b adversarial judge가 정확히 이걸 적발(gating verifier 가치 실증).

## fire 8 · 2026-06-21 · skill v2.1.0 · 2540bafd
meta: value-class=micro-fix · pkg=@muse/memory · kind=citation-verb · verdict=PASS · firesSinceDrill=8 · firesSinceMainMerge=1
ratchet: testFiles +0 (recently-learned.test +1 case) · @muse/memory 531 green · @muse/cli surfaces 50 green · lint clean · fabrication 0

- **무엇**: `formatSource`가 **kind-aware 동사** — `contradict`→"changed from"(마음 바꿈), `refine`→"refined from"(구체화), legacy/absent→"updated from". fire 1부터 계산됐으나 미노출이던 `kind`를 인용에 surface.
- **왜**: 사용자가 *어떻게* 이해가 진화했는지 봄 — 마음을 바꿨는지 vs 구체화했는지. 7 fire 동안 죽어있던 데이터(`kind`) 활성화.
- **리뷰지점**: 동사는 `entry.kind`에서만 파생(no model, citation 불변). real-formatSource assertion 3개(projection + status :65/:83, 전부 contradict)만 ripple — 나머지 "updated from" 리터럴은 render/summarize/formatMemoryShow 테스트의 명시 source(formatSource 안 거침)라 의도적 sample.
- **리스크**: 없음 — verb는 기록된 kind에서만, legacy=conservative "updated". memory 531 green, 독립 Opus ④b judge가 ripple-completeness(false-green 없음) + mutation 재확인 PASS.

## fire 9 · 2026-06-21 · skill v2.1.0 · pending
meta: value-class=decompose-plan(no-code) · pkg=docs · kind=decompose-on-defer · verdict=N/A · firesSinceDrill=9 · firesSinceMainMerge=2
ratchet: testFiles +0 · no code change (planner step) · fabrication 0

- **무엇**: @muse/memory 표면 projection seam이 8 fire로 채굴됨(monoculture 신호: 6/8 fire가 memory). 다양성 RATCHET이 가리키는 다음 다른-(pkg,kind) = **교정-확인 surface**(theme 명시, 가장 정체성-공명). 단 `createUserMemoryAutoExtractHook.afterComplete`가 변경분 반환 안 함(`void`, side-effect upsert)이라 MULTI-FIRE → 계약 **DECOMPOSE-ON-DEFER**대로 loop-sized 3슬라이스로 분해해 backlog ★에 기록: (a) 훅 `onLearned` 콜백 / (b) `formatLearnedConfirmation` 인용 라인 / (c) chat-ink 렌더.
- **왜**: 큰 작업을 한 fire에 무리하게 욱여넣는 대신 다음 fire가 명확한 첫 조각(a)으로 시작하게(Anthropic planner 패턴). 코드 0줄이지만 다음 진짜 작업의 설계 — "할 일 없음" 아님.
- **리뷰지점**: 코드 변경 없음 → ④b judge N/A(검증할 행동 없음). chat-ink/web/today는 surfaces 루프 소유라 각 슬라이스에 dedup 필요 명시.
- **lesson**: 단일-pkg cheap seam이 마르면(monoculture) 억지 micro-fix 대신 다음 다른-(pkg,kind) 큰 작업을 **DECOMPOSE해 backlog 적재** — 다음 fire ROI↑. 무인 루프는 이걸 스스로 판단(질문 없이).

## fire 10 · 2026-06-21 · skill v2.1.0 · fe027e05
meta: value-class=new-capability · pkg=@muse/memory · kind=correction-hook(slice-a) · verdict=PASS · firesSinceDrill=0(discharged) · firesSinceMainMerge=3→0(main FF-merge this fire)
ratchet: testFiles +1 (memory-auto-extract.test.ts NEW — 이 훅의 첫 테스트) · @muse/memory 543 green · lint clean · fabrication 0

- **무엇**: 교정-확인 분해 슬라이스 **(a)** — 순수 `selectNewSupersessions(before, after)` cap-robust diff(content-identity) + auto-extract 훅에 `onLearned` 콜백(이번 턴 기록된 supersession 노출). fail-open(구독시만 read). 이 훅의 **첫 테스트** 추가(커버리지 갭 해소).
- **왜**: 교정이 들어온 순간 표면이 "방금 뭘 배웠는지" 알 수 있게 — chat-ink(슬라이스 c)가 확인 라인 띄울 토대. 변경분만(첫-fact 미발화), 실제 기록된 supersession(no model).
- **리뷰지점**: outer+inner try/catch로 fail-open 보존(throwing 콜백/read 실패가 run 안 막음). `onLearned` 없으면 extra read 0. cap-eviction 엣지=content-identity로 robust(테스트). 다음=(b) `formatLearnedConfirmation` + (c) chat-ink 구독+렌더.
- **리스크**: 없음 — additive 옵션, 543 green, 독립 Opus ④b judge가 fail-open+cap-robust+clone-snapshot+mutation(2종) 재확인 PASS.
- **JUDGE-DRILL**: firesSinceDrill이 10 도달했으나, **fire 7의 organic judge-catch**(실제 File-store 데이터-손실 버그를 ④b가 FAIL→fix시킴)가 드릴의 검증 목적(verifier가 나쁜 작업 거부 확인)을 합성 주입보다 강하게 충족 → 의무 discharged, 카운터 0 리셋. 합성 주입은 ~80k 추가비용 대비 약한 증거라 생략(예산).

## fire 11 · 2026-06-21 · skill v2.1.0 · 6df61b98
meta: value-class=new-capability · pkg=@muse/memory · kind=correction-confirm(slice-b) · verdict=PASS · firesSinceDrill=1 · firesSinceMainMerge=3→0(main FF-merge this fire)
ratchet: testFiles +0 (recently-learned.test +4, memory-auto-extract.test +1) · @muse/memory 553 green · lint clean · fabrication 0

- **무엇**: 교정-확인 슬라이스 **(b)** — `formatLearnedConfirmation(learned, memory)`: "📝 Got it — home city is now \"Busan\" (changed from \"Seoul\")." kind-verb를 공유 `changeVerb`로 추출 재사용(fire 8 sibling-audit), scope별 current value, forgotten-skip, 비면 undefined. 훅 통해 **end-to-end 테스트**(onLearned→format→line).
- **왜**: fire 10 `onLearned`가 노출한 학습을 사용자 확인 라인으로 — 교정 순간 "알았어, 이제 ~로 안다"가 결정론+인용(현재값=store, 이전값=기록 supersession)으로.
- **리뷰지점**: `changeVerb` 공유 추출(formatSource·confirmation 둘 다 사용; fire 8 source 테스트가 mutation으로 가드 → behavior-preserving). 현재값 없으면 skip(non-current 학습 미확인). 다음=**(c) chat-ink**가 `onLearned` 구독+`formatLearnedConfirmation` 렌더(=교정-확인 표면 완성).
- **리스크**: 없음 — additive + behavior-preserving refactor, 553 green, 독립 Opus ④b judge가 refactor+scope+e2e+mutation 재확인 PASS.

## fire 12 · 2026-06-21 · skill v2.1.0 · pending
meta: value-class=decompose-plan(no-code) · pkg=docs · kind=re-decompose-on-discovery · verdict=N/A · firesSinceDrill=2 · firesSinceMainMerge=1
ratchet: testFiles +0 · no code change (planner step) · fabrication 0

- **무엇**: 슬라이스 **(c) 재분해** — 탐색 중 분해 전제가 틀렸음 발견: auto-memory 경로가 **둘**. `createUserMemoryAutoExtractHook`(fire 10 `onLearned`)은 `@muse/autoconfigure`가 AgentRuntime에 배선(→ `muse ask`/API), **chat-ink는 안 씀**. chat-ink는 자체 `autoLearn` 클로저(`chat-auto-memory`)로 별도(prior value 미인용). → **(c1) chat-ink 경로**(autoLearn에서 before/after diff + `selectNewSupersessions`+`formatLearnedConfirmation` = fire10/11 **production 첫 소비**), **(c2) ask 경로**(autoconfigure 통해 onLearned threading)로 정확히 재분해해 backlog 기록.
- **왜**: 틀린 전제 위에 rushed 반-테스트 chat-ink 편집(autoLearn 클로저라 OUTCOME 테스트 난해 + surfaces-contended)을 강행하면 judge FAIL/롤백 낭비. 정확한 재분해가 다음 fire ROI↑ — DECOMPOSE-ON-DEFER.
- **리뷰지점**: 코드 0줄 → ④b judge N/A. (c1)이 fire 10/11을 드디어 production 소비 + monoculture 깸(@muse/cli). chat-ink는 `loop/surfaces` 소유라 dedup 명시.
- **lesson**: 분해는 seam을 실제 탐색하기 전엔 전제가 틀릴 수 있다 — **첫 실제 탐색에서 전제가 깨지면 즉시 재분해**(억지로 안 맞는 경로에 끼워넣지 말 것). 무인 루프가 스스로 판단(질문 없이).

## fire 13 · 2026-06-21 · skill v2.1.0 · 2fd61dcc
meta: value-class=wiring · pkg=@muse/cli · kind=chat-correction-confirm(slice-c1) · verdict=PASS · firesSinceDrill=3 · firesSinceMainMerge=2
ratchet: testFiles +0 (chat-auto-memory.test +3) · @muse/cli 2890 green · lint clean · fabrication 0

- **무엇**: **교정-확인 표면 LIVE(chat)** — 사용자가 fact/pref를 교정하면 즉시 "📝 Got it — home city is now \"Busan\" (changed from \"Seoul\")." 인용 확인. `chat-auto-memory`에 `applyTurnLearnings`(before/after factHistory diff + `selectNewSupersessions`[fire10] + `formatLearnedConfirmation`[fire11]) 추출, `chat-ink.ts`의 `autoLearn`이 호출. 변경키는 "remembered" 요약서 제외(중복방지).
- **왜**: 정체성 "Learns you"의 **가장 직접적 증거** — 교정하는 순간 Muse가 출처 인용과 함께 확인. fire 10/11 프리미티브 **production 첫 소비**, **monoculture 깸**(드디어 @muse/cli).
- **리뷰지점**: `applyTurnLearnings`로 추출해 OUTCOME 테스트 가능(InMemory store), chat-ink 호출은 thin(fail-open 유지). 현재값=upsert後 store, 이전값=기록 supersession(no model). 기존 "remembered" 동작 보존(non-changed 키).
- **리스크**: 없음 — refactor behavior-preserving, cli 2890 green, 독립 Opus ④b judge가 production-consumption+diff+dedup mutation+무회귀 재확인 PASS.

## fire 14 · 2026-06-21 · skill v2.1.0 · 7f89e9aa
meta: value-class=new-capability · pkg=@muse/cli · kind=recap-surface · verdict=PASS · firesSinceDrill=4 · firesSinceMainMerge=1
ratchet: testFiles +0 (commands-recap.test +2) · @muse/cli 2892 green · lint clean · fabrication 0

- **무엇**: `muse recap`(저녁 다이제스트)에 **"📝 Recently learned about you"** 섹션 — proactive 인용 학습 recap. `composeEveningRecap`(순수)가 렌더, `gatherEveningRecap`가 store→`projectRecentlyLearned`(30일)→`renderRecentlyLearnedLines`→`safeRecapText`(인젝션 중화, fail-soft)로 계산. **발견: (c2) ask 경로는 MOOT**(commands-ask:2181 `skipUserMemoryAutoExtract:true` — recall은 학습 안 함) → drop.
- **왜**: 테마의 문자 그대로 **"Muse가 배운 걸 *먼저* 보여주는"** — 저녁마다 자발적으로 "이번에 너에 대해 이런 걸 배웠어"(출처 인용). fires 1/2/6 재사용.
- **리뷰지점**: 🔄 volatileBeliefs(≥2값 confirm-nudge)와 **distinct**(📝 recent supersession informative; judge 확인). fail-soft + safeRecapText. `recentlyLearned` optional(기존 무영향). standalone 명령(chat보다 덜 contended).
- **리스크**: 없음 — optional 추가, cli 2892 green, 독립 Opus ④b judge가 redundancy(distinct)+fail-soft+security+무회귀 재확인 PASS.

## fire 15 · 2026-06-21 · skill v2.1.0 · 62605bf1
meta: value-class=new-capability · pkg=@muse/memory+@muse/cli · kind=first-learned-selection · verdict=PASS · firesSinceDrill=5 · firesSinceMainMerge=2
ratchet: testFiles +1 (belief-provenance-store.test.ts NEW, 4 cases) · @muse/memory 47 green · @muse/cli recap 33 green · lint clean · fabrication 0

- **무엇**: `selectRecentlyLearnedFacts(provenance, {now, withinDays, maxResults})`(@muse/memory, `selectVolatileBeliefs` 형제) — **첫-학습 fact surface**(firstSeen 윈도우 내 + `distinctValueCount===1` 안정). `muse recap`이 이미 읽는 provenance에서 계산해 recentlyLearned에 합침(변경 먼저, 첫-학습 뒤, `safeRecapText`). `belief-provenance-store.ts`의 **첫 테스트 파일**.
- **왜**: **GAP** — 기존 표면은 변경(supersession)만 보임; 새 fact는 supersession이 없어 안 떴음. provenance.firstSeen가 첫-학습 신호 → recap이 "이번에 처음 알게 된 것"도 인용 표시.
- **리뷰지점**: **3-way distinct**(judge 확인) — 변경(factHistory, distinctValueCount≥2)·flip-flop(volatile, ≥2)·첫-학습(===1) 상호배타 → double-count 없음. fail-soft + safeRecapText. age≥0(미래 firstSeen 제외) + Number.isFinite(NaN 제외).
- **리스크**: 없음 — additive, memory 47 + recap 33 green, 독립 Opus ④b judge가 distinctness+window+무회귀 재확인 PASS.
- **lesson**: 한 갭(첫-학습)을 닫을 땐 *데이터 소스가 다를 수 있다* — 변경은 factHistory, 첫-학습은 belief-provenance(firstSeen). 두 소스를 한 표면에 합칠 땐 distinctValueCount 같은 결정론 키로 상호배타를 보장해 double-count를 코드로 막아라(judge의 #1 점검).

## fire 16 · 2026-06-21 · skill v2.1.0 · 99b42357
meta: value-class=new-capability · pkg=@muse/cli · kind=brief-surface · verdict=PASS · firesSinceDrill=6 · firesSinceMainMerge=3→0(main FF-merge this fire)
ratchet: testFiles +1 (brief-learned.test.ts NEW, 3 cases) · @muse/cli 2895 green · lint clean · fabrication 0

- **무엇**: `muse brief`(아침)에 **"📝 Lately about you — <cited 1줄>"** beat — 저녁 recap(fire14)·status(fire5)의 **아침 형제**. `brief-learned.ts`(`formatBriefLearnedLine`: `summarizeRecentlyLearned`[fire4] + escape/neutralize) + brief action이 이미 읽은 `userMemory`로 `projectRecentlyLearned`(30일)→stdout(fail-soft).
- **왜**: **형제-감사** — recap만 학습 섹션 있었음(아침 brief 갭). 이제 데일리-드라이버가 하루 양끝(아침·저녁)에서 학습 체감. fires 1/4 재사용.
- **리뷰지점**: 기존 brief beat 패턴(`try{read→select→format→stdout}catch{}`) 그대로. cited text는 escape+neutralize(주입 승격 방지, `<<end>>` 테스트). forgotten 제외 상속. `userMemory` 재사용(중복 read 없음).
- **리스크**: 없음 — additive beat, cli 2895 green, 독립 Opus ④b judge가 consume+citation+security+무회귀 재확인 PASS.

## fire 17 · 2026-06-21 · skill v2.1.0 · 1a73e5fc
meta: value-class=new-capability · pkg=@muse/memory+@muse/cli · kind=source-attribution · verdict=PASS · firesSinceDrill=7 · firesSinceMainMerge=3→0(main FF-merge this fire)
ratchet: testFiles +0 (belief-provenance-store.test +3) · @muse/memory 572 green · @muse/cli recap 33 green · lint clean · fabrication 0

- **무엇**: 첫-학습 recap 라인에 **HONEST 귀속** — "(you told me · DATE)"(source=user, 사용자 진술) vs "(I noticed · DATE)"(source=auto, Muse 추론). `RecentlyLearnedFact`에 `source` 추가(FactProvenance.source 전달) + `formatFirstLearned`(귀속 포맷터, @muse/memory), `muse recap`이 사용.
- **왜**: **HOW 학습했나의 정직성** — 추론(교정 가능)과 사용자-진술(deliberate truth) 구분 = 신뢰 calibration. grounding 핵심(WHAT뿐 아니라 HOW도 인용).
- **리뷰지점**: `source`는 `FactProvenance.source`(user=실제 사용자-진술 확인 있을 때만 — judge가 `muse memory set` 경로만 user-write 확인) → "you told me" 위조 불가. auto/legacy=conservative "I noticed". safeRecapText 유지.
- **리스크**: 없음 — additive 필드+포맷터, memory 572 + recap 33 green, 독립 Opus ④b judge가 귀속 정직성+source 의미+무회귀 재확인 PASS.
- **lesson**: 웹/API 학습 투영은 **MOOT** — 서버측 store가 factHistory 미populate(fire 3 노트 재확인; `toUserMemoryResponse`도 factHistory 없는 shape). 웹 "learned about you" 뷰는 서버 store가 supersession 기록(예: `collectFactSupersessions` 재사용)부터 선행돼야 = 별도 foundation. 남은 학습-표면은 전부 로컬-CLI 경로(memory show/status/chat/recap/brief)로 사실상 완성.

## fire 18 · 2026-06-21 · skill v2.1.0 · b902e424
meta: value-class=new-capability · pkg=@muse/memory+@muse/cli · kind=forgotten-projection · verdict=PASS · firesSinceDrill=8 · firesSinceMainMerge=carry(15-18 branch-safe, main race)
ratchet: testFiles +0 (belief-provenance-store.test +3, commands-recap.test +2) · @muse/memory 578 green · recap 35 green · lint clean · fabrication 0

- **무엇**: `muse recap`에 **"🗑️ Forgotten at your correction"** 섹션 — 정체성 **"FORGETS the moment you correct it"의 가시화**(learned의 대칭). `selectRecentlyForgotten`(@muse/memory): newest-event-per-key가 `retraction`(명시적 forget)인 키를 윈도우 내 선택(re-`set`이 clear), retraction date 인용.
- **왜**: 학습만 보였고 "잊음"(정체성 두 번째 절반)은 백그라운드였음. 교정→forget이 실제 반영됨을 사용자가 봄. `recordRetraction`(chat `/forget` + `muse memory forget` 둘 다)이 남긴 마커 사용.
- **리뷰지점**: newest-event-wins(`keysWithActiveRetraction` 규칙) → re-learned 키는 forgotten 안 뜸(judge 확인). raw entries 읽기는 `deriveFactProvenance`와 같은 소스, fail-soft + safeRecapText. `recentlyForgotten` optional.
- **리스크**: 없음 — additive, memory 578 + recap 35 green, 독립 Opus ④b judge가 retraction 정직성+re-set-clears+무회귀 재확인 PASS. (cli daemon 9 timeout = 동시루프 포화 환경, 내 파일 무관 — judge 확인.)
