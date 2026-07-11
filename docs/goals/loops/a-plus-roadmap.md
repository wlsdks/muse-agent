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
