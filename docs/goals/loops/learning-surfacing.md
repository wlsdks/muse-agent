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
