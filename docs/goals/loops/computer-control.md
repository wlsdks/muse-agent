# computer-control — Muse computer-control 축 강화 루프 journal

> Theme: 로컬 12B(gemma4)가 멀티스텝 컴퓨터 작업(@muse/fs file_read/grep/edit/multi_edit + run_command)을 end-to-end 신뢰성 있게 완수 + 모든 actuator 단계가 근거 게이트(read-before-edit·fabrication=0) 통과. 측정 baseline `eval:computer-task`(report-only) 올리기.
> Worktree `/tmp/muse-computer-control` · branch `loop/computer-control` (Tier2 — 매 fire push, 주기적 main rebase, **3 fire마다 main ff-merge**). retheme from core-hardening (진안-picked 2026-06-20).
> Cron `18d30a58` (every 15m, session-only). Stop: `CronDelete 18d30a58`. Convention: [README](README.md).
> NOTE: fires 1-2 docs는 동시-루프 INDEX 충돌 cascade로 rebase 대신 origin/main 리셋 후 fire 3에서 통합 재기록(히스토리 보존; fire 1-2 해시 ee635ab0/8ea83aab는 orphaned but 기록용).

## fire 3 · 2026-06-20 · skill v2.0 · 54e86fee (PRECISE root-cause + honest theme-wall, 3-fire merge)
meta: value-class=refactor(work-list) · pkg=agent-core(diagnosis) · kind=root-cause-final · verdict=N/A · firesSinceDrill=3
ratchet: testFiles 1060→1060 · fabrication 0 · eval:computer-task 2/2 STABLE FAIL (root-caused, not yet fixed)
- 무엇: decompose (c) 착수 중 **정밀 root-cause 확정**: `muse.context.*`·`muse.skills.*` 6개가 전부 **domain="core" → isMandatoryTool=true**(always-on, cap 보호). 그래서 *모든* 턴(file-fix 포함)에 20개 도구가 노출되고 그 6개가 영구 distractor. 12B가 20개(tool-calling.md ≤5-7의 3배) 중 prominent한 skills/context를 file 도구 대신 선택.
- 왜 코드 슬라이스 없음: skills/context를 core로 둔 건 *의도적 설계*(모델이 항상 skill/context 호출 가능해야 함) — mis-classification 아님. 따라서 fix는 (1) intent-classification("이건 file-task → skills 숨김") 또는 (2) path-mention 부스트(file 도구 ranking↑이나 mandatory distractor는 잔존) — **둘 다 fuzzy + OUTCOME stochastic(각 eval run ~7min×pass^k)**. 테마가 전제한 "결정론적 repair"(literal-\n·scope-default — 이미 소진)와 다른 클래스. 거대 세션 말미에 stochastic 슬라이스 강행은 marginal-value floor 위반 → 정직히 기록.
- 리뷰지점: fires 1-3가 measure-first→STABLE 확인→production-필터-확인→정밀 root-cause(mandatory core 분류)로 좁혀옴. 다음 단계는 *deliberate*(전용 시간, 적응형 judge 안전망) — auto-loop이 잘 못하는 영역. 진안에게 보고.
- 리스크: 0 — 코드 미변경, 진단 완결 + 3-fire docs 머지.
lesson: 두 테마(core-hardening, computer-control) 모두 같은 벽 — clean/deterministic 베인 소진 후 남는 건 fuzzy/stochastic/slow. auto-15min-loop은 clean 결정론 슬라이스에 최적; fuzzy-stochastic-slow 영역은 deliberate human-paced가 맞다. 측정이 이 경계를 드러낸다(전제≠라이브).

## fire 2 · 2026-06-20 · skill v2.0 · 8ea83aab (root-cause investigation, DECOMPOSE step a+b)
meta: value-class=refactor(work-list) · pkg=agent-core(investigation) · kind=root-cause-analysis · verdict=N/A · firesSinceDrill=2
ratchet: testFiles 1060→1060 · fabrication 0 · eval:computer-task 2/2 FAIL (STABLE wrong-tool)
- (a) STABLE 확인: 2/2 run 동일 wrong-tool(skills/context, file 0회). (b) production은 필터함(planForContext→capToolsByRelevance) — eval도 거침 = relevance 랭킹 갭. (fire-1의 "raw assembly 노출" 정정.)
- lesson: 새 축의 "deterministic repair" 전제가 라이브 실패와 안 맞을 수 있다 — 측정이 전제를 정정. stochastic 검증 fix는 전용 fire 예산.

## fire 1 · 2026-06-20 · skill v2.0 · ee635ab0 (measure-first diagnosis + DECOMPOSE)
meta: value-class=refactor(work-list) · pkg=scripts/eval · kind=measure-first-diagnosis · verdict=N/A · firesSinceDrill=1
ratchet: testFiles 1060→1060 · fabrication 0 · eval:computer-task 1 run FAIL (wrong-tool selection)
- 부트스트랩(worktree/install/baseline) + measure-first eval → add-버그 고치기에서 12B가 skills/context만 호출(file 0회). wrong-tool selection 발견 → ★ finding으로 backlog 정제.
- lesson: 새 루프 fire 1은 measure-first eval로 *현재* 실패를 측정해 stale backlog를 정제하는 게 정직.
