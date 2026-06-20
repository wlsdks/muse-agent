# computer-control — Muse computer-control 축 강화 루프 journal

> Theme: 로컬 12B(gemma4)가 멀티스텝 컴퓨터 작업(@muse/fs file_read/grep/edit/multi_edit + run_command)을 end-to-end 신뢰성 있게 완수 + 모든 actuator 단계가 근거 게이트(read-before-edit·fabrication=0) 통과. 측정 baseline `eval:computer-task`(report-only) 올리기.
> Worktree `/tmp/muse-computer-control` · branch `loop/computer-control` (Tier2 — 매 fire push, 주기적 main rebase, **3 fire마다 main ff-merge**). retheme from core-hardening (진안-picked 2026-06-20).
> Cron `18d30a58` (every 15m, session-only). Stop: `CronDelete 18d30a58`. Convention: [README](README.md).
> NOTE: fires 1-2 docs는 동시-루프 INDEX 충돌 cascade로 rebase 대신 origin/main 리셋 후 fire 3에서 통합 재기록(히스토리 보존; fire 1-2 해시 ee635ab0/8ea83aab는 orphaned but 기록용).

## fire 6 · 2026-06-21 · skill v2.0 · 0832ff97 (code-task tool keywords; multi-file exposure ↑, 3-fire merge)
meta: value-class=new-capability · pkg=@muse/tools+@muse/fs · kind=tool-relevance/keywords · verdict=PASS · firesSinceDrill=6
ratchet: testFiles 1062→1062 (+2 cases tools.test, mutation-valid) · fabrication 0 · eval:multifile-fix exposure ↑(file_grep,context→file_read+run_command) · eval:computer-task PASS(무회귀) · pnpm check exit 0 · lint clean
- 무엇: measure-first on `eval:multifile-fix`("run the test, fix the bug") FAIL 발견 → root: `run_command`이 **키워드 0개**라 run/test 프롬프트에 relevance 0 → starved(노출조차 안 됨); file 도구도 code-fix 동사 미보유. FIX(sibling-audit): run_command + file_read/grep/edit/multi_edit에 code/run 키워드. multi-file 노출 개선(file_read+run_command 이제 노출), single-file 무회귀.
- 왜: 멀티파일 측정이 새 결정론 갭(run_command 키워드 0개=unreachable)을 드러냄 — fire 4(starvation)·fire 6(keyword)이 tool-exposure의 두 층. eval:multifile-fix 바이너리(muse-runner) main에서 복사해 언블록.
- 리뷰지점: mutation-valid 테스트(0-keyword run_command은 cap에서 탈락=RED, keyworded=생존; ④b finding-1 지적 후 cap-exercise로 수정). IrrelAcc(흔한 단어 over-fire)는 approval-gated라 harm 아님(④b)+build/script 제거로 경감. REMAINING: file_edit가 isWorkspaceMutationPrompt(워크스페이스 객체용, code-edit 미인식)에 막힘 + 12B 멀티스텝(read만 쓰고 미진행) → decompose.
- 리스크: 낮음 — 키워드 additive, write 도구 over-expose 안 됨(mutation-gate 유지), single-file 무회귀. ④b PASS.
lesson: measure-first를 *다른 eval*(multifile)로 넓히면 새 결정론 갭이 나온다 — run_command 키워드 0개는 "도구가 도달조차 못함"의 명백한 버그. ④b가 weak-test(cap 미exercise)를 잡아 mutation-valid로 교정(judge가 maker 테스트 품질도 GATE).

## fire 5 · 2026-06-20 · skill v2.0 · 0d3ef486 (top item DONE; bloat = deliberate decompose)
meta: value-class=refactor(work-list) · pkg=tools(scoping) · kind=decompose-design-sensitive · verdict=N/A · firesSinceDrill=5
ratchet: testFiles 1062→1062 · fabrication 0 · eval:computer-task PASS (fire-4 fix holds, no regression)
- 무엇: fire-4가 top ★(wrong-tool)을 결정론적으로 FIX(eval pass^3 3/3)했으니 다음 후보=잔여 bloat(time/math/regex가 domain="core"=always-on). 코드로 스코핑: 6개 time 도구가 `muse-tools-time.ts`에서 core, math/regex도 여러 파일 산재 → 6+ 파일 re-tag + keyword 커버(DEFAULT_DOMAIN_KEYWORDS에 math/time/text 부재) + 크로스-서피스 검증 필요한 **broad·design-sensitive 리팩터**.
- 왜 코드 슬라이스 없음: **현재 측정된 실패 없음**(fire-4 reserve가 eval을 PASS시킴) — measure-first 원칙상 측정 실패 없는 speculative broad 리팩터를 auto-fire에 강행 안 함. design-sensitive(어떤 유틸이 진짜 "always reachable"인가는 판단 필요) + 강등이 time/math를 필요할 때 숨길 risk → DELIBERATE decompose 기록(backlog).
- 리뷰지점: fire 3의 "premature exhaustion" 실수를 반복하지 않되(fire 4가 깊이 파면 clean fix가 나옴을 증명), 이번 bloat는 *진짜로* broad+design-sensitive+측정실패-없음임을 코드로 확인(6+파일, keyword 부재 trap). 다음 measure-first 후보=eval:multifile-fix(멀티파일 실패 탐색).
- 리스크: 0 — 코드 미변경, 정밀 decompose 기록 + fire-4 fix 회귀 0 확인.
lesson: fire 3(성급한 exhaustion)과 fire 5(정당한 decompose)의 차이 = *코드로 스코프를 확인*했는가. fire 3은 "fuzzy"라 단정(틀림), fire 5는 6+파일·keyword-trap·측정실패-없음을 실제 확인. 측정+스코프 확인이 "더 파라" vs "deliberate로 미뤄라"를 가른다.

## fire 4 · 2026-06-20 · skill v2.0 · a925a13e (DETERMINISTIC fix SHIPPED — eval flips FAIL→PASS)
meta: value-class=new-capability · pkg=@muse/agent-core · kind=tool-exposure/starvation-fix · verdict=PASS · firesSinceDrill=4
ratchet: testFiles 1060→1060 (+3 cases tool-filter.test) · fabrication 0 · **eval:computer-task 2/2 STABLE FAIL → PASS** (model now file_grep→read→edit) · pnpm check exit 0 · lint clean
- 무엇: 진안의 "계속해줘 찾아서"로 더 깊이 파서 fires 1-3의 "fuzzy" 결론을 뒤집음 — **결정론 구조 버그 발견+수정**: always-on MANDATORY 10개(math_eval/regex_extract/time_add/context×3/skills×3)가 cap=6을 초과 → `capToolsByRelevance`의 `remaining=0` 분기가 optional 전체를 드롭 → file 도구가 *invisible*(모델이 볼 수 없음→절대 못 고침). FIX(`tool-filter.ts`): (1) positively-relevant optional에 reserve(FLOOR=3, irrelevant은 여전히 드롭) (2) FILE_PATH_RE 부스트(프롬프트에 경로 있으면 files-domain +3 → file 클러스터가 reserve 상위).
- 왜: 측정을 더 깊이(mandatory 개수+cap 생존 확인) 하니 "fuzzy 랭킹"이 아니라 "always-on clutter가 task 도구를 starve"하는 결정론 버그였음. 테마가 전제한 clean 결정론 fix가 맞았다 — 단지 fire 1-3이 진단을 충분히 깊게 안 했을 뿐.
- 리뷰지점: 결정론 단위테스트 3개(starvation rescue·irrelevant-still-dropped·path-boost all-3-files) RED-on-old. eval flip 2/2→PASS(file_grep,read,edit 사용). ④b 적응형 judge PASS(over-exposure 없음, URL false-trigger 무해, 불변식 불변). judge note 대응: **pass^3 = 3/3 STABLE PASS 확인**(durable, flaky 아님; 각 run file_grep→read→edit).
- 리스크: 낮음 — optional 재랭킹/reserve만(mandatory/recent/risk 불변), relevant만 admit. ④b PASS.
lesson: "fuzzy/exhausted" 결론은 *진단 깊이 부족*일 수 있다 — 한 겹 더 측정(mandatory 카운트+cap 생존)하니 fuzzy로 보이던 게 clean 결정론 버그였다. 진안이 "계속 찾아서"로 민 게 옳았다. measure-first는 *충분히 깊게* 해야 전제(결정론 fix 가능)를 확증한다.

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
