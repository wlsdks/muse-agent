# computer-control — Muse computer-control 축 강화 루프 journal

> Theme: 로컬 12B(gemma4)가 멀티스텝 컴퓨터 작업(@muse/fs file_read/grep/edit/multi_edit + run_command)을 end-to-end 신뢰성 있게 완수 + 모든 actuator 단계가 근거 게이트(read-before-edit·fabrication=0) 통과. 측정 baseline `eval:computer-task`(report-only) 올리기.
> Worktree `/tmp/muse-computer-control` · branch `loop/computer-control` (Tier2 — 매 fire push, 주기적 main rebase, **3 fire마다 main ff-merge**). retheme from core-hardening (진안-picked 2026-06-20).
> Cron `18d30a58` (every 15m, session-only). Stop: `CronDelete 18d30a58`. Convention: [README](README.md).
> NOTE: fires 1-2 docs는 동시-루프 INDEX 충돌 cascade로 rebase 대신 origin/main 리셋 후 fire 3에서 통합 재기록(히스토리 보존; fire 1-2 해시 ee635ab0/8ea83aab는 orphaned but 기록용).

## fire 12 · 2026-06-21 · skill v2.0 · c526e24d (measure-first: model-behavior ceiling confirmed; 3-fire merge)
meta: value-class=measure-first(work-list) · pkg=eval(diagnosis) · kind=ceiling-confirm · verdict=N/A · firesSinceDrill=2
ratchet: testFiles 1068→1068 · fabrication 0 · eval:multifile-fix FAIL(early-stop 모드: file_read 1회 후 자발 종료) · eval:computer-task PASS(불변) · self-eval green
- 무엇: fires 4-11(노출·recovery·adapter)이 multifile을 움직였는지 debug 재측정 → 이번 run은 **early-stop**(모델이 file_read 1회만 하고 grep/edit/run 없이 종료). 단일 eval은 grep→read→edit 3콜 통과하므로 *iteration cap 아님* — 모델이 **자발적으로** 조기 종료(SYSTEM의 persistence 라인에도 불구).
- 왜 코드 슬라이스 없음: 남은 multifile 블로커 3모드(early-stop·node_run환각·garbage명) 중 환각/garbage는 fires 9·11이 결정론 처리; **early-stop은 순수 12B model-behavior**(자발 종료, cap 아님) — tool-filter/fs/adapter로 못 고침. continuation-nudge는 reflection-guard 규칙상 verifier-backed+registry 필요한 NEW retry surface인데 "action-task vs answer-only" 판별이 fuzzy(generic 오발 위험) + agent-core 코어루프 변경 = 신중한 >1-fire 설계(15분 auto-fire 부적합).
- 리뷰지점: fire 8·12 = *코드/측정으로 확인한* 정당한 vein-상태 파악(fire 3 성급-exhaustion과 구분). clean 결정론 computer-control vein 소진 확증: 노출(4·6·7)·fs(8)·recovery(9)·adapter(11)·verifier-drill(10) 다 됨. 3-fire 머지로 fires 10·11 코드 main 안착.
- 리스크: 0 — 코드 미변경, 측정+정직 기록 + docs 머지.
lesson: 다층(노출·recovery·adapter-파싱)을 결정론적으로 다 고쳐도 12B의 *자발적 조기종료*가 멀티스텝 천장 — 이건 코드가 아니라 모델 역량/agentic-persistence 영역. 정직한 다음 후보=verifier-backed action-completion nudge(agent-core, 신중 설계) 또는 다른 테마. measure-first가 "어디까지 코드로, 어디부터 모델"의 경계를 그음.

## fire 11 · 2026-06-21 · skill v2.0 · bbc503e5 (Ollama adapter tool-call name sanitisation)
meta: value-class=new-capability · pkg=@muse/model · kind=adapter-sanitisation · verdict=PASS · firesSinceDrill=1
ratchet: testFiles 1068→1068 (+3 cases adapter-ollama.test, mutation-valid) · fabrication 0 · @muse/model 격리 328 통과 · pnpm check=박스포화 false-timeout(매 run 다른 heavy/fuzz 테스트 5-8s, 변경패키지 격리 green) · lint clean
- 무엇: fire-9 DEEPER finding #3 처리 — gemma가 harmony 채널마커(`<|channel|>`,`<|"|>`)를 tool-call NAME에 누수 → 트레일링 누수 토큰이 valid 이름을 깨뜨려(`run_command<|channel|>` → tool-not-found) registry 매칭 실패. FIX(`adapter-ollama.ts` `sanitizeToolCallName`): 첫 `<|`에서 cut + 제어/zero-width 제거, generate+stream 두 파싱 사이트 모두 적용(형제-감사).
- 왜: 노출/recovery(fires 4-9) 다 했어도 adapter가 누수 토큰을 verbatim 통과하면 valid 이름이 깨짐 — 결정론적 위생화로 corrupted-valid 이름 복구. fully-garbage(shell명령-as-name)는 cut 후에도 잔존=model-behavior(정직히 미주장).
- 리뷰지점: mutation-valid(두 사이트 revert시 둘 다 RED)+clean 이름 불변. ④b judge PASS(over-stripping 0: dots/dash/Cyrillic/단일문자 보존, bare `<` 무트리거, 순수-leak→"unknown"; byte-hygiene escaped char class). LESSON 적용: 저널에 raw ESC 바이트 넣었다가 byte-hygiene이 잡음 → charCode 필터로 `\u001b` 텍스트화.
- 리스크: 낮음 — name만 위생화, args/id/"unknown"-fallback/happy-path 불변. ④b PASS.
lesson: 다른 pkg(@muse/model)로 RATCHET 전환해 fire-9가 남긴 adapter 버그를 결정론적으로 처리 — tool-calling 신뢰성은 (노출·recovery·adapter-파싱) 다층. 박스 포화(동시 루프 多)는 full check를 매번 다른 5-8s 타임아웃으로 막으나 *변경 패키지 격리 실행*이 회귀 vs 환경을 가름. 바이트를 *서술*할 때도 escape 텍스트(raw 금지) — fire10 교훈의 재귀.

## fire 10 · 2026-06-21 · skill v2.0 · 1599c25a (JUDGE-DRILL ✅ + harden guard + byte-hygiene regression)
meta: value-class=test-hardening+regression-fix · pkg=@muse/tools+apps/cli · kind=judge-drill · verdict=DRILL-PASS · firesSinceDrill=0(reset)
ratchet: testFiles 1068→1068 (+1 robust guard tools.test) · fabrication 0 · eval:computer-task 미실행(드릴 fire) · pnpm check=박스포화 false-timeout(crypto/fuzz ~5s, 격리 통과; byte-hygiene 회귀는 수정 후 44 통과) · lint clean
- JUDGE-DRILL(firesSinceDrill=10 트리거): `nearestToolName`에 고의 결함 주입(`shared>0` 가드 제거 → 무관명도 misleading 제안) + negative 테스트를 tautology로 약화 → **결정론 게이트 통과(281)**. ④b 독립 judge가 추론으로 **FAIL**: delete_everything→run_command(위험) 재현·tautology 테스트 적발·거짓 docstring·grounding-floor 위반·정확한 롤백 권고. → git restore 롤백(executor.ts HEAD 동일 확인).
- 진짜 fix(드릴이 드러낸 약점 메움): no-misleading 속성 가드가 **단 1개**라 쉽게 약화됨 → 여러 무관명(delete_everything 등)×여러 등록도구로 "절대 'Did you mean' 안 함" robust 가드 추가. mutation-verified(드릴 결함 주입 시 신규+기존 가드 둘 다 RED).
- 회귀 fix: 동시-루프 mascot 커밋(e10ac6c2)이 `commands-logo.test.ts` L23·32에 raw ESC 바이트 → byte-hygiene 게이트가 main check 차단. raw ESC→`\u001b`(의미 동일, commands-logo 통과 확인). [[feedback_no_raw_control_bytes_in_tests]] 룰.
- 리스크: 0 코드 동작 변경(executor 불변, 테스트 추가 + 기존파일 바이트 escape만). 박스포화로 full check green은 crypto/fuzz 5s-타임아웃에 막히나 변경 파일 타겟 테스트 전부 통과.
lesson: **JUDGE-DRILL이 제 역할 입증** — 결정론 게이트(281 green)를 전부 통과한 회귀를 독립 judge가 추론+probe로 잡음(rubber-stamp 아님, maker≠judge 보상통제 작동). 드릴이 "단일 가드는 약하다"를 드러냄 → robust 가드로 하드닝(드릴→진짜fix 사이클). 박스포화(동시 루프 多)는 crypto/fuzz 테스트를 5s 타임아웃시킴 — 격리 재실행이 환경 vs 회귀를 가름.

## fire 9 · 2026-06-21 · skill v2.0 · 2d0f57ab (hallucinated-tool nearest-name suggestion; 3-fire merge)
meta: value-class=new-capability · pkg=@muse/tools · kind=tool-error-recovery · verdict=PASS · firesSinceDrill=9
ratchet: testFiles 1067→1067 (+2 cases tools.test, mutation-valid) · fabrication 0 · eval:computer-task PASS(무회귀) · eval:multifile-fix 여전히 FAIL(다중 stochastic 모드, 노출/이 fix로 미flip) · pnpm check exit 0 · lint clean
- 무엇: MUSE_TASK_DEBUG로 multifile 트레이스 → 모델이 read→read→edit로 **버그 실제 수정(test-passes=true)** 하나 테스트 실행에서 `run_command` 대신 `node_run`을 **환각** → bare "tool not found"로 stuck. FIX(`executor.ts` `nearestToolName`): not-found 시 토큰-공유 최다 등록도구 제안("Did you mean 'run_command'?"). 결정론, not-found 분기만, 실패-에러 텍스트만.
- 왜: fire 8(잘못된 old_string→nearest 줄)의 형제 — 잘못된 *도구명*→nearest 도구. 12B의 tool-name 환각 회복 보조(arXiv:2510.17874 reflection-repair 철학, 기존 toolErrorHint와 일관).
- 리뷰지점: mutation-valid(stub시 RED)+negative 가드(무관명→제안 없음). ④b judge PASS(misleading 무해=텍스트만 게이트 재강제, happy-path 불변, 결정론 tie-break). **DEEPER**: multifile은 다중 stochastic 모드(조기중단·node_run환각·garbage명+gemma `<|channel>thought` 템플릿토큰 누수) → 이 fix는 node_run만; 템플릿누수는 별도 @muse/model adapter 버그. eval의 `modelRanTest=includes("run_command")`도 brittle path-grading(outcome 채점 위반).
- 리스크: 낮음 — not-found 분기만, 실행 0(텍스트 제안), happy-path/fabrication/approval 불변. ④b PASS.
lesson: 깊은 measure-first(debug 트레이스)가 "노출 다 됐는데 왜 FAIL"을 분해 — 모델은 *수정은 성공*하나 도구명 환각(node_run)+템플릿토큰 누수로 verify 실패. 결정론 핸들(nearest-name)은 한 모드만; 나머지는 model/adapter 영역. fire 8·9 = "잘못된 입력→nearest 실제값 제안"의 형제 패턴(edit old_string·tool name).

## fire 8 · 2026-06-21 · skill v2.0 · e83287c5 (edit no-match nearest-line hint; pivot to fs/edit-repair)
meta: value-class=new-capability · pkg=@muse/fs · kind=edit-repair · verdict=PASS · firesSinceDrill=8
ratchet: testFiles 1065→1065 (+2 cases fs-write-tools, mutation-valid) · fabrication 0 · eval:computer-task PASS(무회귀) · pnpm check exit 0(LINE 웹훅 20s 타임아웃 flake=박스포화, stash-격리 854/854 통과 확인) · lint clean
- 무엇: diversity RATCHET(tool-exposure 3연속 4·6·7)로 다른 (pkg,kind) 전환 — @muse/fs 3× scout(path-safety 전 write도구·read-before-edit 형제·edit repair 모두 견고) 후 유일 갭=genuine content-miss 시 `applyEdit`이 "old_string not found"만 반환(self-correct 불가). FIX: `nearestLineHint`(shared-word overlap로 파일의 가장 가까운 줄을 에러에 첨부, threshold·120자·noise 억제). 순수/결정론, 실패-메시지 only(매칭/write 불변).
- 왜: 노출 다 고쳐도 모델이 잘못된 old_string을 주면 repair 피드백이 unhelpful → 실제 텍스트를 줘 next 시도 self-correct. 12B 멀티스텝 신뢰성에 간접 기여(repair 루프 단축). fail-closed posture 불변(no location-guess).
- 리뷰지점: mutation-valid(헬퍼 stub시 RED). ④b judge PASS(write 유발 0, noise 억제 probe, 결정론 tie-break, scope 정직). LINE 웹훅 flake는 stash-격리로 pre-existing env 타임아웃 확정(내 fs 변경 무관).
- 리스크: 낮음 — 에러 문자열만 enrich, 매칭/write/fail-close 전부 불변. ④b PASS.
lesson: 3× scout로 "코드가 이미 견고"를 *코드로 확인*하면 성급-exhaustion(fire 3) 아니라 정당한 vein-상태 파악 — fs primitives는 hardened, 남은 갭은 repair-피드백 품질(작지만 clean)뿐. **computer-control clean-deterministic vein 대부분 소진**: 노출 done(4·6·7)·fs hardened(8), 잔여 multifile 블로커는 12B model-behavior(fuzzy/stochastic, deterministic 슬라이스 아님). 다음=agentic-persistence(전용 eval예산) 또는 mandatory-bloat 리팩터(broad).

## fire 7 · 2026-06-21 · skill v2.0 · ea75ca36 (file_edit code-edit intent; EXPOSURE CHAIN COMPLETE)
meta: value-class=new-capability · pkg=@muse/tools · kind=write-intent-gate · verdict=PASS · firesSinceDrill=7
ratchet: testFiles 1065→1065 (+1 case tools.test, mutation-valid) · fabrication 0 · file_edit 노출 fixed(probe) · eval:computer-task PASS(무회귀) · eval:multifile-fix 여전히 FAIL(노출 아닌 12B 멀티스텝) · pnpm check clean(LINE 웹훅 flaky 격리 854/854) · lint clean
- 무엇: fire 6 REMAINING(a) 처리 — file_edit(write-risk)가 `write_without_mutation_intent` 게이트의 `isWorkspaceMutationPrompt`(워크스페이스-객체 vocab만)에 막혀 code-fix 프롬프트에 미노출. FIX: 3 힌트 리스트에 code-edit vocab 추가(workspace/target += file/source/code/bug/function+KO, mutation += fix/debug, KO += 고쳐). file_edit 노출됨(probe), tasks.add는 relevance 게이트로 여전히 차단.
- 왜: 노출 체인의 마지막 조각 — fires 4(starvation)·6(keyword)·7(write-intent)로 file_grep/read/edit/run_command 전부 code-fix task에 도달가능. multifile eval은 여전히 FAIL이나 이제 순수 12B 멀티스텝(file_read만 쓰고 멈춤) — tool-filter로 못 고치는 model-behavior.
- 리뷰지점: mutation-valid 테스트(revert시 RED, 3 힌트 차원 모두 필요). ④b judge PASS + 정직한 residual: relevance 백스톱이 fix/debug엔 누수0이나 add/create 동음이의("add a function to the file")엔 tasks.add/calendar.create 누수(기존 키워드 중복, approval-gate로 bounded=노출≠쓰기) — 내 "완전 차단" 주장 과장이라 정직히 기록.
- 리스크: 낮음 — write-intent 게이트 자체 불변(vocab만 확장), pure-read는 여전히 차단, approval/path-safety/fabrication=0 불변. add/create 누수는 기존+approval-bounded.
lesson: 노출은 3층(starvation·relevance-keyword·write-intent)이고 셋 다 고쳐도 12B 멀티스텝이 별도 천장 — measure-first가 "노출 fixed인데도 FAIL"로 천장을 model-behavior로 격리. ④b가 maker의 안전주장 과장(relevance 백스톱)을 잡음 → 정직히 기록(judge가 scope-honesty도 GATE).

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
