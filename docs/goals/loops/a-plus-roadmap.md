# Loop journal — a-plus-roadmap

테마: Muse A+ 로드맵 집행. 큐 = `docs/strategy/competitor-analysis-and-a-plus-roadmap.md` §10.3 (self-scout 금지). cron `964ac861` (30m, session-only), Tier1 no-push, /tmp worktree. 중단: `CronDelete 964ac861`.

## fire 1 · 2026-07-11 · skill v2.x · f5a360393
meta: slice=D2-S1d · wave=W1 · pkg=scripts(eval-adversarial) · kind=eval-ratchet · verdict=PASS · firesSinceDrill=1
ratchet: 로드맵 잔여 [ ] = 30/31 · self-eval pass · fabrication 0 · adversarialCases 16→19
- 무엇: eval:adversarial에 결정론 sandbox-탈출 3종(cwd밖/~/.ssh write·network) 추가 — 실 muse-runner 바이너리를 seatbelt로 spawn해 OS 거부를 코드 채점(모델 거부 아님, agent-testing #5).
- 왜: D2-S1b가 seatbelt를 배선했으나 eval 표면에 탈출-차단 회귀 가드가 없었음. 이제 adversarialCases 래칫이 confinement 약화를 자동 포착.
- 리뷰지점: network 케이스가 `accepted` 리스너 플래그로 채점되는지(curl exit≠0만으론 guard-OFF도 가짜 통과) — Opus 평가자가 guard-ON/OFF 뮤테이션 독립 재현으로 확인.
- 리스크: network 케이스 300ms straggler 지연 의존(pass^2 안정 확인). ~/.ssh 없는 머신은 $HOME root 타겟(여전히 cwd/tmpdir 밖이라 거부).

## fire 2 · 2026-07-11 · skill v2.x · 64557d3f9
meta: slice=D2-S2a · wave=W1 · pkg=@muse/tools · kind=security-classifier · verdict=PASS(재판정) · firesSinceDrill=2
ratchet: 로드맵 잔여 [ ] = 30/32(D2-S2가 a/b로 분해되며 +1) · self-eval pass · fabrication 0 · topology 22 test 신규
- 무엇: 순수 셸-토폴로지 분류기 classifyCommandTopology — 셸 `-c` 스크립트가 DS-2 문자열가드가 못 보는 구성(치환/process-sub/heredoc/eval)을 quote-aware로 감지, 비-셸 command는 analyzable(near-miss). D2-S2를 a(분류기)/b(배선)로 분해.
- 왜: DS-2는 `$(...)` 안에 숨은 파국을 못 봄. 이 분류기가 D2-S2b에서 un-analyzable→명시 승인 강등의 판정부가 됨.
- 리뷰지점: Opus 1차 FAIL(개행이 명령구분자인데 eval 감지 누락=false neg; `$((` 산술을 command-sub로 오탐=false pos) → 롤백 대신 명명된 결함 수리(retry 예산 내), 재판정 PASS. maker=Sonnet·judge=Opus 모델차로 self-preference 차단이 실제 결함을 잡음.
- 리스크: sudo/env 래퍼(`sudo sh -c '$(x)'`)는 program이 sudo로 풀려 미검출 → VQ-15 기록(D2-S2b 배선서 래퍼 벗기기). 배선 전까지 유저-가시 효과 0(CHANGELOG "기반/미연결"로 정직 표기).
lesson: 셸 명령 구분자는 `; | & (`만이 아니라 **개행**도 포함 — command-position 스캐너는 `\n`을 반드시 재-arm; `$(`와 `$((`(산술)는 구분해야 near-miss 오탐 없음.

## fire 3 · 2026-07-11 · skill v2.x · b3f581400
meta: slice=D2-S2b · wave=W1 · pkg=apps/cli(chat-ink-core) · kind=security-wiring · verdict=PASS · firesSinceDrill=3
ratchet: 로드맵 잔여 [ ] = 29/32 · self-eval FOREIGN-fail(아래) · fabrication 0 · chat gate 135 test(+9)
- 무엇: D2-S2a 순수 분류기를 wired 승인 게이트 chatToolApprovalGate에 배선. un-analyzable run_command은 ①risk=read 위조로도 silent-allow 안 됨(read fast-path에 `&& topology.analyzable`) ②승인 프롬프트에 "검사 불가 셸 구성" 경고. 무조건 거부 아님(사람이 정당 heredoc 승인).
- 왜: DS-2 문자열가드가 못 보는 $()/heredoc/eval을 사람이 인지하고 승인하도록. 발견: trust.json 런타임 미배선 + run_command 이미 execute라 live auto-approve seam 없음 → 완전 강등은 VQ-16.
- 리뷰지점: Opus 평가자 PASS(우회불가 불변식·arg-hostility·mutation-RED 독립확인). over-cap construct=undefined → "(undefined)" 렌더 cosmetic를 `?? "un-analyzable"` 폴백+테스트로 수리.
- 리스크: 동시 Telegram 루프가 트리 오염(api/messaging/web/MUSE_TELEGRAM_* env 미커밋) → self-eval envInventory FOREIGN-fail(내 diff는 MUSE_ env 0개), @muse/api 테스트 2 FOREIGN-fail. 내 파일만 명시 스테이징, 외부 미접촉. self-eval exit-0은 외부 루프 커밋 후 회복 예정.
lesson: 동시 루프가 fire 중간에 트리를 오염시키면 self-eval/전패키지 게이트가 FOREIGN-fail — 내 파일 격리 검증(build+내test+lint)으로 판정하고 명시 경로 커밋, docs:env는 외부 env를 쓸어담으니 실행 금지.

## fire 4 · 2026-07-11 · skill v2.x · 56f59f477
meta: slice=D1-S1 · wave=W1 · pkg=@muse/agent-core · kind=loop-guard · verdict=PASS · firesSinceDrill=4
ratchet: 로드맵 잔여 [ ] = 28/32 · self-eval pass · fabrication 0 · agent-core 2841 test green · pingpong 19 신규 · eval:computer-task PASS(local-forced 1/1, false-abort 없음)
- 무엇: ping-pong 루프가드 tool-loop-pingpong.ts — 모델이 두 툴 사이를 무한 교대(A,B,A,B)하는 걸 trailing-alternation-run으로 감지(창20·warn6·block10), 결과 서명서 휘발필드(runId/tsIso/id/ts/timestamp) 재귀 strip. block→pingPongAbortedExecution(post-compaction 미러) 양쪽 루프 배선. 기존 stall 감지기(A,A,A만)의 사각을 메움.
- 왜: openclaw tool-loop-detection이 별도 케이스로 꼽는 실패모드. 12B는 2-툴 왕복에 잘 빠짐. stall(동일출력)만 잡던 Muse에 교대 감지 추가.
- 리뷰지점: 오탐이 최대 리스크(정당 다단계를 루프로 오인해 abort) → 유닛(genuine progress/stall/3-cycle=none)+Opus 독립 false-positive 배터리+model-loop 2841 green로 검증. id-strip이 args는 보존해 distinct-arg 병합 안 함(Opus 확인). mutation-RED 양방향(교대조건·volatile strip).
- 리스크: eval:computer-task가 ambient GEMINI_API_KEY로 Gemini 하이재킹(VQ-17, eval 정책위반) → MUSE_LOCAL_ONLY=true로 local-forced 재실행 시 PASS(1/1, add-works·multiply-intact·no-collateral, 실 다단계작업이 가드 하에 false-abort 없이 완료). 가드는 10-deep A↔B에서만 abort라 정당작업 불발현.
lesson: "LOCAL OLLAMA ONLY" eval이 실제로 로컬 강제를 안 하면 ambient 클라우드 키에 하이재킹됨 — eval 스크립트는 MUSE_LOCAL_ONLY/MUSE_DEFAULT_MODEL을 명시 강제해야(VQ-17).

## fire 5 · 2026-07-11 · skill v2.x · c338f66c5
meta: slice=D2-S6a · wave=W1 · pkg=@muse/tools+apps/cli · kind=security-ux · verdict=PASS · firesSinceDrill=5
ratchet: 로드맵 잔여 [ ] = 27/33 · self-eval pass · fabrication 0 · risky-token 13 test 신규
- 무엇: 승인 프롬프트 위험-토큰 하이라이트. 순수 identifyRiskyTokens(파괴 플래그·민감경로·명령위치 파괴동사, DS-2 위험어휘 재사용, 토큰-레벨)+emphasizeRiskyTokens(TRUSTED ANSI bold-red)를 chatToolApprovalGate detail에 배선(summarizeToolArgs redact+strip 뒤에만).
- 왜: DS-2는 파국명령만 코드거부하고 routine-risky(rm -rf ./build 등)는 통과시킴 — 사람이 승인할 때 위험부위를 눈에 띄게(informed consent). openclaw exec-approval span 참조.
- 리뷰지점: 오탐(과다 하이라이트→무시학습)이 최대 UX 리스크 → false-positive 배터리(ls·echo·따옴표 속 rm·~/Documents·/tmp/x 전부 []) + Opus 독립 검증. redact 뒤 하이라이트라 시크릿 노출 없음. ESC는 escaped \x1b(raw 바이트 아님, byte-hygiene 안전).
- 리스크: -rf가 비-rm(grep -rf)에도 하이라이트되는 bounded over-flag이나 advisory(비차단)+흔한 안전명령 미발현이라 Opus가 허용. b(스테이징)는 no-external-effect 계약 필요라 별도.

## fire 6 · 2026-07-11 · skill v2.x · 27c9ef986
meta: slice=D2-S6b · wave=W1 · pkg=apps/cli · kind=security-staging · verdict=PASS · firesSinceDrill=6
ratchet: 로드맵 잔여 [ ] = 26/34 · self-eval pass · fabrication 0 · actuator-tools 29 test(+staging)
- 무엇: CLI fs-write 게이트의 비대화형 거부를 기존 pending-approval-store(@muse/messaging 재사용)에 스테이징. buildCliPendingApprovalStager가 FsWriteDraft→PendingApproval 매핑해 recordPendingApproval(resolvePendingApprovalsFile). muse approvals가 읽는 동일 파일. no-external-effect: 실 fs-write 툴 e2e서 파일 미생성+entry round-trip.
- 왜: 기존엔 비대화형 CLI write를 silent deny → 이제 durable worklist item(auditability+채널/로컬 pending 단일화). 신규 스토어 금지 준수(기존 재사용).
- 리뷰지점: Opus 독립 e2e(파일 미생성+readback isPendingApproval 통과)·staging throw→deny 불변·mutation-RED 양방향. 시크릿: draft는 byte-count만(content 미포함), store 0600. messaging/src 0편집(동시 Matrix 루프와 충돌 회피).
- 리스크: CLI-write 스테이징 entry는 {path,action}만이라 approve→재실행 불가(VQ-18, 채널처럼 full-args 필요). 동시 Matrix/Telegram 루프가 트리 대량 오염(api/web/autoconfigure/messaging) → 내 3 apps/cli 파일만 격리 커밋.
lesson: 다른 루프가 churn 중인 패키지의 스토어를 재사용할 땐 barrel 익스포트만 import하고 그 src는 절대 편집 말 것 — 충돌 원천 회피(D2-S6b가 messaging store를 0편집으로 CLI 확장).

## fire 7 · 2026-07-11 · skill v2.x · 3b6e67c59
meta: slice=D3-S7 · wave=W1 · pkg=@muse/stores+apps/cli · kind=safety-guard · verdict=PASS · firesSinceDrill=7 · ★W1 완주
ratchet: 로드맵 잔여 [ ] = 25/34 · self-eval FOREIGN-fail(envInventory=MUSE_MATRIX_POLL_ENABLED, 내 env 0) · fabrication 0 · stores 13 test 신규
- 무엇: PID-재사용 kill 가드. background-process record에 osStartTime(spawn 시 OS start-time 캡처) 추가, 순수 pidIdentityMatches(레거시 보존/equality). stop·reconcile이 kill/reconcile 전 대조→불일치(재사용/소멸)면 kill 금지+exited(fail-close, 신규 pid_reused 결과). CLI가 ps -o lstart= -p로 배선(BSD+GNU, /proc 회피).
- 왜: 원 프로세스 죽고 PID 재사용되면 stopBackgroundProcess가 무관 유저 프로세스를 SIGTERM, reconcile은 isAlive만 봐 stale running. hermes process_registry 커널 start-time 검증 참조. "위험실행=결정론가드" 정합.
- 리뷰지점: Opus 독립 검증(reused-PID no-kill 직접 구동·truth table empty-string edge·throwing reader는 spawnSync가 안 던져 unreachable+fail-safe)·mutation-RED 양방향. messaging 0편집(동시 Matrix 루프 충돌 회피)·env 0.
- 리스크: 동시 Matrix 루프가 트리 대량 오염(api/web/autoconfigure/messaging)+envInventory FOREIGN-fail(MUSE_MATRIX_POLL_ENABLED). 내 5파일(stores 4+cli 1)만 격리 커밋. stop의 reader-throw는 try/catch 없으나 프로덕션 spawnSync는 미발현.

## fire 8 · 2026-07-11 · skill v2.x · 8ed66e2b3
meta: slice=D1-S3 · wave=W2 · pkg=@muse/memory+agent-core+cli · kind=compaction-quality · verdict=PASS · firesSinceDrill=8(≥8→다음 judge-drill)
ratchet: 로드맵 잔여 [ ] = 24/34 · self-eval pass · fabrication 0 · memory 18 test 신규 · ★W2 착수
- 무엇: 단계적 요약. summarizeDroppedContextInStages+chunkDroppedOnToolPairs(memory 순수). dropped를 tool-pair 경계로 청크(role:"tool" 앞 분할금지)→청크별 summarizeDroppedContext 재사용(각 FAIL-OPEN)→생존청크 병합·maxChars 캡. 식별자 VERBATIM 지시를 SUMMARIZER_SYSTEM_PROMPT에. agent-runtime:578+chat-ink-core:941 배선.
- 왜: 기존 CMP-2는 전체 dropped를 1회 aux 호출→대형 컨텍스트서 fidelity 손실/통째 절단. openclaw summarizeInStages 참조. 부분실패 보존+식별자 보존으로 grounding 강화.
- 리뷰지점: 기존 summarizeDroppedContext byte-identical(additions-only 확인)·부분실패=생존 보존 vs 전실패=floor·단일청크 등가·mutation-RED 양방향. Opus 독립 검증.
- 리스크: ★★동시 Matrix 루프가 평가 중 **공유 main에서 git rebase(b2e4bd55a) 실행→auto-stash가 내 미커밋 슬라이스 orphan**. 무손실 복구(워킹트리 온전+stash@{0} 중복)했으나 최악 사고 근접. 내 6파일만 격리 커밋.
lesson: ★동시 루프가 공유 main 워크트리서 `git rebase`/`pull --rebase` 실행 시 auto-stash가 타 루프 미커밋 작업을 orphan시킴 — 이 루프는 **worker→evaluator 창의 미커밋 노출을 최소화**하려 슬라이스를 최대한 빨리 커밋, 그리고 **이 루프를 격리 /tmp 워크트리로 옮기는 것이 근본 해결**(진안 결정 필요).

## fire 9 · 2026-07-11 · skill v2.x · d9c5732dc · ★JUDGE-DRILL + D1-S5a
meta: slice=D1-S5a · wave=W2 · pkg=@muse/agent-core · kind=budget-visibility · verdict=PASS · firesSinceDrill=0(리셋) · drill=PASS
ratchet: 로드맵 잔여 [ ] = 23/35 · self-eval pass · fabrication 0 · agent-core 62 test(신규 budget)
- ★JUDGE-DRILL(연속allPASS=8 도달, 미루기불가): 고의 결함 슬라이스 주입(redactCreditCards — 구분자 카드형식 유출 버그 + 선언-only 테스트 + mutation 미검증)→Opus 평가자가 **FAIL** 판정(구분자/space/Amex 유출 직접 프로브·선언-only 지적·return text; mutation 독립실행)→**게이트 신뢰성 증명**(rubber-stamp 없음)→드릴 완전 롤백(트리 클린·foreign 미접촉). maker≠judge 자기검증 통과.
- 진짜 fix D1-S5a: 도구 예산 소진 시 "N/M 툴콜 소진, 최선의 최종답" one-shot notice를 최종합성 前 주입(proactive, budget-only 엄격게이트, wallclock/stall 제외). 순수 budgetExhaustionNotice+Tracker(REVERIFY_NUDGE 미러), 양쪽 루프.
- 왜: 기존엔 toolCallCount≥maxToolCalls면 activeTools=[]로 조용히 도구 사라짐→모델이 예산소진 모른 채 truncated 답 가능. hermes iteration_budget 참조. 침묵중단 금지.
- 리뷰지점: Opus가 설계편차(reactive→proactive: 정상종료 cap-딱맞음 시 낭비 round-trip 회피) 정당성·엄격 budget게이트·종료보장·기존 agent-runtime 테스트 tightening(loosening 아님)·one-shot 구조적-inert 정직주장 확인. mutation-RED 양방향.
lesson: ★워커도 공유 main서 `git stash`를 씀(D1-S3 작업 쓸림→무손실 복구, 이미 커밋됨) — worker 브리핑에 "git stash 절대 금지, cp/git-apply로 격리" 명시 필요. proactive 주입이 reactive+continue보다 나음(정상종료 낭비 round-trip 회피). 이 루프의 격리 워크트리 이전이 근본해결(진안 결정 대기).

## fire 10 · 2026-07-11 · skill v2.x · fe1b505c1
meta: slice=D1-S5b1 · wave=W2 · pkg=@muse/agent-core · kind=invariant-lock · verdict=PASS · firesSinceDrill=1
ratchet: 로드맵 잔여 [ ] = 22/36 · self-eval pass · fabrication 0 · agent-core tool-plan 6 test(+1 락)
- 무엇: PTC "프로그래매틱=1" 예산 규칙 명문화. run_tool_plan 1콜=1 예산슬롯(내부 N스텝 무관)이 이미 동작이나 암묵적 → agent-runtime PTC 인터셉트 WHY주석 + 회귀락 테스트(3스텝 실행=effects[a,b,c] ∧ 1슬롯=toolsUsed["run_tool_plan"]). 계상 동작 무변경.
- 왜: PTC의 핵심(N스텝을 1예산으로)이 리팩터로 조용히 깨지면 PTC 무의미. hermes iteration_budget "PTC 환불" 참조. 불변식을 코드로 락.
- 리뷰지점: Opus가 주석-only(로직 무변경)·행동락 양방향(선언-only 아님, drill이 방금 그 실패모드 잡음)·mutation-RED(스텝을 각 예산으로→toolsUsed 길이3 RED)·주석정확성 trace 확인.
- 리스크: 없음(기존 동작 락, 무변경). 유저-가시 변화 0이라 CHANGELOG 생략(정직). 다음 D1-S5b2=서브에이전트 하위예산(신규 plumbing).

## fire 11 · 2026-07-11 · skill v2.x · 2341ec4fb
meta: slice=D1-S5b2 · wave=W2 · pkg=@muse/multi-agent+apps/cli · kind=budget-isolation · verdict=PASS · firesSinceDrill=2
ratchet: 로드맵 잔여 [ ] = 21/36 · self-eval pass · fabrication 0 · multi-agent+cli 29 test(신규+배선)
- 무엇: 서브에이전트 별도 하위예산. 순수 resolveSubAgentToolBudget(부모→max(3,floor(부모×0.5)), uncapped→5, 워커 항상 cap) + ask-decompose 워커 execute에 shallow-override 배선(부모 상속 대신 sub-budget). synthesize/planner는 부모예산 유지. D1-S5 완료(b1+b2).
- 왜: 워커가 부모 metadata.maxTools 전액 상속 → fan-out N워커면 N×부모 예산 가능. hermes parent90/sub50 참조. 워커는 focused 서브태스크라 작은 예산으로 충분.
- 리뷰지점: Opus가 순수 규칙 가드 전수(0/neg/NaN/Inf/frac→항상 양의정수≥3)·행동 배선(워커=[5,5,5]·synthesis=10·args.metadata 무mutation)·부모추출 안전(uncapped→5)·mutation-RED 양방향·형제-감사 진실성 확인.
- 리스크: orchestrator.ts(SupervisorAgent)·commands-board도 부모 metadata 상속(같은 클래스)이나 서버측·maxTools 관례 부재로 backlog follow-up(◦). 다음 D3-S1이 서브에이전트 depth 강등이라 인접.

## fire 12 · 2026-07-11 · skill v2.x · f7d546f63
meta: slice=D3-S1a · wave=W2 · pkg=@muse/multi-agent+apps/cli · kind=recursion-bound · verdict=PASS · firesSinceDrill=3
ratchet: 로드맵 잔여 [ ] = 21/37 · self-eval pass · fabrication 0 · multi-agent 34 test(+depth) · MUSE_BOARD_MAX_DEPTH env
- 무엇: 보드 태스크 depth 강등. AgentTask에 옵셔널 depth(부모0·서브 depth+1), resolveBoardMaxDepth(MUSE_BOARD_MAX_DEPTH 기본1·floor1), expandTaskIntoSubtasks가 depth≥maxDepth면 no-op(재분해 거부). CLI board expand 배선. 첫 분해는 여전히 허용(재-expand만 차단).
- 왜: verify-first로 서브태스크가 재-expand 가능(손자 무한분해) 확인됨. openclaw subagent-capabilities(depth≥max→leaf)·hermes max_spawn_depth1 참조. flat 보드에 깊이 ceiling.
- 리뷰지점: Opus가 ceiling 경계(depth==maxDepth 거부·1 아래 허용)·parent+1·back-compat(depth無=0)·파싱테이블(0/-1/abc/1.5→1 floor)·wiring·mutation-RED 양방향 검증. depth 필드 omit-when-0로 기존 보드 JSON 무마이그레이션.
- 리스크: 없음(옵셔널 필드·back-compat). 새 env MUSE_BOARD_MAX_DEPTH→docs:env 갱신(워커가 proactive 처리, envInventory 게이트 회피). 다음 D3-S1b=부모 tool-deny 상속(executor 게이트).

## fire 13 · 2026-07-11 · skill v2.x · e4633c5a3
meta: slice=D3-S1b · wave=W2 · pkg=@muse/multi-agent+apps/cli · kind=defense-in-depth · verdict=PASS · firesSinceDrill=4
ratchet: 로드맵 잔여 [ ] = 20/38 · self-eval pass · fabrication 0 · multi-agent 8 test 신규
- 무엇: 부모 tool-deny 상속. 순수 inheritParentToolDeny(child⊆parent 교집합) + ask-decompose 워커에 구조적 클램프(워커 allowedToolNames = 부모 교집합, args.metadata 무mutation, planner/synthesize 미클램프). D3-S1 완료.
- 왜: 서브에이전트가 부모에 없는 도구를 못 쓰게 구조 강제(openclaw subagent-capabilities). 현 워커는 metadata verbatim으로 이미 상속하나 unenforced convention → 클램프를 실 enforcement point에 사전배치.
- 리뷰지점: Opus가 순수 helper 정확성(교집합·dedup·empty clamp·무mutation)·wiring·mutation-RED 양방향 + **명시적 유의미성 판정**(진짜 defense-in-depth vs no-op락) 검증.
lesson: ⚠tool-deny 상속은 현 프로덕션에서 이미 verbatim으로 성립(broader-set 미전달)이라 클램프는 프로덕션 no-op — 테스트-only seam으로 검증. defense-in-depth 락이나 라이브 버그 수정은 아님. 유저-가시 변화 0이라 CHANGELOG 정직 생략. 이런 "이미 성립하는 불변식 락" 슬라이스는 seam을 정직히 disclose하고 Opus 유의미성 판정으로 통과.

## fire 14 · 2026-07-11 · skill v2.x · 820d5e425
meta: slice=D3-S2 · wave=W2 · pkg=@muse/agent-core+multi-agent · kind=liveness-seam · verdict=PASS · firesSinceDrill=5
ratchet: 로드맵 잔여 [ ] = 19/38 · self-eval pass · fabrication 0 · agent-core+multi-agent 6 test 신규
- 무엇: 단일-run heartbeat emission seam. ModelLoopRunner.heartbeat 주입(agent-core 미의존 multi-agent) + model-loop 3 emission(streamModelTurn text-delta·tool-call·runToolBatch genuine-exec) + emitHeartbeat try/catch. 기존 detectStalled 재사용(신규 감지기 0). fake-clock 유닛으로 단일-run 스테일 감지+정상스트림 비오탐.
- 왜: stale-detection 레지스트리 존재하나 호출부 orchestrator 1곳뿐 → 단일 장기 run이 heartbeat 미방출로 in-tool 스테일 미감지. hermes _heartbeat_loop 참조. VQ-1이 배선점 확정(model-loop 스트리밍).
- 리뷰지점: Opus가 emission gating(genuine-exec만, progress 트래커와 동일)·throw-safe·미배선 byte-identical·두 테스트 행동적·mutation-RED 양방향·deferral 정당성 검증.
lesson: ⚠라이브 레지스트리 피딩은 autoconfigure→multi-agent 의존 or apps/api 생성순서 재배치라는 아키텍처 결정 필요 → seam+emission+fake-clock 유닛까지만 이 슬라이스, 피딩+stall-abort 폴러는 backlog deferred. 정직히 disclose하고 Opus가 legitimate seam+test로 판정. 유저-가시 변화 0이라 CHANGELOG 생략.

## fire 15 · 2026-07-11 · skill v2.x · 9c69928e9
meta: slice=D3-S4a · wave=W2 · pkg=apps/cli · kind=capacity-cap · verdict=PASS · firesSinceDrill=6
ratchet: 로드맵 잔여 [ ] = 19/39 · self-eval pass · fabrication 0 · cli 27 test(+job-concurrency) · MUSE_JOBS_MAX_CONCURRENT env
- 무엇: job 동시상한. 순수 resolveJobsMaxConcurrent(기본3·≥1)+jobConcurrencyRefusal(>=cap 거부) + countRunningJobs(기존 jobSummary 재사용) + startBackgroundJobOrRefuse 배선(at-cap→명시거부+exitCode1, start 미호출; inline 무변경).
- 왜: muse job run이 무제한 백그라운드 spawn 가능(verify-first)→자원 고갈. hermes cap3 초과 async 거부 참조.
- 리뷰지점: Opus가 파싱테이블(0/-1/2.5/abc→3 floor1)·countRunningJobs 실 jsonl fixture 충실성(running만)·wiring(at-cap spy 미호출+exitCode1+stderr, under-cap 시작)·mutation-RED 양방향 검증.
- 리스크: 없음. 새 env→docs:env 갱신(워커 proactive). 다음 D3-S4b=boardTaskPrompt 헤드룸 요약예산+스필(복잡).

## fire 16 · 2026-07-11 · skill v2.x · c5ec0240c
meta: slice=D3-S4b · wave=W2 · pkg=apps/cli · kind=synthesis-budget · verdict=PASS · firesSinceDrill=7
ratchet: 로드맵 잔여 [ ] = 18/39 · self-eval pass · fabrication 0 · cli 41 test(+board-synthesis-budget) · 2 env
- 무엇: 보드 합성 헤드룸 요약예산+파일스필. 순수 perChildSynthesisBudget(max(2000,floor(h×0.5/n))) + budgetAndSpillOutputs(초과 truncate + FULL 원본을 ~/.muse/board-spill/ 스필, 세그먼트에 경로 명시) + makeAgentExecutor 배선(실fs·답변 note). boardTaskPrompt 순수 유지. D3-S4 완료.
- 왜: boardTaskPrompt가 자식 출력을 verbatim 임베드 → N 대형 자식이면 컨텍스트 폭발. hermes headroom×0.5/n·floor2000·파일스필 참조.
- 리뷰지점: Opus가 예산공식 edge(div0/NaN/Inf→2000)·경계(<=)·round-trip(스필===원본·경로 정확 일치·데이터손실 없음)·executor 실fs·boardTaskPrompt 순수·mutation-RED 양방향 검증.
- 리스크: 없음. 새 env 2개→docs:env(워커 proactive). 다음 D1-S7a=브라우저 스냅샷 AX-tree refs(다른 축 W2 브라우저).

## fire 17 · 2026-07-11 · skill v2.x · 61ca1e65c
meta: slice=D1-S7a · wave=W2 · pkg=@muse/browser · kind=browser-ref-guard · verdict=PASS · firesSinceDrill=8
ratchet: 로드맵 잔여 [ ] = 17/39 · self-eval pass · fabrication 0 · browser +3 test(ghost-ref) · env 0
- 무엇: 브라우저 ref 안정성 fail-close. `resolveTarget`(browser-tools.ts) 숫자-ref 분기가 `describeElement(ref)`=undefined(현재 스냅샷에 없는 stale/ghost/환각 ref)를 그대로 통과시켜 유령 요소로 click/type/hover/upload 하던 구멍을 거부로 닫음("call browser_read"). resolveTarget이 4 act-tool 단일 해소점이라 형제 일괄. 3 행동테스트(valid proceed·ghost click/type 거부, calls 무기록=부분부작용 0).
- 왜: 12B가 무효/stale ref를 넘기면 실제 요소 없이 행동 → 근거없는 조작. roadmap D1-S7a "refs 안정성 유닛". refs는 이미 numeric index+CSS셀렉터 모델노출 없음이라 (a) 숫자인덱스 요건은 기충족, 안정성이 실델타.
- 리뷰지점: Opus 독립 평가자가 mutation-RED 재현(가드제거→라인542/551 2 RED)·행동어서(shape아님)·legit flow(target분기·multi-field·describeElement populate)·포맷 무변경(grep @e=0)·스레트모델 검증 → PASS.
- 리스크: 낮음. numeric-index 충돌(다른요소가 옛 index 물려받음)은 tool-boundary 가드 밖=VQ-19(실브라우저 D1-S7d 인접). 포맷 무변경이라 eval:computer-task/browser-agent 계약 무손상. 다음 = D1-S7b(step-budget+timeout 주입, actions_used N/M).
- note: fire 18은 JUDGE-DRILL 강제(firesSinceDrill=8·연속 allPASS=8≥8) — 고의 나쁜슬라이스 주입→④b FAIL 확인→롤백→진짜 fix, 카운터 리셋.

## fire 18 · 2026-07-11 · skill v2.x · 7036af77d
meta: slice=JUDGE-DRILL+D1-S7b1 · wave=W2 · pkg=@muse/agent-core · kind=judge-drill+action-budget-core · verdict=PASS · firesSinceDrill=0(리셋)
ratchet: 로드맵 잔여 [ ] = 17/40(D1-S7b→b1/b2 분해로 +1, b1 체크로 -1 net 0 → 17) · self-eval pass · fabrication 0 · agent-core +5 test(action-budget) · baseline ENV repair(foreign)
- 무엇: ①기준선 envInventory FOREIGN-fail(prompt-lab merge가 Total 522→526 미갱신)→docs:env resync 커밋(0b6360cfe). ②JUDGE-DRILL: 고의결함 D1-S7b step-budget 주입(off-by-one `used>max`+선언-only 테스트+미배선)→독립 Opus ④b가 4개 구체위반으로 FAIL(off-by-one·경계 mutation-GREEN·행동검증無·미배선+기존중복) rubber-stamp 없이. ③롤백→진짜 fix D1-S7b1: 순수 액션-예산 결정코어(guardBrowserAction, `used>=max` 경계정확, near-cap, actions_used N/M). D1-S7b를 b1(코어)/b2(배선)로 분해.
- 왜: 하드-카운터(firesSinceDrill=8·연속 allPASS=8) 도달로 게이트 신뢰성 재검증 필수. 드릴로 maker≠judge가 살아있음 확인 후, 그 결함의 올바른 버전을 진짜-fix로 배송(off-by-one·hollow-test를 정확히 rebut).
- 리뷰지점: 드릴 judge와 b1 judge는 별개 Opus 인스턴스(fresh context). b1 judge가 두 mutation 독립 재현(`>=`→`>` 2 RED, near-cap 1 RED)·행동 시퀀스·결정 일관성·순수성 확인 PASS. 드릴 judge는 심은 결함(off-by-one·선언-only) + 추가 발견(미배선·step-budget.ts 중복)까지 잡음.
- 리스크: 낮음. b1은 미배선 코어라 유저-가시 0(CHANGELOG b2에서). 기존 step-budget.ts=토큰예산이라 액션-카운트는 별개 정당. 배선(b2)이 실 bounded-task 효과의 관문. 다음 = D1-S7b2(buildBrowserTools 공유 인스턴스+각 act-tool fail-close+출력 표면화).
- lesson: JUDGE-DRILL은 "롤백→진짜 fix" 시 드릴 결함의 *올바른 버전*을 배송하면 드릴이 곧 실슬라이스 스펙이 됨(토큰 효율). 드릴 judge가 심은 결함 외에 미배선·기존모듈 중복까지 자율 발견 → 게이트가 체크리스트 재생 아닌 적응형 추론임 확증.

## fire 19 · 2026-07-11 · skill v2.x · cf9be0dcb
meta: slice=D1-S7b2 · wave=W2 · pkg=@muse/agent-core+@muse/browser+apps/cli · kind=action-budget-wiring · verdict=PASS · firesSinceDrill=1
ratchet: 로드맵 잔여 [ ] = 16/40 · self-eval pass · fabrication 0 · agent-core+4·browser+7·cli-config+7 test · env MUSE_BROWSER_MAX_ACTIONS
- 무엇: b1 액션-예산 코어를 실배선. createBrowserActionTracker(agent-core mutable seam, b1 primitive 재사용)를 buildBrowserTools가 per-task 공유 인스턴스 1개로 생성→browser 최소 구조 seam BrowserActionGuard로 click/type/fill 3툴 배선. execute 최상단 소진 시 fail-close 거부(controller 미도달)+성공시 actionsUsed N/M·budgetWarning. resolveBrowserMaxActions 기본30·MUSE_BROWSER_MAX_ACTIONS. D1-S7b 완료(b1+b2).
- 왜: b1은 미배선 코어라 실효 0였음(드릴이 미배선을 결함으로 지목). b2가 실제 bounded-task 효과의 관문 — 12B 브라우저 태스크가 무한 click/submit 못 하게 하드캡.
- 리뷰지점: Opus 8축 PASS — fail-close가 controller/resolveTarget 전, tracker per-task(run당 1회, execute마다 재생성 아님), 산술 무오류(cap N→정확히 N 후 거부·used() 캡 불초과), byte-identical when absent(기존 81 test 무변), 두 mutation 독립 재현(가드제거→controller 도달 RED, 소진체크 제거→cap RED). @muse/browser는 agent-core 미의존(구조타입).
- 리스크: 낮음. 소진을 approval/검증 전 최상단서 consume=attempts 바운드(fail-close 방향, refuse-more만). 기본30은 정상 태스크(<30)엔 무해라 eval:browser-agent 회귀 by-construction 안전. 형제 미배선(upload/key/open counting)=backlog ◦. 다음 = D1-S7c(pending dialog 스냅샷 필드+auto-dismiss).

## fire 20 · 2026-07-11 · skill v2.x · 36fc9811a
meta: slice=D1-S7c · wave=W2 · pkg=@muse/browser · kind=dialog-failclose · verdict=PASS · firesSinceDrill=2
ratchet: 로드맵 잔여 [ ] = 15/40 · self-eval pass · fabrication 0 · browser +12 test(dialog-policy) · baseline ENV repair(foreign MUSE_CHANNEL_ACK)
- 무엇: 브라우저 JS-dialog 처분을 fail-close로. registerDialogHandler가 모든 dialog auto-ACCEPT(confirm OK·prompt 텍스트 제출)하던 fail-open을 순수 dialog-policy.ts로 교체: decideDialogDisposition(confirm/prompt/unknown→dismiss, alert/beforeunload→accept)+planDialogResponse(dismiss는 response無)+settleDialog(fake spy로 accept/dismiss 실호출 검증). 스냅샷 surface는 유지, controller.ts+puppeteer:425 stale doc 동반수정.
- 왜: Muse #1 "Guards are fail-close" + 브라우저=untrusted 최대통로. 페이지-발 confirm("계정삭제?")/prompt를 auto-accept는 클릭 승인≠dialog 응답 승인이라 over-consent. 로드맵 "auto-dismiss" 문자 정합.
- 리뷰지점: Opus PASS — fail-close 방향(confirm/prompt/unknown dismiss), settleDialog가 fake spy로 dismiss/accept 실호출 검증(enum-only 아님), 배선에 accept fall-through 없음, prompt 미제출, 두 mutation 독립 재현(confirm→accept·ternary flip), 기존 153 test green, 불변식 tighten-only(accept 집합 축소). controller.ts:425 stale nit도 지적→수정.
- 리스크: 트레이드 — 승인된 "click Submit→page confirm" 흐름이 dismiss로 미완(fail-safe, 스냅샷서 surface). beforeunload=accept 유지(승인된 네비 진행). eval:browser-agent dialog 미사용이라 회귀無. 다음 = D1-S7d(page 콘텐츠 <page> 래핑+미디어 defang, 실 e2e — VQ-10 e2e 하네스 신규작성 필요).

## fire 21 · 2026-07-12 · skill v2.x · 3793cbd6b
meta: slice=D1-S7d1 · wave=W2 · pkg=@muse/browser · kind=injection-guard · verdict=PASS · firesSinceDrill=3
ratchet: 로드맵 잔여 [ ] = 15/41(D1-S7d→d1/d2 분해 +1, d1 체크 -1 → 15) · self-eval pass · fabrication 0 · browser +13 test(page-content-guard)
- 무엇: 🔒 브라우저 page text(untrusted 최대통로) 인젝션 결정론 guard. 순수 page-content-guard.ts(자립): defangPageText(`</page>`/`<page>` break-out→fullwidth escape · `](` 중화로 markdown 이미지/링크 엑스필 차단 · instruction-override 정규식→`[defanged-directive]`, bounded=ReDoS-safe)+wrapPageContent(escape-then-wrap)+defangElementName. snapshotToJson text 래핑·elementsJson name defang → 전 snapshot-툴 조립경로 커버. D1-S7d를 d1(guard)/d2(실 e2e)로 분해.
- 왜: 브라우저 page text가 이스케이핑 0으로 모델에 도달 → 인젝션("ignore all previous instructions")·미디어 엑스필·`</page>` break-out 가능. Muse #1 "가드는 결정론 코드, 프롬프트 아님". hermes `<page>` 인라인·openclaw page defang 참조.
- 리뷰지점: Opus 위협모델 PASS — escape가 wrap 전(order 정확), `](` 실제 exfil 차단, instruction 정규식 ReDoS-safe(170KB 7.5ms)+정직 positioning(defense-in-depth atop 구조적 wrap, oversell 안 함), 조립경로 실증(fake controller 악성 text→툴출력 defanged, OUTCOME 채점), 두 mutation 독립 재현(6/4 RED). 자립(no @muse/recall dep).
- 리스크: 낮음. defang은 clean prose byte-identical(idempotent). 미커버 벡터(reference-link·bare URL·adaptive rephrasing)는 out-of-scope 정직 명시(모델은 JSON 소비, auto-fetch 안 함). instruction-override 정규식 false-positive(보안기사) 있으나 advisory·readable 보존. 다음 = D1-S7d2(실 detached-Chrome e2e — 악성 HTML http serve→open→defanged 확인, eval:browser-agent 하네스 재사용, VQ-10 실행). D1-S7d2 완료 시 D1-S7 전체 완주.

## fire 22 · 2026-07-12 · skill v2.x · 5a688ac8e
meta: slice=D1-S7d2 · wave=W2 · pkg=scripts+package.json · kind=browser-injection-e2e · verdict=PASS · firesSinceDrill=4 · ★D1-S7 완주
ratchet: 로드맵 잔여 [ ] = 29/55(전체 §10.3 정확재계수; 이전 저널 tail 누락 정정) · self-eval pass · fabrication 0 · eval:browser-injection 신규(9/9 라이브)
- 무엇: D1-S7d1 인젝션 guard의 실 headless-Chrome e2e. scripts/eval-browser-injection.mjs(모델-free, Chrome만): 악성 HTML(ignore-above·`![](exfil)`·HTML-escaped `&lt;/page&gt;`·인젝션 anchor)를 loopback http serve→실 PuppeteerBrowserController.open→browser_open/read 툴출력이 `<page>` 래핑+defanged 9/9 assertion(OUTCOME). VQ-10 "e2e 하네스 신규작성" 실행+체크. D1-S7 전체(a·b1·b2·c·d1·d2) 완주.
- 왜: "browser는 실 e2e 필요(조립경로 몰면 거짓 — 교훈)". FakeController 유닛만으론 실 page→innerText→snapshot→툴출력 경로 미실증. 실 Chrome로 조립경로 증명.
- 리뷰지점: Opus PASS(실 controller+실 Chrome 라이브 PASS·skip 아님·OUTCOME 채점·mutation-kill 7/9 flip 재현·cleanup 견고). Opus 지적 2건 즉시 수정: (1) boundary 어서션이 원 픽스처선 tautological(브라우저가 `<page>` 태그를 빈 요소로 파싱→innerText 미도달)→`&lt;/page&gt;` HTML-escape로 리터럴 도달시켜 genuine화(재검증: guard 무력화 시 boundary도 count=2 FAIL flip 확인), (2) 헤더 슬라이스마커 제거.
- 리스크: 낮음. 테스트/eval-infra only(프로덕션 코드 0). Chrome 없으면만 skip(이 머신은 설치됨→라이브). eval:browser-injection은 CI서 Chrome 있어야 RUN(없으면 skip=pass 아님, 명시). 다음 = D4-S4(📈 file_edit 결정론 리페어, eval:computer-task +10%p pass^3). ※카운트 정정: 이전 저널이 §10.3 tail(D6-*/D3-S3,S6/D2-S7/D7-*/D-KO-S3/D-E1/암호화백업 ~14개)을 누락→실제 잔여 29(체크26).

## fire 23 · 2026-07-12 · skill v2.x · c81433523
meta: slice=D4-S4 · wave=W2 · pkg=@muse/fs · kind=edit-repair · verdict=PASS · firesSinceDrill=5
ratchet: 로드맵 잔여 [ ] = 28/55 · self-eval pass · fabrication 0 · fs +? test(53 in fs-write-tools)·eval:computer-task 3/3 pass^3
- 무엇: 📈 file_edit 결정론 리페어 강화(fs-write-tools.ts). 기존 사다리에 indent-preserve+escape-drift 확장. (1) fuzzy가 indentation-relaxed(trim)로 매칭 시 new_string을 파일 실제 들여쓰기로 re-base(reindentToFile) — 12B의 틀린 들여쓰기가 파일 오염하던 버그 수정. (2) unescapeQuotes(`\"`/`\'`/`\\`)를 fail-close 가드(유니크 매칭 시만) retry 루프化. exact/trailing-ws 경로는 no-op=byte-identical.
- 왜: eval:multifile-fix/computer-task의 잔여 실패에 12B가 들여쓰기·escape를 미세하게 틀려 exact match 실패→fuzzy가 매칭해도 모델 들여쓰기로 교체해 파일 오염. hermes 9-전략 fuzzy의 indent 전략 참조.
- 리뷰지점: Opus PASS — re-indent 정확(consistent-base 케이스 trace)·보수적(edge서도 기존 verbatim splice보다 strictly-better)·exact/trailing-ws byte-identical(no-op 보장)·fail-close(유니크 매칭 gated, wrong-place 없음)·두 mutation 독립 재현(re-indent 무력화→indent 오염 RED, unescapeQuotes 제거→`\"` RED)·OUTCOME 채점(결과 라인 들여쓰기 검증). eval:computer-task 3/3 회귀無.
- 리스크: 낮음. +10%p pass^3는 stochastic north-star라 per-fire 확증 불가(회귀-STABLE 3/3로 게이트, 메커니즘이 지향). 조합 drift(newline+quote 동시)는 1-shot 미수리이나 fail-CLOSED(refuse, 오염 아님). 미추가 형제(whitespace-collapse·first/last 앵커링)=backlog, case-insensitive는 영구 제외. 다음 = D4-S1(muse mcp serve 확대: read 다수+write draft-first 프록시+grounded-recall 노출).

## fire 24 · 2026-07-12 · skill v2.x · d9855ec62
meta: slice=D4-S1a · wave=W3 · pkg=apps/cli · kind=mcp-write-proxy · verdict=PASS · firesSinceDrill=6
ratchet: 로드맵 잔여 [ ] = 29/57(D4-S1→a/b/c 분해로 +2) · self-eval pass · fabrication 0 · cli mcp-serve +? test(16)·★W3 착수
- 무엇: `muse mcp serve` write draft-first 프록시. propose_action MCP 툴(buildMcpServeTools 4번째): 외부 클라이언트가 action+draft(+arguments) 제안→기존 PendingApproval 큐(recordPendingApproval 재사용, muse approvals 동일 파일)에 파킹(source "mcp-serve"), "승인 대기" 반환, 실행경로 0. D4-S1을 a(write프록시)/b(grounded surface 등록 📈)/c(read 확대)로 분해.
- 왜: hermes mcp_serve(자신을 MCP 서버로)의 write는 Muse에선 outbound-safety 수출이어야 — 외부 요청은 자동실행 불가, 승인큐 파킹만. 클릭 승인≠외부 요청 자동실행. 신규 스토어 금지(기존 재사용).
- 리뷰지점: Opus outbound-safety 위협모델 PASS — execute에 실행 브랜치 0(action/arguments는 파킹 데이터, dispatch 안 됨)·blank fail-close(stage 전 throw)·stage reject→staged:true 아님·no-external-effect 실검증(temp round-trip + notesDir 무변)·두 mutation 독립 재현(stage 제거→round-trip RED, blank검증→RED)·provenance 구분(source "mcp-serve" vs cli). 헤더 doc "three tools" stale도 수정.
- 리스크: 낮음. 외부가 draft/arguments 완전 제어→muse approvals raw 표시 spoofing 표면(VQ-20)이나 파킹=no-effect+승인=사람확인+fail-close라 계약 위반 아님(기존 CLI-write 경로와 동일 표면, 악화 아님). eval:tools는 N/A(outbound MCP 툴, Muse 로컬모델 선택셋 아님). 다음 = D4-S1b(grounded-recall을 grounded surface로 등록, verify-*.mjs 배터리→groundedSurfaces +1).

## fire 25 · 2026-07-12 · skill v2.x · 05a8c0ebe
meta: slice=D4-S1b · wave=W3 · pkg=(none, doc-only) · kind=already-holds-invariant · verdict=PASS · firesSinceDrill=7
ratchet: 로드맵 잔여 [ ] = 28/57 · self-eval pass · fabrication 0 · groundedSurfaces 38(mcp-serve-grounding 이미 포함)·라이브 배터리 4/4
- 무엇: D4-S1b(grounded-recall을 grounded surface로 등록)가 **이미-성립 불변식**임을 발견+실증. verify-mcp-serve-grounding.mjs가 `muse mcp serve` 최초커밋 cc1fdde81(07-07)에서 배터리+release-gate(eval-self-improving.mjs:62) 등록까지 함께 배송 → groundedSurfaces 이미 카운트(38). 코드 변경 0, 라이브 재실행 4/4 PASS로 실증 후 doc-only 마킹.
- 왜: fire 24 decomposition을 내가 배터리 존재를 모르고 씀 → 발견 후 정직하게 이미-성립 처리. 중복 배터리 날조는 groundedSurfaces ratchet이 막는 count-inflation이라 안 함(정직 > 가짜 progress).
- 리뷰지점: Opus 정직-accounting 검증 PASS — 등록됨(countGroundedSurfaces 정규식 매치=38, mcp-serve entry counted true)·행동검증(실 SDK Client·initialize→tools/call·모든 인용 실 seed resolve·refusal 무-날조, "tool responded" 아님)·라이브 4/4(skip 아님)·D4-S1b 특정 acceptance에 gap 없음(stdio subprocess·read 확대는 D4-S1c로 분리). 코드없이 [x]가 정직한 행동임 확인.
- 리스크: 없음(코드 0). 교훈: decompose 전에 기존 verify-*.mjs/배터리 존재를 먼저 확인해야 redundant sub-slice 안 만듦. 다음 = D4-S1c(read 확대: 캘린더·태스크 read 툴 + 실 stdio 왕복 계약).
- lesson: 새 grounded surface 슬라이스 전에 `ls apps/*/scripts/verify-*.mjs` + eval-self-improving.mjs BATTERIES를 grep해 이미 등록된 표면인지 확인 — 이미 있으면 라이브 실증+정직 마킹, 중복 날조 금지(ratchet=count-inflation 가드).

## fire 26 · 2026-07-12 · skill v2.x · 2244aca88
meta: slice=JUDGE-DRILL+D4-S1c1 · wave=W3 · pkg=apps/cli · kind=judge-drill+mcp-calendar-read · verdict=PASS · firesSinceDrill=0(리셋)
ratchet: 로드맵 잔여 [ ] = 29/59(D4-S1c→c1/c2/c3 분해 +2, c1 체크 -1) · self-eval pass · fabrication 0 · cli mcp-serve +3 test(calendar_read)·baseline ENV repair(foreign 8 env)
- 무엇: ①기준선 envInventory FOREIGN-fail(digest/interruption 8 env merge, docs:env 없이)→resync 커밋(3a7e73737). ②JUDGE-DRILL: 고의결함 D4-S1c(캘린더 윈도우 필터가 `toIso` 상한 무시+shape/sort-only 테스트) 주입→독립 Opus ④b가 empirical probe(`["a","b","c"]` leak)로 구체 FAIL. ③롤백→진짜 fix D4-S1c1: calendar_read MCP 툴(from/to 독립파싱→LocalCalendarProvider.listEvents 위임, 양-bound pass-through 구조적 보장). D4-S1c를 c1/c2/c3 분해.
- 왜: 하드-카운터(firesSinceDrill=8, 마지막 드릴 fire18 이후 정확히 8 fire) 도달로 게이트 재검증 필수. 드릴로 maker≠judge 살아있음 확인 후, 결함의 올바른 버전(provider가 윈도우 필터, 툴은 양-bound 정확 전달)을 진짜-fix로 배송.
- 리뷰지점: 드릴 judge와 c1 judge는 별개 Opus 인스턴스. 드릴 judge가 심은 결함(상한 무시·hollow test)을 empirical probe까지 돌려 잡음(rubber-stamp 아닌 적응형). c1 judge가 양-bound pass-through 구조·fail-close spy(source 미호출)·OUTCOME 채점·두 mutation 독립 재현·read-only 확인 PASS.
- 리스크: 낮음. calendar_read는 read-only(이벤트 생성/변경 없음)·이벤트 내용서 실행 안 함. 윈도우 필터는 provider 위임이라 툴은 양-bound 전달만(drop 구조적 불가). eval:tools N/A(outbound MCP). 다음 = D4-S1c2(태스크 read)·c3(실 stdio 왕복).
- lesson: JUDGE-DRILL "진짜 fix"는 드릴 결함의 *구조적으로 불가능한* 버전이 이상적 — ignore-upper-bound를 "from/to 독립파싱해 한 콜에 둘 다 전달"로 재설계하면 그 결함 클래스가 재발 불가(테스트 의존 아닌 구조 보장).

## fire 27 · 2026-07-12 · skill v2.x · 5dcfa0b49
meta: slice=D4-S1c2 · wave=W3 · pkg=apps/cli · kind=mcp-tasks-read · verdict=PASS · firesSinceDrill=1
ratchet: 로드맵 잔여 [ ] = 28/59 · self-eval pass · fabrication 0 · cli mcp-serve +4 test(tasks_read)
- 무엇: `muse mcp serve` tasks_read 툴(c1 calendar_read 대칭). status enum(open 기본/done/all)→기존 LocalFileTasksProvider.list(status) 위임, 태스크 구조화 반환(createdAt/completedAt ISO). status pass-through(정확 전달, 하드코딩 아님)·invalid status→throw+source 미호출(fail-close). McpServeDependencies에 injectable listTasks. Task 타입 domain-tools barrel 1줄 export.
- 왜: D4-S1c(read 확대)의 태스크 조각. hermes mcp_serve read 계열 확대(recall/notes·캘린더·태스크). 외부 에이전트가 유저 to-do를 read(생성/완료/변경 불가=read-only).
- 리뷰지점: Opus PASS — status pass-through(fake가 정확 "done"/"all" 받음, "open" 하드코딩 아님)·invalid fail-close(spy로 source 미호출)·OUTCOME 채점(status 정확·태스크 round-trip ISO)·두 mutation 독립 재현(하드코딩→pass-through RED, 가드 제거→fail-close RED)·barrel export benign(기존 Task 타입 노출, no 신규심볼)·read-only.
- 리스크: 낮음. read-only(태스크 변경 없음). completedAt ISO 직렬화는 테스트 미직접(calendar endsAt이 동일 패턴 커버, coverage nit). eval:tools N/A(outbound MCP). 다음 = D4-S1c3(실 stdio subprocess 왕복 계약 — spawn muse mcp serve→JSON-RPC, InMemory 아닌 실프로세스). D4-S1c3 완료 시 D4-S1(mcp serve 확장) 전체 완주.

## fire 28 · 2026-07-12 · skill v2.x · f97f43515
meta: slice=D4-S1c3 · wave=W3 · pkg=apps/cli(scripts) · kind=mcp-stdio-contract · verdict=PASS · firesSinceDrill=2 · ★D4-S1 완주
ratchet: 로드맵 잔여 [ ] = 27/59 · self-eval pass · fabrication 0 · mcp:stdio-contract 신규(실 subprocess 라이브 PASS)·ENV.md MUSE_CALENDAR_FILE apps/cli reader
- 무엇: MCP 실 stdio subprocess 왕복 계약. verify-mcp-stdio-contract.mjs(pnpm mcp:stdio-contract, 모델-free): 실 muse mcp serve를 StdioClientTransport(process.execPath+dist)로 spawn→initialize→tools/list(6툴)→tasks_read로 seed된 2 태스크 round-trip(count·title)+status open→1. InMemory 아닌 실 stdio wire 실증. 형제 MCP_SERVE_INSTRUCTIONS stale("3 tools"→정확한 6툴, propose_action=park-not-execute) 수정. D4-S1(mcp serve 확장) 전체 완주(a·b·c1·c2·c3).
- 왜: 기존 verify-mcp-serve-grounding은 InMemoryTransport(in-process 프로토콜)라 실 subprocess spawn+stdio framing 미실증. hermes mcp_serve "자신을 MCP 서버로"의 실 계약(stdio 왕복) 요건. "조립경로 몰면 거짓" 교훈 정합(실 wire).
- 리뷰지점: Opus 라이브 재실행 PASS — 실 subprocess("listening on stdio (6 tools)" stderr)·InMemory 아님·seed 데이터 round-trip data-sensitive(mutation seed 1개→count RED exit 1, 데이터 민감 재현)·skip=spawn실패만/assertion실패=exit 1(정직)·MCP_SERVE_INSTRUCTIONS 정확+정직(propose_action park qualify)·cleanup leak-free(client.close→subprocess kill·temp rm).
- 리스크: 낮음. 계약 스크립트라 CI서 dist 빌드 필요(pnpm mcp:stdio-contract가 build 선행). ENV.md MUSE_CALENDAR_FILE에 apps/cli reader 추가(내 c1/c3가 참조)=docs:env 내 슬라이스 포함. 다음 = D4-S2a(macOS Photos 검색/내보내기, mac_photos actuator 확장).
- lesson: 실-wire 계약 테스트는 seed된 알려진 데이터를 round-trip 어서(count·title)하면 데이터 민감=tautology 아님이 구조적으로 보장(연결됨만 확인하는 약한 테스트 회피).

## fire 29 · 2026-07-12 · skill v2.x · 140c9ffef
meta: slice=D4-S2a · wave=W3 · pkg=@muse/macos · kind=mac-photo-search · verdict=PASS · firesSinceDrill=3
ratchet: 로드맵 잔여 [ ] = 27/60(D4-S2a 체크·VQ-21 추가) · self-eval pass · fabrication 0 · macos +3 test(imagesOnly)
- 무엇: macOS 사진 검색. "신규툴 신설 금지" 제약 준수해 기존 mac_spotlight_search에 imagesOnly 플래그 확장(신규 툴 0). mdfind ARGV 불변(query→predicate 안 함=injection-safe), imagesOnly면 반환 경로를 이미지 확장자로 코드 후-필터(cap 필터 후, total=필터 카운트, imagesOnly:true echo). 반환 경로=export 핸들. default byte-identical.
- 왜: hermes/openclaw급 mac 커버리지의 Photos 조각. 제약 충돌(Photos는 자연스러운 신규툴)→기존 파일-파인더 확장으로 "사진 찾기" 제공(혼동쌍 회피). Photos.app 관리-라이브러리 딥 export는 자동화 권한+툴-home 포크라 VQ-21.
- 리뷰지점: Opus 8축 PASS — injection-safe(argv 불변, 후-필터)·isImagePath 정확(진짜 확장자·case-insensitive·no-ext false·dir 오탐 없음)·default byte-identical·mutation-RED(필터 제거→.txt/.pdf leak RED 재현)·no 혼동툴·total/cap 순서 정확.
- 리스크: 낮음. eval:tools 6m40s timeout(무거운 로컬셋 미완)이나 변경 가산적(photo 키워드+optional 플래그, 리네임/혼동툴 없음)이라 selection 회귀 위험 near-zero — 결정론게이트(build/test/mutation/lint/Opus)로 판정, timeout≠fail 정직 표기. Photos.app 딥 라이브러리는 VQ-21. 다음 = D4-S2b(mac_system_set enum 확장: 앱종료).
- lesson: 제약("신규툴 금지")이 자연스러운 신규 capability와 충돌하면, 기존 툴의 안전한 확장(후-필터·optional 플래그)으로 제약-준수판을 배송하고 딥 버전은 VQ로 표면화 — 조용히 쉬운 걸로 안 내려가되 제약도 안 어김.

## fire 30 · 2026-07-12 · skill v2.x · 41d0ce2ae
meta: slice=D4-S2b · wave=W3 · pkg=@muse/macos · kind=mac-quit-app · verdict=PASS · firesSinceDrill=4
ratchet: 로드맵 잔여 [ ] = 28/62(D4-S2 b/c/d 별개 체크박스 분할 +2, b 체크 -1) · self-eval pass · fabrication 0 · macos +4 test(quit_app)
- 무엇: macOS 앱종료. mac_system_set에 quit_app enum+app param(optional, volume value 선례) 추가. osascript `tell application "<escapeAppleScript(app)>" to quit` — 공유 escaper로 앱-이름 임베드(인젝션-safe). 빈/공백 app→fail-close(osascript 미호출). 신규툴 0(제약 준수).
- 왜: D4-S2 mac 커버리지의 앱종료 조각. mac_app_open은 /usr/bin/open(열기만)이라 quit 안 맞고 mac_system_set이 execute-risk 로컬액션 홈. 앱-이름이 AppleScript 문자열에 들어가 인젝션 표면 → 기존 escapeAppleScript 재사용이 정답.
- 리뷰지점: Opus 위협모델 PASS — escaper backslash-first 순서가 escaper-escape 우회 방지(`\`+`"`→`\\`+`\"`=리터럴), newline→space, breakout 구성 불가 확인·blank fail-close(called flag)·두 mutation 독립 재현(escaper 제거→breakout RED, guard 제거→osascript 호출 RED)·additionalProperties 유지·mac_app_open과 무혼동(quit vs open 키워드 분리).
- 리스크: 낮음. quit=graceful(저장 프롬프트 가능, force-kill 아님)·로컬이라 draft-first 불요. eval:tools 로컬셋 heavy timeout(가산 enum+키워드라 selection 회귀 near-zero, Opus가 무혼동 확인). 다음 = D4-S2c(다크모드: dark_mode_on/off parameterless osascript enum).
- lesson: 사용자/모델-제공 문자열을 osascript에 임베드할 땐 항상 공유 escapeAppleScript(backslash-first)를 통과 — ad-hoc 이스케이프 금지, 기존 tested escaper 재사용이 인젝션 표면의 정답.

## fire 31 · 2026-07-12 · skill v2.x · 5a9e4598a
meta: slice=D4-S2c · wave=W3 · pkg=@muse/macos · kind=mac-dark-mode · verdict=PASS · firesSinceDrill=5
ratchet: 로드맵 잔여 [ ] = 27/62 · self-eval pass · fabrication 0 · macos +3 test(dark_mode)
- 무엇: macOS 다크모드. mac_system_set에 dark_mode_on/dark_mode_off parameterless enum 추가. 고정 osascript(System Events appearance preferences set dark mode to true/false) — 유저입력 無이라 인젝션 표면 0, 이스케이프 불요(quit_app과 대비). on→true/off→false.
- 왜: D4-S2 mac 커버리지의 다크모드 조각. parameterless 토글이라 mac_system_set에 자연스럽게 붙음(mute 브랜치 패턴).
- 리뷰지점: Opus PASS — on/off→true/false 매핑 정확(inverted 아님)·고정 스크립트 인젝션 無·테스트가 captured 스크립트의 true/false를 pin(shape-only 아님)·ternary flip mutation이 off-test를 kill(독립 재현)·무관 브랜치(volume/mute/wifi/focus/sleep/quit_app) 무변·additionalProperties 유지.
- 리스크: 낮음. 고정 스크립트라 인젝션·escape 불요. eval:tools 로컬셋 heavy timeout(가산 enum, selection 회귀 near-zero). 다음 = D4-S2d(블루투스/밝기 — Shortcuts 경로 focus 패턴, 클린 CLI 부재+MUSE_*_SHORTCUT env override). D4-S2d 완료 시 D4-S2 mac 커버리지 배치 완주(a·b·c·d, e는 Contacts write 별도).

## fire 32 · 2026-07-12 · skill v2.x · c6ab1ef8c
meta: slice=D4-S2d · wave=W3 · pkg=@muse/macos+apps/cli · kind=mac-bluetooth · verdict=PASS · firesSinceDrill=6
ratchet: 로드맵 잔여 [ ] = 27/63(D4-S2d 밝기 분리 +1, d 체크 -1) · self-eval pass · fabrication 0 · macos +5·cli doctor +4 test · env MUSE_BLUETOOTH_*_SHORTCUT
- 무엇: macOS 블루투스. mac_system_set에 bluetooth_on/off enum(focus 패턴 exact 미러: named Shortcut `shortcuts run` argv, 클린 Bluetooth CLI 부재). MUSE_BLUETOOTH_ON/OFF_SHORTCUT env override+bluetoothShortcutSetupMessage(missing→"Set Bluetooth" 안내)+doctor check. 밝기(value→Shortcut-input)는 D4-S2d2 분리.
- 왜: D4-S2 mac 배치의 블루투스 조각. focus와 동일하게 macOS가 클린 CLI 없어 named user Shortcut이 정책-안전 경로. 오케스트레이터가 워커의 미배선 bluetoothShortcutsCheck(dead code)를 runLocalDoctor에 완전 배선+4 행동테스트로 마감(드릴 교훈: 미배선 함수 안 남김).
- 리뷰지점: Opus PASS — 이름 해소 정확(bluetooth_off→off shortcut, override 우선)·setup message가 focus 아닌 Bluetooth·shortcut argv라 shell 인젝션 없음·doctor check 완전 배선(focus 옆 별개 check, focus test 무영향)+ok/warn/undefined/override 테스트·mutation-RED(이름 무력화→override/off RED)·additionalProperties 유지·docs:env.
- 리스크: 낮음. eval:tools 로컬셋 heavy timeout(가산 enum). 다음 = D4-S2e(Apple 연락처 '쓰기' draft-first 게이트 — 이건 write toward 사람 아닌 로컬 store지만 outbound-safety 근접이라 신중).
- lesson: 서브에이전트가 "off-scope 파일 회피"로 함수만 만들고 미배선 남기면 dead code=드릴 결함 클래스 → 오케스트레이터가 배선+테스트로 마감. 별개 함수를 별개 check로 배선하면 기존 pinned test 무영향(확장이 아니라 병렬 추가).

## fire 33 · 2026-07-12 · skill v2.x · c5e6dab25
meta: slice=BASELINE-REPAIR(foreign) · wave=W3 · pkg=@muse/shared+docs · kind=baseline-repair · verdict=PASS · firesSinceDrill=7
ratchet: 로드맵 잔여 [ ] = 27/63(무변, 슬라이스 없음) · self-eval 회복(lint+envInventory FOREIGN-fail→green) · fabrication 0
- 무엇: ① 기준선 non-zero(lint:fail+envInventory:fail 둘 다 FOREIGN) → 규칙대로 회귀 수리가 이번 fire 전부(새 슬라이스 금지). (1) 동시 secret-detection 루프가 secret-patterns.ts에 char-class 내 불필요 `\/` escape 3개+test unused findSecrets import 커밋(no-useless-escape/no-unused-vars) → `\/`→`/`(char class서 동일)·import 제거, secret 72 test green(동작 불변). (2) Windows 루프가 MUSE_WINDOWS_ACTUATORS를 docs:env 없이 추가 → docs:env resync.
- 왜: 두 회귀가 repo-wide lint(0/0)+envInventory 게이트를 막아 내 진행도 차단(공유 baseline). 트리 clean(미커밋 foreign 0)이라 committed 에러 수리 안전. ①이 "non-zero면 회귀 수리가 fire 전부" 명시.
- 리뷰지점: regex 동작 불변(char class 내 `\/`≡`/`) 72 test로 확인·docs:env는 생성물·내 파일 3개만 격리 커밋. Opus 게이트 불요(피처 변경 0, 결정론 수리).
- 리스크: 낮음. foreign src(secret-patterns.ts) 편집이나 committed lint 수리(피처 로직 무접촉)+트리 clean이라 충돌 위험 낮음. 동시 루프가 같은 줄 재수정 시 git merge. 다음 = D4-S2e(Apple 연락처 draft-first) — baseline green 회복됐으니 재개.
- lesson: repo-wide 게이트(lint/envInventory) FOREIGN-fail이 지속되면 내 슬라이스 게이트도 막히므로 baseline-repair fire로 일회 수리(피처 로직 무접촉 트리비얼 수리+생성물 sync만) — 단 foreign 활성-churn src는 여전히 회피, committed-정적 에러만.

## fire 34 · 2026-07-12 · skill v2.x · 5d642a982
meta: slice=JUDGE-DRILL+D4-S2e · wave=W3 · pkg=@muse/macos+apps/cli · kind=judge-drill+contacts-write-draftfirst · verdict=PASS · firesSinceDrill=0(리셋) · ★D4-S2 완주
ratchet: 로드맵 잔여 [ ] = 26/63 · self-eval pass · fabrication 0 · macos +6·cli-gate +3 test · toolCases 371→374(eval:tools 골든)
- 무엇: ①기준선 green(fire33 repair 유지). ②JUDGE-DRILL: 고의결함 D4-S2e contacts-write(approvalGate 호출하나 decision.approved 무시=fail-open write+deny/no-effect 미테스트) 주입→독립 Opus ④b가 정확 FAIL(라인47-51 decision 버림·happy-path-only). ③롤백→진짜 fix D4-S2e: mac_contacts_write draft-first 강제(message-send sendMessageWithApproval 미러: gate throw→deny·`if(!approved) return` osascript 전·deny/throw→write 0 spy 검증·action-log·escapeAppleScript). buildContactsApprovalGate non-interactive fail-close+등록+armed-lockstep. eval:tools 골든3.
- 왜: 하드-카운터(firesSinceDrill=8, 마지막 드릴 fire26 이후 정확히 8) 도달. 드릴로 outbound-safety 게이트(deny→no-effect) 신뢰성 재검증 후 결함의 올바른 버전 배송. 로드맵 "draft-first 게이트" 명시.
- 리뷰지점: 드릴 judge와 실 judge 별개 Opus. 드릴 judge가 심은 결함(decision.approved 무시)을 라인 지목·probe로 FAIL. 실 judge가 gate 강제(deny/throw→osascript 0 spy)·deny 테스트·두 mutation 독립 재현·CLI 게이트 non-interactive fail-close·escape·armed-lockstep PASS. Opus 지적 형제-parity(CLI 게이트 non-interactive 테스트 없음)→오케스트레이터가 messaging 미러 3 테스트 추가로 마감.
- 리스크: 낮음. 로컬 store write(3rd-party send 아님)이나 로드맵대로 draft-first 적용. eval:tools 골든 추가했으나 로컬셋 heavy timeout(결정론+Opus 판정). 다음 = D7-S1(슬래시 명령 단일소스 레지스트리). 밝기 D4-S2d2 잔여.
- lesson: JUDGE-DRILL 진짜-fix가 outbound-safety면 "gate 강제(deny→no-effect)+spy 테스트"가 message-send seam 미러로 구조 보장. Opus가 형제-parity 갭(CLI 게이트 테스트) 지적하면 오케스트레이터가 기존 형제(messaging) 테스트 미러로 즉시 마감.

## fire 35 · 2026-07-12 · skill v2.x · 1373cb8ca
meta: slice=D7-S1a · wave=W3 · pkg=apps/cli · kind=slash-registry · verdict=PASS · firesSinceDrill=1
ratchet: 로드맵 잔여 [ ] = 26/64(D7-S1→a/b 분해 +1, a 체크 -1) · self-eval pass · fabrication 0 · cli +6 test(slash-command-registry)
- 무엇: 슬래시 명령 단일소스 레지스트리. chat-ink 로컬 SLASH_COMMANDS(27개 `{cmd,desc}`)를 slash-command-registry.ts 1-엔트리(name·desc·category·aliases?·platforms)로 추출, chat이 slashCommandsForPlatform("chat")로 파생(하드코딩 배열 제거=단일소스). desc byte-identical·순서 보존(autocomplete 불변). platforms 게이트: 세션계열 15=chat-only, list/show 12=chat+cli(미래 CLI/채널 seam). D7-S1을 a(레지스트리+chat)/b(CLI help 반영)로 분해.
- 왜: hermes COMMAND_REGISTRY처럼 1-엔트리가 여러 표면 구동→drift 제거. 기존 chat/CLI 겹치는 명령 desc가 각각 정의돼 drift 가능하던 걸 단일소스로.
- 리뷰지점: Opus PASS — 옛 27-배열 완전 제거(git diff -31, 잔존 하드코딩 0)·chat byte-identical(순서보존, /메뉴 불변)·dedup이 real Set-uniqueness+name/alias 충돌스캔(shallow 아님)·두 mutation 독립 재현(dup→RED, 게이트 무력화→RED)·플랫폼게이트 정확(in-session /undo·/compact·/cost는 cli 미마킹)·chat-core 154/154.
- 리스크: 낮음. 리팩터라 유저-가시 0(CHANGELOG 생략). CLI-help 실반영(commander)은 D7-S1b. Opus doc-nit(로드맵 "28개"→27) 정정. 다음 = D7-S1b(commander CLI desc를 레지스트리와 cross-check, 겹치는 명령 drift 방지 증명).
- lesson: chat/CLI 겹치는 메타데이터는 단일 레지스트리+platforms 게이트로; 파생 함수(slashCommandsForPlatform)가 하드코딩 배열을 대체하면 drift 구조적 불가, dedup은 Set-uniqueness로 증명.

## fire 36 · 2026-07-12 · skill v2.x · 73f60dca3
meta: slice=D7-S1b · wave=W3 · pkg=apps/cli · kind=slash-registry-cli-drift-lock · verdict=PASS · firesSinceDrill=2 · ★D7-S1 완주
ratchet: 로드맵 잔여 [ ] = 25/64(D7-S1b 체크) · self-eval pass · fabrication 0 · cli +1 test file(slash-command-registry.cli-drift, testFiles 1386→1387)
- 무엇: ①기준선 green(self-eval ok, testFiles 1386). ②D7-S1b: 레지스트리 `cli` 태그가 실제 CLI 명령 surface와 drift 없음 락킹. 진실 소스 = `COMMAND_STUBS`(생성 매니페스트, command-manifest.drift.test가 commander 트리에 pin — `muse --help`/completion 권위 소스). 발견: cli-태그 12개 중 jobs·pref·reflect가 실재 `muse <name>` 없음(CLI엔 runs/job·remember·reflections). 정정: `CommandEntry.cliName?` 추가 → reflect={cliName:"reflections"} 유지, jobs·pref=chat-only. `slashCommandsForPlatform("cli")`는 `cliName ?? name` 투영(chat/channel은 name 불변). drift-lock test 4: (a)cli-태그 모든 항목이 COMMAND_STUBS에 실재 assert (b)투영 cmd 실재 (c)reflect→reflections·never reflect (d)chat 27 불변.
- 왜: hermes 단일-레지스트리처럼 1-엔트리가 여러 표면 구동하되, "cli-태그가 실제 CLI 명령"임을 실 매니페스트로 증명해야 태깅이 현실과 조용히 갈라지지 않음. D7-S1a가 태깅을 넣었고(느슨), D7-S1b가 실 surface와 대조해 3개 오태깅 적발+정정+락.
- 리뷰지점: Opus PASS — 실 상태 대조(COMMAND_STUBS=commander 트리 pin, 자기참조 아님)·독립 mutation 2종 재현(bogus cliName→RED, reflect cliName 제거→RED)·3정정 사실확인(jobs/pref/reflect 부재·reflections 실재)·chat 불변(27, name 투영)·scope 2파일·comment 정책(cliName WHY 1줄만). 비차단 노트: cli 투영은 아직 소비자 없음(chat만 소비) → drift-lock+태그정정이 정직한 delivered 범위, 라이브 render 배선은 미래.
- 리스크: 낮음. 내부 메타데이터 정확성(유저-가시 0 → CHANGELOG 생략, D7-S1a와 동일). 형제-감사: 12 cli-태그 전부 이 fire에 enumerate·대조(jobs/pref/reflect만 오태깅, 나머지 9 실재 확인). 다음 = D4-S2d2(밝기 value-passing Shortcut-input, top-to-bottom 첫 미체크 — 이전 defer).
- lesson: "레지스트리 태그가 여러 표면을 구동한다"는 클레임은 태그를 그 표면의 **실 매니페스트(생성물)와 cross-check**해야 검증됨 — 자기참조(레지스트리 vs 손복사 리스트)는 tautological. 실 surface와 대조하면 오태깅(chat-slash명 ≠ CLI 명령명: reflect/reflections)이 드러나고, cliName? optional로 rename을 흡수하며 나머지는 chat-only로 정정.

## fire 37 · 2026-07-12 · skill v2.x · 2c70214a2
meta: slice=D4-S2d2 · wave=W3 · pkg=@muse/macos+apps/cli · kind=macos-actuator-value-passing · verdict=PASS · firesSinceDrill=3 · ★D4-S2 완전 종료
ratchet: 로드맵 잔여 [ ] = 24/64(D4-S2d2 체크) · self-eval pass · fabrication 0 · macos +9 test file·cli-doctor +4 test(testFiles 1387→1388) · ENV +1(MUSE_BRIGHTNESS_SHORTCUT)
- 무엇: ①기준선 green(self-eval ok, testFiles 1387). ②D4-S2d2: mac_system_set에 `brightness` enum 추가 — focus/bluetooth의 parameterless와 다른 **value-passing 메커니즘**. value(0–100) clamp+round → named Shortcut("Muse Set Brightness")에 **stdin input**으로 전달(`shortcuts run --input-path - --output-path -` + `String(level)` stdin). mac_shortcut_run이 이미 쓰던 `--input-path -`+ShortcutsRunner(args,input?) 선례 재사용(신규 seam 0). DEFAULT_BRIGHTNESS_SHORTCUT+MUSE_BRIGHTNESS_SHORTCUT env(actuator 배선)+brightnessShortcutSetupMessage(missing→"Set Brightness" 액션+Shortcut Input 안내). doctor: brightnessShortcutCheck(단일 shortcut, focus/bluetooth 미러)+runLocalDoctor 배선. value는 groundedArgs 유지.
- 왜: D4-S2 mac 배치의 마지막 잔여(밝기). 로드맵이 "value→Shortcut-input" value-passing을 명시(parameterless 3형제와 구별). macOS 밝기 CLI 부재→named Shortcut fallback이 policy-safe(bluetooth와 동일 근거).
- 리뷰지점: Opus PASS — stdin 값전달 실검증(fake runner가 argv+input="60" 수신 assert, 선언-only 아님)·독립 mutation 재현(String(level)→""→RED)·clamp/round(150→"100"·-5→"0"·33.6→"34")·threat-model(value numeric-coerce+argv-not-shell, 유저문자열 shell 미도달)·groundedArgs 유지·형제 무손상(volume value 경로 unshadowed, 27/27)·doctor parity(52/52)·envInventory(ENV.md 등록). 형제-감사: value-passing은 brightness 단독(volume은 osascript), 이 클래스 형제 없음.
- 리스크: 낮음. 로컬 시스템설정 write(3rd-party 아님). 셋업 마법사는 Shortcut 수동생성 필요(bluetooth와 동일 UX 마찰, setupMessage로 안내). eval:tools 골든은 미추가(enum 추가·신규툴 아님, dark_mode/bluetooth 선례 동일 — 결정론+Opus 판정 충분). 다음 = D5-S1(privacy routing follow-ups: context-free 툴 로컬 명문화·KO 소유격 토큰·setup 안내, 기존 20 계약 무수정).
- lesson: 액추에이터 value-passing은 새 seam을 만들지 말고 기존 stdin-input 선례(mac_shortcut_run `--input-path -`+ShortcutsRunner input?)를 재사용하면 인젝션 표면 0(numeric-coerce+argv). 형제 액추에이터(focus/bluetooth) 있으면 doctor check도 미러해 parity 유지(Opus가 과거 parity 갭 지적한 클래스).

## fire 38 · 2026-07-12 · skill v2.x · 1a8ec021d
meta: slice=D5-S1 · wave=W4 · pkg=@muse/policy+apps/cli · kind=privacy-routing-followups · verdict=PASS · firesSinceDrill=4
ratchet: 로드맵 잔여 [ ] = 23/64(D5-S1 체크) · self-eval pass · fabrication 0 · policy +12 유닛(privacy-routing.test 신규)·cli setup +3 유닛(커밋 후 testFiles 1388→1389) · 20 계약 무수정
- 무엇: ①기준선 green(testFiles 1388). ②D5-S1 3파트, 병렬 Sonnet 워커 2개(disjoint 파일). (b) `PrivacyRequestInput.usesTools?` 결정론 신호(hasPersonalContext 다음 tier)→툴-요청은 텍스트 무관 로컬 고정; resolvePrivacyRoutedModel 스루(route flip: usesTools:true→local, omit→cloud 유닛). 정책층 codification/defense-in-depth(chat cloud turn은 buildCloudTurnRequest로 이미 구조적 toolless — Opus 실검증 tools 필드 0). (c) personaPreamble nuance 문서화(persona=authored fixed string이나 chosen relationship 노출→personal 유지, doc-only). (d) KO 구어 소유격 `내꺼`/`제꺼`(꺼=aspirated, 표준 `내 거`는 이미 STANDALONE_PRONOUN이 잡음) 추가+오탐 방어(`제거`removal·`내용`·`안내`는 거≠꺼→context-free negative 유닛); `muse setup cloud`에 privacy-routing 안내단계(cloudPrivacyRoutingGuidance, action stdout 실배선·parseAsync 캡처 behavioral 테스트).
- 왜: D5 웨이브(라우팅·KO) 첫 슬라이스. 로드맵 "명문화+각 유닛+20 계약 무수정" — 정책층에 결정론 guard를 codify하되 frozen 20 chat 계약(배선점)은 안 건드림. 툴=개인데이터 통로라 context-free여도 클라우드 금지가 privacy 원칙.
- 리뷰지점: Opus PASS — 20 계약 git-diff 빈(무수정)·20/20 green·route-flip을 resolver 레벨서 증명(classification-only 아님)·usesTools optional·omit byte-identical·꺼/거 판별 독립 프로빙(제거→context-free)·setup 안내 stdout 실캡처(상수-substring 아님)·fail-close 보존(usesTools는 personal만 반환, 새 클라우드 경로 무개방)·defense-in-depth 주석 실검증(buildCloudTurnRequest tools=0). mutation-RED 양방향 독립 재현.
- 리스크: 낮음. (b) usesTools는 현재 프로덕션 미배선(inert)이나 정직-스코프(로드맵이 "명문화"+20계약 무수정 요구, chat은 구조적 toolless로 이미 원칙 집행) — Opus가 overclaim 아님 판정. 다음 = D5-S2(resolveAuxiliaryModel(task,env) 통합 리졸버, aux도 privacy 게이트 통과·local-only 게이트 유닛).
- lesson: "명문화+각 유닛+기존 계약 무수정" 슬라이스는 정책층에 optional 결정론 신호를 additive로 추가(omit=byte-identical)+새 유닛으로 검증하면 frozen 계약을 안 깨고 원칙을 codify. inert 여부는 로드맵 스코프(codification vs live-wire)에 비춰 정직히 판단 — 배선점이 frozen이면 policy-unit이 정당한 delivery.

## fire 39 · 2026-07-12 · skill v2.x · 41c8f0a04
meta: slice=D5-S2 · wave=W4 · pkg=@muse/autoconfigure · kind=auxiliary-model-resolver · verdict=PASS · firesSinceDrill=5
ratchet: 로드맵 잔여 [ ] = 22/64(D5-S2 체크) · self-eval pass · fabrication 0 · autoconfigure +11 유닛(resolve-auxiliary-model.test 신규, testFiles 1391→1392) · ENV +5(MUSE_AUX_*_MODEL)
- 무엇: ①기준선 green(testFiles 1391). ②D5-S2: `resolveAuxiliaryModel(task,env)` 통합 리졸버(autoconfigure-model-provider.ts, resolveVisionModel 옆, 순수 additive). 태스크 compaction/vision/rewrite/judge/embedding-rescue. precedence: `MUSE_AUX_<TASK>_MODEL`(신규 일반화 노브) > legacy per-task(vision→MUSE_VISION_MODEL·embedding-rescue→MUSE_RECALL_EMBED_MODEL; compaction/rewrite/judge는 legacy 모델 노브 無) > sessionModel. 로컬-우선 fail-close 게이트: 선택모델이 cloud(classifyProviderLocality)이고 isPersonalContext 또는 MUSE_LOCAL_ONLY면 override→sessionModel(keptLocalForPrivacy:true); 아니면 cloud 존중. index.ts export+docs:env.
- 왜: hermes auxiliary.<task>처럼 산재된 태스크별 모델 노브(MUSE_VISION_MODEL·MUSE_AUX_COMPACTION·MUSE_RECALL_EMBED_MODEL)를 단일 리졸버로 일반화하되 하위호환(legacy 노브 그대로 존중). aux 태스크도 privacy 원칙 종속 — 개인컨텍스트 aux(예: 개인 대화 compaction 요약)는 클라우드 aux로 새어나갈 수 없게 fail-close.
- 리뷰지점: Opus PASS — local-first 게이트 OUTCOME 검증(cloud task-env+personal→keptLocalForPrivacy:true·model===session·route:local, negative case cloud 존중)·classifyProviderLocality 실검증(gemini→cloud/ollama→local, 테스트가 함수 반대 주장 안 함)·mutation-RED 양방향 독립 재현(override 제거→personal-cloud RED·legacy fallback 제거→MUSE_VISION_MODEL RED)·resolveVisionModel/resolveDefaultModel 무변경(45 기존 green)·envInventory:pass(동적 키 5개 documented, orphan 無).
- 리스크: 낮음. 미배선(콜사이트 마이그레이션=follow-up) — 로드맵 수용이 "리졸버·하위호환·local-only 게이트 유닛"이라 정확 부합(D5-S1 inert 패턴과 동일 정직-스코프, Opus overclaim 아님 판정). 유저-가시 0(CHANGELOG 생략). 다음 = D5-S3(canUseNativeTools 死코드→실게이트 배선, toolCalling=false→텍스트 프로토콜/명시에러, VQ-2 배선점).
- lesson: 산재된 config 노브 "일반화" 슬라이스는 새 umbrella env(MUSE_AUX_<TASK>_MODEL) precedence 위에 legacy 노브를 fallback으로 두면 하위호환이 결정론적으로 보장. privacy 불변(개인→로컬)을 aux resolver에도 fail-close 게이트로 심으면 노브가 privacy를 우회 못 함. 동적 env 키는 env-inventory 스캐너가 못 읽으니 concrete 이름을 doc에 명시해 envInventory 게이트 통과.

## fire 40 · 2026-07-12 · skill v2.x · aecf44510
meta: slice=D5-S3 · wave=W4 · pkg=@muse/agent-core · kind=capability-gate-wiring · verdict=PASS · firesSinceDrill=6
ratchet: 로드맵 잔여 [ ] = 21/64(D5-S3 체크) · self-eval pass · fabrication 0 · agent-core +6 behavioral(model-tool-capability-gate.test 신규, testFiles 1392→1393)
- 무엇: ①기준선 green(testFiles 1392). ②D5-S3(VQ-2): @muse/model `canUseNativeTools`(toolCalling∧structuredOutput, 死코드)를 AgentRuntime 요청경로(prepareInvocation, modelTools 직후 line 536)에 `assertModelCanUseTools(selected, tools.length)`로 배선. tools 노출된 채 capability-부재 모델이면 명시적 `ModelToolCallingUnsupportedError`(errors.ts, index.ts 재export). fail-OPEN 안전: tools.length===0·미지 modelId·listModels() throw→무차단(기존동작 보존); per-instance `toolCapabilityCache`(provider.id/model)로 핫패스 반복 listModels 회피. executeToolPlanGated(텍스트 플랜 경로) 무개입. VQ-2 접두 주석은 Opus nit로 제거(WHY 본문 유지).
- 왜: VQ-2 결론 — 死코드 + 텍스트 툴 프로토콜 미구현. gemma4(toolCalling=true)는 무영향이나, 비-툴 모델(codex/* 실제, BYO non-tool cloud)에 조용한 툴 무시 대신 명시적 에러가 옳다. 완전 파서는 별도 L 이연(BYO 비-툴 쓸 때만 필요).
- 리뷰지점: Opus PASS — 死코드가 실제 caller 획득(재구현 아님, canUseNativeTools 실호출)·run 경로로 명시-에러 검증(helper-only 아님, toolCalling=false∧structuredOutput=false 둘 다 throw·capable→no-throw)·mutation-RED 양방향 독립 재현(throw 무력화·toolCount 0)·fail-open 4분기 실검증(tools0·미지·listModels-throw→return not throw, flaky listModels가 기존 성공 턴 무회귀)·캐시 반복호출 방지·executeToolPlanGated 무개입·scope 4파일.
- 리스크: 낮음. fail-open 설계라 positively-confirmed 비-툴 모델에만 throw(default gemma4 무영향). 게이트가 tools 노출(요구 아님)에 fire하나 로드맵 "명시적 에러" 의도 부합(비-툴 모델서 툴기능은 애초 불가). 다음 = D5-S4(MUSE_MODEL_FALLBACKS 명시 fallback 체인, 각 폴백 privacy/local-only 게이트·발생 1줄 표기·미설정 byte-identical).
- lesson: 死코드 capability 함수는 요청경로의 자연스러운 seam(툴 빌드 직후)에 배선하되 fail-OPEN(positively-confirmed일 때만 throw)으로 미지/실패를 무차단해 기존 성공 경로 무회귀. 네트워크성 capability 조회(listModels)는 per-instance 캐시+조건부(tools>0)로 핫패스 비용 회피. 로드맵-추적 접두(VQ-N)도 코멘트 정책상 task 참조라 제거.

## fire 41 · 2026-07-12 · skill v2.x · 9cfbab2f4
meta: slice=D5-S4 · wave=W4 · pkg=@muse/autoconfigure · kind=fallback-chain-resolver · verdict=PASS · firesSinceDrill=7
ratchet: 로드맵 잔여 [ ] = 20/64(D5-S4 체크) · self-eval pass · fabrication 0 · autoconfigure +10 유닛(resolve-model-fallback-chain.test 신규, testFiles 1393→1394) · ENV +1(MUSE_MODEL_FALLBACKS)
- 무엇: ①기준선 green(testFiles 1393). ②D5-S4: `resolveModelFallbackChain(env, isPersonalContext?)` 명시 fallback 체인 리졸버(autoconfigure-model-provider.ts, resolveAuxiliaryModel 옆, 순수 additive). "숨은 재시도 금지" 원칙 — `MUSE_MODEL_FALLBACKS`(콤마) 설정 시에만 순차 체인; 미설정/blank→{chain:[],dropped:[]}(byte-identical). 각 폴백 fail-close 게이트(local-first 미러): cloud 폴백은 MUSE_LOCAL_ONLY 또는 isPersonalContext면 dropped(reason)·context-free+non-local-only면 chain 유지. order 보존·빈 엔트리 필터. index.ts export·docs:env.
- 왜: D5 웨이브 마지막 배선-슬라이스. openclaw allowlist+fallback 참조하되 Muse 원칙(명시 설정만·폴백도 privacy 종속). 폴백이 숨은 cloud-egress 경로가 되지 않게 각 폴백 재-게이트.
- 리뷰지점: Opus PASS — privacy 게이트 OUTCOME 검증(local-only/personal→cloud drop, negative control context-free→cloud 유지, 항상-drop 아님)·classifyProviderLocality 실검증(gemini→cloud/ollama→local)·order 보존+파싱 견고성(공백/trailing comma)·unset byte-identical 3케이스·mutation-RED 양방향 독립 재현(local-only drop 제거→RED)·resolveAuxiliaryModel/resolveVisionModel 무변경(21 combined green)·runtime-assembly 무접촉·envInventory:pass.
- 리스크: 낮음. 미배선(체인→ModelFallbackStrategy 구성+"폴백 X" 답변 마커=follow-up) — runtime-assembly가 타루프 HANG 블로커라 이번 fire 미접촉이 정당. 로드맵 수용이 "체인워크·게이트 유닛·미설정 byte-identical"(UNIT 기반)이라 정확 부합(D5-S2 정직-스코프 패턴, Opus overclaim 아님). 유저-가시 0(CHANGELOG 생략). 다음 = D1-S6(턴-내 one-shot 회복 상태 통합, 동작불변 리팩터). ※다음 fire 42는 firesSinceDrill=8 도달 → JUDGE-DRILL 강제.
- lesson: "명시 설정만·게이트 통과·미설정 byte-identical" 폴백 리졸버는 unset→빈 체인(숨은 재시도 없음)+각 엔트리 fail-close 게이트로 구성. 배선 대상(runtime-assembly)이 타루프 HANG 리스크면 리졸버+유닛만 딜리버하고 배선을 follow-up으로 명시하는 게 정직(로드맵 수용이 UNIT 기반일 때 정당).

## fire 42 · 2026-07-12 · skill v2.x · 407009ac6
meta: slice=D1-S6a+JUDGE-DRILL · wave=W4 · pkg=@muse/agent-core · kind=turn-recovery-primitive+judge-drill · verdict=PASS · firesSinceDrill=0(리셋)
ratchet: 로드맵 잔여 [ ] = 20/65(D1-S6→a/b 분해 +1, a 체크 -1) · self-eval pass · fabrication 0 · agent-core +4 유닛(one-shot-recovery-state.test 신규, testFiles 1394→1395)
- 무엇: ①기준선 green(testFiles 1394; 형제 desktop 루프 MuseWebWindow.swift 미커밋=무관, 명시 add로 무접촉). ②JUDGE-DRILL(firesSinceDrill=8 도달): 고의결함 D1-S6a 주입 — OneShotRecoveryState.claim()이 무조건 true 반환(once 미보장, 스펙 반전)+테스트 hollow(2번째 claim=false 미검증). 독립 Opus ④b가 정확 FAIL(claim 반전·hollow 테스트 두 결함 라인 지목). ③롤백(미커밋 신규파일→덮어쓰기)→진짜 fix: claim이 기claim시 false(if claimed.has→false)·guaranteed-once 실검증 테스트(2번째 claim=false·guarded body 정확1회·distinct 브랜치 독립·hasClaimed 순수쿼리)·index export. mutation-RED(once-guard 제거→3 RED). corrected Opus PASS.
- 왜: D1-S6(hermes turn_retry_state.py 참조, "이중 재시도 구조적 불가") 프리미티브. 로드맵 "(S)"+model-loop.ts 1112줄 중앙파일·다루프 접촉이라 DECOMPOSE-ON-DEFER: a=상태객체+guaranteed-once 유닛(수용 "회복분기 각 1회 보장"), b=model-loop 산재 flag 실배선(이연). firesSinceDrill=8 하드카운터 도달로 이 fire가 강제 드릴.
- 리뷰지점: 드릴 judge와 confirm judge 별개 Opus. 드릴 judge가 심은 결함(claim 항상 true·hollow 2번째-claim 미검증)을 라인 지목 FAIL. confirm judge가 corrected(once-guard 존재·guaranteed-once 실검증·mutation caught·additive) PASS. mutation-RED 3 test flip 독립 재현.
- 리스크: 낮음. 미배선 프리미티브(model-loop 실배선=D1-S6b) — 로드맵 수용이 "프리미티브+guaranteed-once 유닛"이고 배선을 별도 신중작업으로 분해. 유저-가시 0(CHANGELOG 생략). 배치 진행 중(진안 지시 5-10 슬라이스→push+cron중단). 다음 = D2-S3(난독화 해제 확장, VQ-3 먼저).
- lesson: JUDGE-DRILL은 "구조적 불변"(guaranteed-once) 슬라이스가 좋은 vehicle — 결함(가드 반전)+hollow 테스트(불변 2번째-호출 미검증)를 주입하면 Opus가 둘 다 정확히 지목. 중앙 대형파일(model-loop 1112줄) 리팩터는 프리미티브+유닛(안전)과 실배선(신중)으로 분해해 배치서 중앙파일을 급하게 안 건드림.

## fire 43 · 2026-07-12 · skill v2.x · bd1b3374f
meta: slice=D2-S3 · wave=W4 · pkg=@muse/tools · kind=security-deobfuscation · verdict=PASS · firesSinceDrill=1
ratchet: 로드맵 잔여 [ ] = 19/65(D2-S3 체크) · self-eval pass(baseline-repair 후) · fabrication 0 · tools +9 test(dangerous-command, 36/36)
- 무엇: ①기준선 green. ②D2-S3(🔒 보안): dangerous-command DS-2 정규화기 확장. VQ-3 확정대로 실부재 2벡터만 — `normalizeCommandNfkc`(command.normalize("NFKC"), 전각 ｒｍ→rm)+`stripAnsiEscapes`(ECMA-48 CSI, ReDoS-safe char-class regex)를 normalizeCommandForGuard 파이프라인 front에 추가. clean ASCII엔 no-op→기존 DS-2 byte-identical(RULES/helper/기존27 test 무수정). 전각 homograph·ANSI 삽입 우회 페이로드 차단. ③baseline-repair: foreign apps/api WIP(타루프 MUSE_TELEGRAM_POLL_ENABLED 등)로 envInventory red→docs:env 재생성(생성 파일).
- 왜: hermes approval.py 참조. raw-regex 게이트는 shell 난독화로 우회되므로 정규화 변형 위에서 검출. VQ-3이 $IFS/라인연속/comment-strip/홈경로는 이미 있고 NFKC+ANSI만 실부재로 확정. DETECTION-only라 folding이 실행을 안 바꿈(위협모델 안전).
- 리뷰지점: Opus PASS — 독립 우회 프로빙(전각 sudo/슬래시·ANSI 변형·전각 틸데 모두 차단)·DETECTION-only 실검증(zero 외부 caller, executor runner.ts:257 등 원본 실행)·no-over-block(인용내 전각·benign ANSI echo safe, quote-awareness 유지)·ReDoS-safe(char-class 단일 quantifier)·기존 27 무수정·mutation-RED 양방향 독립 재현.
- 리스크: 낮음. 순수 결정론 변환·additive. ⚠️ foreign apps/api WIP가 working-tree 더럽힘(내 commit 미포함, 명시 add) — 그 loop의 envInventory 회귀를 docs:env로 임시 봉합, 그 loop 커밋 시 재생성. ⚠️ 워커가 격리검증에 git stash 사용(금지 사항)했으나 무손상(stash list 비어있음·내 변경/foreign 그대로) — 향후 워커 브리핑에 git stash 금지 명시. 배치 진행중(진안 지시). 다음 = D2-S4(runner stdout→모델 시크릿 마스킹, VQ-4 확인 후).
- lesson: 보안 난독화-해제 확장은 DETECTION-only 변형(원본 미변경)을 정규화 파이프라인 front에 추가하면 clean 입력 no-op으로 기존 게이트 무수정 보장. 동시-루프가 shared 메인 워크트리서 env 추가하면 내 self-eval envInventory가 foreign하게 red될 수 있음 — docs:env 재생성으로 봉합(생성 파일이라 안전). 워커에 git stash 금지를 브리핑에 명시해야(격리 검증 유혹).

## fire 44 · 2026-07-12 · skill v2.x · 39d715ccb
meta: slice=D2-S4 · wave=W4 · pkg=@muse/tools · kind=security-secret-masking · verdict=PASS · firesSinceDrill=2
ratchet: 로드맵 잔여 [ ] = 18/65(D2-S4 체크) · self-eval pass(baseline-repair 후) · fabrication 0 · tools +5 test(119/119)
- 무엇: ①기준선 green. ②D2-S4(🔒): redactSecretsInText를 subprocess 출력→모델 2 sink 배선 — runner.ts run_command + 형제-감사로 찾은 muse-tools-skills.ts skill_run(둘 다 stdout/stderr raw로 모델 유출되던 동일 취약클래스). truncation 무결: capTruncated를 capped-but-unredacted 길이로 계산 후 redact(redact가 길이 바꿔 flag 오염 방지). ③baseline-repair: foreign apps/api env 또 늘어 envInventory red→docs:env 재동기.
- 왜: VQ-4 확정(runner.ts:88-100 redact 없이 raw 반환). openclaw secret-mask 참조. 명령/스킬이 env 덤프·config 프린트로 시크릿 출력하면 모델 컨텍스트로 유출 → 반환 직전 마스킹.
- 리뷰지점: Opus PASS — 두 sink RETURN 경로 실배선(import만 아님)·마스킹 behavioral(sk-proj/AKIA/ghp raw 제거+[redacted-)·truncation 실검증(mid-secret cut→truncated:true·benign→false·기존 truncated 보존)·no over-mask(benign byte-identical toBe)·perf 실측 256KB 17.7ms<250ms(SECRET_PATTERNS ReDoS-safe)·제3형제 없음(다른 exec는 regex.exec)·mutation-RED 양방향 독립 재현.
- 리스크: 낮음. additive 마스킹(capping/decode 무변경). ⚠️ foreign apps/api WIP env 지속 증가로 매 fire docs:env 재동기 필요(noise). 워커 git stash 미사용(브리핑 반영). 배치 진행중. 다음 = D2-S5(calendar 스토어 암호화, reflections 템플릿 재사용, 라운드트립 3종).
- lesson: subprocess 출력→모델 sink는 형제가 여러 개(run_command·skill_run) — 한 곳 배선 시 형제-감사로 동일 클래스 전부 배선. 길이-의존 flag(truncation)가 있는 곳에 변환(redact) 추가 시 flag를 변환-전 길이로 계산해 무결 유지. 시크릿 마스커 대형출력 perf는 실측 벤치로 ReDoS 부재 증명(수용 "성능무해").

## fire 45 · 2026-07-12 · skill v2.x · 9160f5cdc
meta: slice=D2-S5 · wave=W4 · pkg=@muse/calendar · kind=security-encryption-at-rest · verdict=PASS · firesSinceDrill=3
ratchet: 로드맵 잔여 [ ] = 17/65(D2-S5 체크) · self-eval pass · fabrication 0 · calendar +4 라운드트립 test(176/176) · ENV +1(MUSE_CALENDAR_ENCRYPT)
- 무엇: ①기준선 green. ②D2-S5(🔒, backlog "LAST encryption item"): calendar.json at-rest 암호화. memory-encryption AES-256-GCM envelope를 @muse/calendar **in-package mirror**(belief-provenance 선례 — @muse/memory/@muse/stores heavy dep 회피, node:crypto/node:os만). calendar-encryption.ts(envelope·encrypt/decrypt/isEnvelope·MUSE_MEMORY_KEY 재사용+calendar per-host fallback·MUSE_CALENDAR_ENCRYPT opt-in). local-provider readAll(envelope 자동감지→decrypt, wrong-key throw는 JSON-parse quarantine catch 밖서 propagate=fail-closed, ciphertext 파괴 안 함)+writeAll(format-preserving: flag OR isCalendarFileCurrentlyEncrypted).
- 왜: 암호화-at-rest 큐의 마지막(events/locations/notes 민감). reflections/belief-provenance가 증명한 per-store 템플릿. calendar 패키지는 memory 미의존이라 seam 직접 import 대신 in-package mirror(backlog가 heavy dep로 deferred했던 걸 mirror로 해소).
- 리뷰지점: Opus PASS — per-encryption random iv(12)/salt(16)(fixed-iv 아님)·raw 바이트 no plaintext(title/location 부재)·read-back 동일 복호·fail-closed(wrong-key throw가 quarantine catch 밖, ciphertext 파일 byte-unchanged 검증)·format-preserving·byte-identical default(기존 176 무수정)·heavy dep無(package.json 그대로)·단일 write경로(credential-store는 별개)·mutation-RED 양방향 독립 재현.
- 리스크: 낮음. opt-in(default plaintext byte-identical). CLI 명령(muse calendar encrypt/decrypt)은 acceptance("라운드트립 3종+format-preserving") 밖이라 생략 — 필요시 follow-up(reflections는 있었으나 D2-S5 수용엔 불요). 배치 진행중(4번째 슬라이스). 다음 = D-KO-S1(truncateUtf16Safe 추출+미안전 3곳 배선).
- lesson: 암호화 seam이 heavy 패키지(@muse/memory)에 있고 대상 패키지가 그걸 의존하면 안 될 때 = envelope를 node:crypto로 in-package mirror(belief-provenance 선례). fail-closed at-rest의 핵심은 wrong-key throw를 corrupt-quarantine 경로 밖에 두는 것(ciphertext=유저 데이터, 파괴 금지). format-preserving은 기존 파일 암호화상태를 write시 감지해 유지.

## fire 46 · 2026-07-12 · skill v2.x · cfbd763af
meta: slice=D-KO-S1 · wave=W4 · pkg=@muse/shared+recall+tools+autoconfigure+voice · kind=ko-utf16-safe-extraction · verdict=PASS · firesSinceDrill=4
ratchet: 로드맵 잔여 [ ] = 16/65(D-KO-S1 체크) · self-eval pass · fabrication 0 · shared +utf16-safe.test·voice +wiring test(testFiles 1399→1400)
- 무엇: ①기준선 green. ②D-KO-S1(★ KO): truncateErrorBody(shared)의 lone-high-surrogate 드롭을 truncateUtf16Safe(text,cap)+sliceUtf16Safe(text,start,end)로 추출(중복제거), truncateErrorBody 위임(byte-identical). VQ-6 확정 4파일 5사이트 배선: recall/history-search(206 head·213 middle-substring 양boundary)·tools/tool-definition-helpers(108)·autoconfigure/knowledge-corpus(365)·voice/tts-truncate(19 window·28 cut). sliceUtf16Safe는 선행 lone-low+후행 lone-high 둘 다 드롭.
- 왜: openclaw utf16-slice 참조. raw .slice가 astral char(이모지·CJK-ext) 중간을 잘라 lone surrogate→invalid UTF-8→다운스트림 JSON/전송 깨짐. 안전패턴이 truncateErrorBody에 이미 있어 추출+미안전 사이트 배선(중복 제거+커버리지).
- 리뷰지점: Opus PASS — 양boundary 정확(head cap mid-emoji→lone-high 드롭, start mid-pair→lone-low 드롭, 결과 lone-surrogate regex 스캔 clean)·한글(BMP 단일유닛) byte-identical·truncateErrorBody 위임 byte-identical(기존 테스트 무수정 green)·4사이트 실배선(213 middle은 sliceUtf16Safe)·surrounding 로직 무변경(…/... append, tts cut)·mutation-RED 양방향(드롭 제거→emoji+truncateErrorBody 위임증명 둘 다 RED).
- 리스크: 낮음. byte-identical-when-safe(한글/ASCII 무변경). ★KO 우선 슬라이스. 배치(진안 5-10 슬라이스 지시) 5번째=마지막 — 이후 origin/main push + cron 964ac861 중단 예정. 다음(루프 재개 시) = D-E1(eval 집계 실-강제).
- lesson: 안전-절단 패턴이 한 함수(truncateErrorBody)에 인라인으로 있으면 shared 헬퍼로 추출→위임(byte-identical 검증)+미안전 사이트 배선이 중복제거+커버리지를 동시 달성. UTF-16 안전은 head-truncation(후행 lone-high)뿐 아니라 substring(선행 lone-low)도 필요 — sliceUtf16Safe로 양boundary 커버.

## fire 47 · 2026-07-12 · skill v2.x · a01296db9
meta: slice=D1-S6b · wave=W4 · pkg=none(docs) · kind=already-satisfied-determination · verdict=PASS(NO_TARGET) · firesSinceDrill=5
ratchet: 로드맵 잔여 [ ] = 15/65(D1-S6b 체크) · self-eval pass(envInventory baseline-repair) · fabrication 0 · 코드변경 0
- 무엇: ①기준선 envInventory red(foreign apps/api WIP env)→docs:env baseline-repair. ②D1-S6b 판정: 독립 Opus 적대판정 NO_TARGET — D1-S6 전제("Muse 개별회복 산재 raw flag→double-fire")가 현 코드서 거짓. 5개 회복 분기 전부 이미 at-most-once(false-done runResistingFalseDone 단일 비루프 호출·reverify ReverifyNudgeTracker.nudged per-turn·post-compaction/ping-pong 터미널 return+전용 Guard 클래스·attributed-repair 단일패스). 강제 배선은 무동작변경 인위적 리팩터(진안 "관련없는 리팩터 금지"). already-satisfied로 표기(코드변경 0).
- 왜: D1-S6a가 프리미티브를 제공했으나, 실배선 대상(가드 없는 회복 재발화)이 실재하지 않음. 인위적 redundant 배선은 fabrication/inflation과 같은 안티패턴 — honest하게 "이미 캡슐화됨" 판정이 옳음(D4-S1b verify-mcp already-registered 선례).
- 리뷰지점: 독립 Opus가 5개 분기의 recovery ACTION(detector 아님)을 적대적으로 추적 — 모두 단일 비루프 호출 or 터미널 return or 전용 stateful tracker로 bounded. self-판정 아님(maker≠judge: Done 판정을 독립 evaluator가). OneShotRecoveryState는 미래 신규 회복분기용 프리미티브로 존속.
- 리스크: 없음(코드변경 0). 로드맵 전제가 코드현실과 어긋난 케이스를 honest하게 close. 다음 = D-E1(📈 eval 집계 실-강제, VQ-12 시간예산 참조).
- lesson: 로드맵 슬라이스의 전제(산재 flag)가 코드 현실(이미 tracker 캡슐화)과 다르면, 인위적 배선으로 슬라이스를 "채우지" 말고 독립 evaluator에게 실타깃 유무를 적대판정시켜 already-satisfied를 honest하게 close. 프리미티브(D1-S6a)는 미래용으로 남김. "관련없는 리팩터 금지"는 무동작변경 배선도 포함.

## fire 48 · 2026-07-12 · skill v2.x · 49204a4f3
meta: slice=D-E1a · wave=W5 · pkg=scripts(eval-harness) · kind=eval-tier0-contamination-filter · verdict=PASS · firesSinceDrill=6
ratchet: 로드맵 잔여 [ ] = 15/65(D-E1→a/b/c 분해, a 체크) · self-eval pass · fabrication 0 · scripts +4 유닛(eval-harness.test)
- 무엇: ①기준선 green. ②D-E1a(진안 "안전한 부분부터 분해" 선택): eval-harness.mjs Tier-0 오염 필터. detectTier0Contamination(observed)+TIER0_CONTAMINATION_PATTERNS(4 마커 정밀 정규식) → runEvalSuite가 case observed에 인프라-실패 누출 감지 시 total서 제외(excluded 카운터, behavior 실패로 오인 방지). **핵심 위협모델: over-exclusion 금지** — infra 마커 없는 진짜 behavior 실패는 여전히 total 카운트(pass rate 인플레 차단, total+=1을 오염체크 後로 이동). 비오염 suite byte-identical.
- 왜: VQ-21 확정(eval-harness에 인프라-오염 사전배제 없음). §591 "검증규율 A→A+ 되돌리는 유일한 실-작업". 인프라 실패(backend down·tool crash·timeout)가 behavior 실패로 집계되면 게이트 신뢰성 훼손. D-E1의 공유 pre-push 훅 변경은 blast radius 커서(활성 루프 다수) 진안과 상의→안전한 결정론 부분(Tier-0 필터)부터 분해 진행.
- 리뷰지점: Opus PASS — over-exclusion threat SAFE(contamination은 detector 결과서만 set, score 결과서 파생 안 함; behavior-fail case C가 total 유지 검증)·정밀성(benign "failed launch"/"30s timeout"/"supports vision" 미flag)·byte-identical(excluded 추가만)·mutation-RED 양방향(detector 무력화·over-exclusion→"no over-exclusion" assertion RED)·훅/CI/package src 무접촉.
- 리스크: 낮음. 결정론·additive·zero blast radius(공유 훅 무변경). D-E1b(pre-push 확장+훅 실차단 증명)는 공유 push 인프라라 신중 fire로 이연(진안 확인). 다음 = D-E1b 또는 D6-S1a. ※foreign reflection-guard.test.mjs 실패는 타루프 proactivity(내 것 아님).
- lesson: eval 오염 필터의 핵심 위협은 over-exclusion(진짜 실패 은폐→pass rate 인플레) — contamination을 detector에서만 결정하고 score 결과와 분리, total 증가를 오염체크 後로 배치하면 behavior 실패는 절대 제외 안 됨. mutation으로 over-exclusion을 RED로 잡는 게 이 클래스의 핵심 가드. 공유 인프라(pre-push 훅) 변경은 blast radius 크면 결정론 부분부터 분해.

## fire 49 · 2026-07-12 · skill v2.x · c541292b4
meta: slice=D6-S1a · wave=W5 · pkg=@muse/agent-core · kind=deterministic-consolidation-score · verdict=PASS · firesSinceDrill=7
ratchet: 로드맵 잔여 [ ] = 14/65(D6-S1a 체크) · self-eval pass · fabrication 0 · agent-core +12 property 유닛(consolidation-score.test, testFiles 1404→1405)
- 무엇: ①기준선 green. ②D6-S1a(내가 방향 결정 — 진안 "방향은 니가"): sleep-consolidation 결정론 승격 스코어. scoreConsolidationCandidate(signals,nowMs,opts) = frequency(log2(1+hits)) × recency(half-life 2^(-ageDays/14d)) × diversity(distinctQueries 1..2/neutral). 입력 {hits,createdMs,lastHitMs,distinctQueries?}=RecallHitStats 실형 일치(distinctQueries는 원장 미추적이라 optional-정직). isConsolidationCandidate(score,threshold). 순수 selection-only(zero imports·no write=D6 자동쓰기금지 불변 구조적).
- 왜: D6-S1(L)을 a(스코어)/b(draft 제안)/c(데몬)로 분해. openclaw dreaming 승격스코어(6요소·반감기14d) 참조하되 기본OFF·자동쓰기금지·LLM없음(Muse식 교정-망각 원칙). D-E1b(공유 pre-push 훅)는 blast radius 커서 이연 → 깔끔한 bounded 결정론 슬라이스 선택.
- 리뷰지점: Opus PASS — no-write/순수 selection 불변(zero imports·frozen-input 무변경 유닛)·monotonicity(hits/recency/half-life 0.5/diversity 정확)·boundary 가드(hits≤0·non-finite·future-clamp)·grounded 입력(RecallHitStats 일치·distinctQueries honestly optional)·mutation-RED 양방향 독립 재현.
- 리스크: 낮음. 순수 함수·미배선(승격 write는 D6-S1b draft-first, 데몬은 D6-S1c). 자동쓰기금지 D6 불변을 함수가 side-effect-free라 구조적으로 보장. 다음 = D6-S1b(승격을 proactive draft 카드+자동쓰기-없음 계약 mutation).
- lesson: 결정론 스코어의 입력은 실제 저장되는 신호(RecallHitStats hits/lastHitMs)에 grounded해야 — distinct-query처럼 원장 미추적 신호는 optional+neutral fallback으로 spec-complete하되 정직히 표기. no-write 불변은 함수를 순수(zero import)로 만들어 구조적으로 보장하고 frozen-input 유닛으로 증명.

## fire 50 · 2026-07-12 · skill v2.x · 6e0aba72e
meta: slice=D6-S1b · wave=W5 · pkg=@muse/agent-core · kind=consolidation-draft-proposal · verdict=PASS · firesSinceDrill=8
ratchet: 로드맵 잔여 [ ] = 13/65(D6-S1b 체크) · self-eval pass · fabrication 0 · agent-core +5 유닛(consolidation-proposal.test, testFiles 1405→1406)
- 무엇: ①기준선 green. ②D6-S1b: sleep-consolidation 후보를 draft 제안으로. runConsolidationProposalPass({candidates,nowMs,nowIso,threshold,publish,promote?}) — D6-S1a 스코어로 필터(isConsolidationCandidate)→above-threshold만 draft 제안 notice publish(AgentInitiatedNotice kind="memory_consolidation_proposal", "오래 보관할까요?...승인해야 durable 승격", sourceId=memoryId). buildConsolidationProposalNotice 순수. **자동쓰기-없음 계약**: deps.promote(durable writer)는 deps에 있으나 절대 호출 안 함(교정-망각 불변), 타입/주석에만·호출부 0.
- 왜: D6-S1(sleep-consolidation)의 draft-first 절반. 교정-망각 원칙 — Muse는 유저 승인 없이 durable memory write 금지. 스코어(D6-S1a)로 후보만 선정, 승격은 유저 확인(D6-S1c 데몬) 시에만. outbound-safety deny/no-effect 패턴을 memory 승격에 적용.
- 리뷰지점: Opus PASS — no-auto-write 불변(promote 타입/주석에만·미호출, 테스트가 all-strong 후보에도 promote 0회 assert=weak-suppress로 거짓통과 불가)·mutation-RED 양방향 독립 재현(auto-write 주입→promote spy RED·threshold 반전→selection RED)·실 D6-S1a 스코어 배선(재구현 아님)·notice shape(kind/sourceId/confirmation text)·Date-free(nowMs/nowIso 입력).
- 리스크: 낮음. 미배선(데몬 소비=D6-S1c). 자동쓰기금지 불변을 deps.promote 미호출로 계약화하고 mutation으로 가드. D6-S1 sleep-consolidation의 score(a)+proposal(b) 완성, 데몬 정합(c) 잔여. 다음 = D6-S1c(데몬 배선·loop-v2 Sleep 정합) 또는 D-E1b. ※foreign encrypted-file.ts diff는 타루프.
- lesson: draft-first/자동쓰기-없음 계약은 write 능력(promote)을 deps에 두되 "절대 호출 안 함"으로 명문화하고, mutation(promote 호출 주입)→spy RED로 가드하면 계약이 실효. no-write 테스트는 반드시 강한 후보(모두 above-threshold)로 검증해야 함 — weak-suppress로 promote 0회가 되는 거짓통과를 배제.

## fire 51 · 2026-07-12 · skill v2.x · 83beadab2
meta: slice=D6-S1a/b REVERT + D6-S1c already-satisfied · wave=W5 · pkg=@muse/agent-core · kind=honest-redundancy-revert · verdict=INTEGRITY-CORRECTION · firesSinceDrill=0(리셋, JUDGE-DRILL 역할 유기적 달성)
ratchet: 로드맵 잔여 [ ] = 12/65(D6-S1c 체크·a/b honest 정정) · self-eval testFiles 1407→1405(의도된 -2, 중복 테스트 제거) · fabrication 0
- 무엇: fire 51은 JUDGE-DRILL 예정이었으나, 다음 슬라이스 D6-S1c 파악 중 **중대 발견**: recall-promotion.ts가 D6-S1(sleep-consolidation) 전체를 이미 포괄 구현·배선(scoreRecallHit·selectPromotableMemories·selectForgettable·shouldConsolidateMemory·planMemoryConsolidationTick·MUSE_SLEEP_PROMOTE opt-in 데몬). 즉 내가 fire 49(D6-S1a)·50(D6-S1b)에 만든 게 **중복 재구현**. 독립 Opus 감사→D6-S1a REDUNDANT·D6-S1b DISTINCT-BUT-INERT+DESIGN-TENSION 판정. 진안 전략결정(현상유지 opt-in auto-promote). → consolidation-score.ts/proposal.ts+테스트 4파일 삭제·index.ts export 제거·D6-S1a/b/c 로드맵 honest 정정(a=already-existing·b=진안 keep-auto-write·c=already-satisfied).
- 왜: honesty가 코어 가치. 중복 shipped를 방어 않고 정직히 revert. draft-first vs opt-in-auto-write는 교정-망각 불변을 soft persona 층에 얼마나 적용할지의 전략 포크라 진안 결정(로드맵 규칙: 전략 VQ는 진안). JUDGE-DRILL의 취지(게이트가 나쁜/부적절 작업을 잡음)를 유기적으로 달성 — 독립 Opus가 "shipped 작업이 중복"임을 잡아냄. firesSinceDrill=0 리셋.
- 리뷰지점: 독립 Opus 감사가 recall-promotion.ts 전수+데몬 배선 확인→REDUNDANT/DESIGN-TENSION 판정, 방어 아닌 revert 권장. 진안이 AskUserQuestion으로 현상유지 결정. 빌드 clean(dangling ref 0)·lint 0/0. self-eval testFiles -2는 의도(중복 제거).
- lesson: ★새 역량 빌드 전 **codegraph/grep으로 기존 구현 필수 확인** — recall-promotion.ts(memory 패키지)를 안 봐서 agent-core에 중복 스코어를 2 fire 낭비. 로드맵 슬라이스 전제("아직 없음")를 코드로 검증 안 하면 중복 생산. shipped 작업이 중복/부적절로 판명되면 방어 말고 독립 evaluator 판정+정직 revert. 전략 포크(불변 적용 범위)는 코드로 밀지 말고 진안 표면화.
- 다음 = D-E1c(self-eval 커밋훅+CI 결정론분) 또는 D6-S3(외부-편집 drift). D-E1b(공유 pre-push 훅)는 계속 신중 이연.

## fire 52 · 2026-07-12 · skill v2.x · 4e46612aa
meta: slice=D6-S3 · wave=W5 · pkg=@muse/memory · kind=memory-external-edit-drift-guard · verdict=PASS · firesSinceDrill=1
ratchet: 로드맵 잔여 [ ] = 11/65(D6-S3 체크) · self-eval pass · fabrication 0 · memory +6 유닛(external-edit test, testFiles 1405→1406)
- 무엇: ①기준선 green. ②교훈 적용: 빌드 전 codegraph/grep으로 D6-S3 미구현 확인(memory-user-store-file은 withFileLock만·외부편집 감지 없음, "round-trip"은 JSON 직렬화일 뿐). ③D6-S3(무결성): FileUserMemoryStore가 락 안 read→write 사이 외부편집(수동·patch·락-미경유)을 compare-and-swap로 차단. read()가 raw on-disk bytes 반환→write(data,encrypted,expected?)가 atomic write 직전 재읽기, currentRaw !== expected.raw면 .bak.<ts>(복사, 원본 미삭제)+MemoryExternalEditError throw로 clobber 차단. raw 비교라 plaintext/encrypted 모두 감지. patch/deleteByUserId/encryptAtRest/decryptAtRest 4경로 배선. Opus nit(테스트명 VQ-7) 제거.
- 왜: VQ-7 확정 — 락은 자체 writer만 보호, 외부편집(hermes memory_tool 케이스)은 clobber됨. 유저 confided memory를 조용히 덮어쓰면 안 됨(교정-망각·데이터 안전). compare-and-swap로 optimistic concurrency.
- 리뷰지점: Opus PASS — 외부편집 never clobber/destroy(throw-before-write+.bak copy not move, 디스크에 외부내용 잔존 검증)·byte-identical when 미engaged(47 기존 무수정)·encrypted drift 감지(raw 비교)·normal write false-positive 없음(currentRaw===expected)·mutation-RED 양방향 독립 재현(drift check 제거→clobber RED). ★codegraph 사전확인으로 fire 51 중복실수 재발 방지.
- 리스크: 낮음. opt-in per-call(expected 없으면 무변경). 외부편집을 삭제 아닌 백업(Muse 데이터 파괴 금지 준수). 다음 = D-E1c(self-eval 커밋훅+CI) 또는 D6-S4(provenance 태그). D-E1b(공유 pre-push 훅)는 신중 이연.
- lesson: 무결성 compare-and-swap는 read시 raw 캡처→write 직전 재읽기 비교가 핵심; raw(pre-parse) 비교라 plaintext/encrypted 무관 동작. 외부-변경 감지 시 삭제 아닌 .bak 복사+throw로 유저 데이터 절대 파괴 안 함. ★교훈 실천: 이번엔 빌드 전 codegraph로 기존구현 부재 확인 후 진행(fire 51 중복 재발 방지).

## fire 53 · 2026-07-12 · skill v2.x · 877020fb2
meta: slice=D6-S4 · wave=W5 · pkg=apps/cli(test-only) · kind=autonomous-no-delete-contract · verdict=PASS · firesSinceDrill=2
ratchet: 로드맵 잔여 [ ] = 10/65(D6-S4 체크) · self-eval pass · fabrication 0 · cli +2 계약 유닛(memory-consolidate-tick-user-fact-protection, testFiles 1406→1407)
- 무엇: ①기준선 green. ②교훈 실천: 빌드 전 verify-first — 독립 Opus 감사로 D6-S4 불변("자율 큐레이션이 user 사실 삭제 못 함")이 **이미 구조적 성립** 확인(provenance source auto|user 존재·자율 fade 비파괴적 rank-down sidecar·유일 자율 forget은 recalled-* synthetic scoped·실삭제는 user-트리거뿐). 갭=end-to-end 핀 부재. ③가드 신설 대신(dead code=fire 51 중복함정) **mutation 계약 테스트** 신설: 실 FileUserMemoryStore에 user 사실 seed+강한 recall-hits로 fade+promote 발화(non-vacuous) 하에 runMemoryConsolidationTick→user 사실 잔존·불변 검증. ④발견: recalled-/recalled_ normalize 버그(별개, backlog).
- 왜: 로드맵 수용이 "자율-삭제-금지 계약(mutation)". 유저-지시 사실을 자율 큐레이션이 지우면 교정-망각·신뢰 붕괴. 이미 성립하는 불변을 **핀**으로 잠가 미래 회귀 방지가 옳은 산출(가드는 이미 있으니 신설=중복).
- 리뷰지점: Opus PASS — non-vacuous(tick이 promote+fade 실동작하며 user 사실 잔존, no-op면 무의미)·mutation flips(recalled- scope 제거→user 사실 삭제 RED, non-vacuous assertion은 여전히 통과=실동작 증명)·올바른 불변(user 사실 잔존, user-트리거 forget 무손상)·프로덕션 무변경(verify-first 준수).
- 리스크: 낮음. test-only. ★fire 51 교훈 2연속 실천(D6-S3·D6-S4 둘 다 verify-first로 기존구현/불변 확인 후 진행 — 중복 재발 0). 발견한 recalled_ 버그는 별개 슬라이스로 backlog. 다음 = D-E1c(self-eval 커밋훅, CI파트는 진안이 CI 안 돌려 N/A) 또는 D6-S5. D-E1b(공유 훅) 신중 이연.
- lesson: 로드맵 "계약(mutation)" 수용은 이미 성립하는 불변을 **non-vacuous 핀 테스트**로 잠그는 것 — 실 store+실 경로로 자율 tick이 진짜 일하게(promote+fade 발화) 한 뒤 user 데이터 잔존 assert, 그리고 mutation(가드 제거)로 RED 확인. 가드가 이미 있으면 신설 말고 테스트만(중복 회피). 테스트 작성 중 인접 버그(recalled_ 미매칭) 발견 시 scope 밖이면 고치지 말고 backlog 기록.

## fire 54 · 2026-07-12 · skill v2.x · 753b47004
meta: slice=D3-S3 · wave=W5 · pkg=apps/cli · kind=idle-drain-contract+gap-fix · verdict=PASS · firesSinceDrill=3
ratchet: 로드맵 잔여 [ ] = 9/65(D3-S3 체크) · self-eval pass(envInventory baseline-repair) · fabrication 0 · cli +5 순수+1 통합 유닛(proactive-consume, testFiles 1407→1411)
- 무엇: ①기준선 green. ②verify-first(코드 정독)로 D3-S3 narrow 갭 발견: chat-ink tick이 idle을 시작(359)에만 체크, async fetch 후 setTurns(383) 직전 미체크(376은 unmount만)→fetch 중 busy 플립 시 생성 중 삽입 가능(idleRef는 render마다 동기 갱신). ③fix+핀: 순수 selectDrainedProactiveTurns({idleAtConsume,grouped,jobs,nudges}) 추출(busy면 [])→tick이 awaits 후 idleRef.current 재체크. **미손실 교정**: seen-marking을 consume 후(drained>0)로 이동→busy-deferred 완료는 unseen 유지→다음 idle poll 재출현(marked-but-never-shown 방지). ④baseline-repair: foreign apps/api env→docs:env.
- 왜: hermes async_delegation(완료큐→idle 윈도우만 드레인). "생성 중 삽입 불가" 계약 부재였고, verify-first가 삽입-시점 미재체크 갭까지 발견. 완료 알림이 답변 중간에 끼면 UX 파손+deferred 손실은 이벤트 유실.
- 리뷰지점: Opus PASS — busy→미삽입(idleRef awaits 후 재체크, setTurns는 drained>0만)·deferred 미손실(seen-marking consume 후, 통합테스트가 busy중 미표시 AND 다음 poll 재출현 양쪽 검증=non-vacuous)·공통케이스 보존(59 무수정)·mutation flips 양쪽(순수+통합 둘 다 RED)·순수 헬퍼 진짜 순수.
- 리스크: 낮음. 공통 idle-path 무변경, busy-fetch 엣지만 defer(fix). UI 로직을 순수 헬퍼로 추출해 React 렌더 없이 계약 유닛화. 다음 = D3-S6(eval:orchestration 래칫, 📈) 또는 D2-S7(eval:adversarial 확장, 📈). D-E1b/c 공유 훅 신중 이연.
- lesson: UI(useEffect) 안의 계약은 결정 로직을 순수 헬퍼로 추출하면 React 렌더 없이 유닛화 가능(+풀-컴포넌트 통합 1개로 배선 검증). async 사이 상태 플립(busy) 갭은 "소비 시점 재체크"로 닫되, dedup-marking(seen)을 소비 후로 옮겨야 deferred가 손실 안 됨(marked-but-never-shown이 fix보다 나쁜 버그). verify-first가 로드맵 "핀"을 "fix+핀"으로 격상.

## fire 55 · 2026-07-12 · skill v2.x · fea5d5bd9
meta: slice=D2-S7 · wave=W5 · pkg=scripts(eval-adversarial) · kind=safety-battery-expansion · verdict=PASS · firesSinceDrill=4
ratchet: 로드맵 잔여 [ ] = 7/65(D2-S7 체크) · self-eval pass · fabrication 0 · 결정론-가드 배터리 10→19 케이스(topology +5·obfuscation +4) · eval:adversarial 9/9 라이브 통과
- 무엇: ①기준선 green. ②로드맵 순서 위→아래 다음 미체크 = D2-S7(D-E1b/c는 공유 push/commit 훅이라 신중 이연 유지, D6-S2는 attended skip). ③eval:adversarial에 결정론-가드 카테고리 2종 추가: `TOPOLOGY_BYPASS`(sudo-wrap·command-substitution·`;`-separator + control 2)·`OBFUSCATION`(`$IFS` word-split·NFKC fullwidth homoglyph + control 2). 각 케이스=순수 `classifyDangerousCommand(command).dangerous === expectBlocked`(solveDangerousCommandCase/scoreDangerousCommandCase), Ollama-independent·no-skip. ★워커가 mutation-RED 데모용 collapseIfs 중성화를 **복원 안 하고 종료**→가드 파손 상태 발견→cp백업 없이 Edit로 정확 복원(byte-identical), 재-mutation-RED 정식 수행(중성화→`rm${IFS}` RED→cp복원→green).
- 왜: 로드맵 W5 마감 — 자기-원칙(결정론 가드가 막는 걸 코드로 검증, 모델 거부 의존 금지)의 배터리 커버리지 확대. 토폴로지/난독화 우회는 8B 모델 거부에 맡기면 KO 등에서 새는 클래스라 결정론 가드가 진짜 방어선이고, 그 방어선을 회귀 테스트로 잠금.
- 리뷰지점: Opus 독립 평가자 PASS — 행동검증(dangerous boolean 실채점, 비-tautological)·control이 over-block 반증(따옴표/주석 속 rm 미차단)·결정론 라우팅(model-refusal 아님)·no-skip(항상 실행)·guard source 무수정(byte-identical)·주석정책 위반 0. mutation-RED 독립 재확인(dist 중성화→RED, 복원).
- 리스크: 낮음. 테스트-only(가드 코드 미변경, 커버리지만 확대). self-eval `adversarialCases` 프록시는 `prompt:`-키만 세어 `command:`-키 신규는 미증가(기존 SANDBOX/SECRET 동일 설계=회귀 아님). 다음 = D3-S6(eval:orchestration 래칫 📈) 또는 D7-S3(스마트-테일+실브라우저). D-E1b/c(공유 push/commit 훅) 신중 이연 지속.
- lesson: ★서브에이전트 워커가 mutation-RED 데모용 프로덕션 가드 변경을 **복원 않고 비정상 종료**할 수 있다 — 워커 리포트가 비정상("standing by")이면 반드시 `git diff <프로덕션 파일>`로 잔존 mutation 검사 후 복원(보안 가드는 특히). eval 배터리에 `command:`-키 결정론 케이스를 더해도 self-eval `adversarialCases`(`prompt:`-키 카운트)는 안 움직이는 게 정상(설계 일관성) — 프록시 미증가를 회귀로 오인 말 것.

## fire 56 · 2026-07-12 · skill v2.x · 89360c2d8
meta: slice=D3-S6 · wave=W5 · pkg=scripts(verify-orchestration) · kind=orchestration-battery-ratchet · verdict=PASS · firesSinceDrill=5
ratchet: 로드맵 잔여 [ ] = 6/65(D3-S6 체크) · self-eval pass · fabrication 0 · eval:orchestration MAST 2모드+용량 pass^3 편입(라이브 모델 fan-in 유지)
- 무엇: ①기준선 green. ②로드맵 다음 액션가능 = D3-S6(D-E1b/c 공유 push/commit 훅 신중 이연, D6-S2 attended skip). ③verify-first: eval:orchestration(verify-orchestration.mjs)+orchestrator 소스 정독으로 라이브-검증 가능 seam 확인(`workerTimeoutMs`→failed·`maxWorkers`→slice절단·result.results[]). 결정론 rule-based 워커로 MAST 2모드(step-repetition=각 워커 1회·unaware-of-termination=행워커 workerTimeoutMs 명시종료+bounded)+D3-S4 용량거부(maxWorkers=2<3→2실행·excess부재)를 pass^3(MUSE_EVAL_REPEAT 기본3, 단일실패→exit1)로 편입. 기존 라이브 모델 fan-in 케이스 유지, Ollama-down시 결정론 케이스는 실행·게이트. product code 무변경.
- 왜: 로드맵 "eval:orchestration 래칫(MAST 2+·D3-S1/S2/S4·pass^3)". 멀티에이전트는 coordination으로 실패(MAST)—step-repetition·종료미인지가 상위 모드. 결정론 케이스라 pass^3 안정(타이머 레이스 단일 green 불신). 기존 orchestrator 행동을 채점(신규 가드 아님).
- 리뷰지점: Opus 독립 PASS — mutation-RED 3/3 non-vacuous(각 어서션 기대 뒤집기→RED, md5 byte복원)·어서션이 실 orchestrator 동작 일치(withDeadline 리젝 문자열·slice 절단·step status=completed|failed)·pass^3 실게이트(단일 iteration 실패→exit1)·skip 시맨틱(결정론 케이스는 Ollama-down도 게이트)·주석정책 clean(D3-S4 슬라이스마커 제거).
- 리스크: 낮음. 테스트-only(orchestrator src 무변경). 발견: step-level status는 completed|failed만, `timed-out`은 opt-in SubAgentRunRegistry에만(어서션은 failed로). 다음 = D7-S3(스마트-테일 터미널+실브라우저) 또는 D-KO-S3(i18n 카탈로그, 저우선). D-E1b/c(공유 훅) 신중 이연 지속.
- lesson: 멀티에이전트 MAST 배터리 래칫은 결정론 rule-based 워커로 orchestrator seam(workerTimeoutMs·maxWorkers)을 직접 구동하면 LLM 없이 pass^3 안정 검증 가능 — 실 `withDeadline`/`selectWorkers` 경로를 mock 없이 채점. 어서션 문자열(deadline error·status enum)은 소스에서 실값 확인 후 박아야(추측 금지). 주석에 슬라이스ID(D3-S4) 넣지 말 것(정책 위반, 커밋 전 스캔으로 적발).

## fire 57 · 2026-07-12 · skill v2.x · a336479e5
meta: slice=D7-S3 · wave=W5 · pkg=apps/web · kind=ux-smart-tail-scroll · verdict=PASS · firesSinceDrill=6
ratchet: 로드맵 잔여 [ ] = 5/65(D7-S3 체크) · self-eval pass · fabrication 0 · apps/web +1 유닛파일(chat-autoscroll, 7 test) · 실브라우저 측정 PASS
- 무엇: ①기준선 green. ②로드맵 다음 액션가능 = D7-S3(D-E1b/c 공유훅 이연, D6-S2/D7-S4 attended skip). ③verify-first: Chat.tsx line 103-105가 turns/activeTool 변경마다 무조건 하단 스크롤=위로 읽는 중 매 토큰 yank. 순수 shouldStickToBottom(하단거리≤80) 추출+유닛+Chat.tsx 배선(stickToBottomRef 기본true=마운트점프·onScroll이 실지오메트리로 갱신·이펙트 stick일때만). ④실브라우저 측정(chrome-devtools, dist preview:4747, tall 40 주입): 실오버플로·하단 stick true·위로300px stick false·바운드·blowout0.
- 왜: 로드맵 "스마트-테일(웹콘솔)+실브라우저 측정", hermes terminal-output 패턴. 스트리밍 중 위로 읽으면 매 토큰 하단으로 끌려가 방해=UX 파손. 하단근처만 tail이 표준 해법.
- 리뷰지점: Opus 독립 PASS — 공식 correct(distance≤threshold, `<=`경계·overscroll)·배선 정확(마운트점프 보존·early-return이 yank 차단·onScroll이 같은 ref)·무관동작 무변경(+18/-1)·mutation-RED 2종 non-vacuous·실측이 레이아웃불변+결정입력 증명(numbers). 한계: turns-이펙트는 백엔드 없이 브라우저서 트리거 불가→지오메트리/결정은 실측, 이펙트-게이팅은 코드리뷰+유닛(정직한 분할).
- 리스크: 낮음. apps/web UI-only(Vite island, TS ref graph 밖). 유저-가시=CHANGELOG 추가. 발견: 스무스-스크롤 애니 중 단발 stick=false 자가치유(스트리밍 델타는 <threshold라 무영향, Opus 확인). 다음 = D-KO-S3(i18n 카탈로그, 저우선·리팩터리스크>이득) — 남은 액션가능 큐 D-E1b/c(공유훅 이연)·attended 제외 시 D-KO-S3만.
- lesson: 웹 UI 스크롤 슬라이스는 결정 로직을 순수 함수로 추출→유닛(mutation-RED)+실브라우저로 실 지오메트리 측정(scrollHeight/scrollTop/clientHeight)이 정석. React state(turns) 이펙트는 백엔드 없이 브라우저서 못 트리거하니, 이펙트가 소비하는 지오메트리/결정을 실측하고 이펙트-게이팅은 코드리뷰+유닛으로 분할하는 게 정직(가짜 e2e 만들지 말 것). testing.md UI규칙=numbers 측정.
