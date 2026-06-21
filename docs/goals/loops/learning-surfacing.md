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
