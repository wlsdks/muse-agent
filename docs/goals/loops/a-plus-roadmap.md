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
