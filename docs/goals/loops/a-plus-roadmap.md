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

## fire 4 · 2026-07-11 · skill v2.x · <commit-pending>
meta: slice=D1-S1 · wave=W1 · pkg=@muse/agent-core · kind=loop-guard · verdict=PASS · firesSinceDrill=4
ratchet: 로드맵 잔여 [ ] = 28/32 · self-eval pass · fabrication 0 · agent-core 2841 test green · pingpong 19 신규 · eval:computer-task PASS(local-forced 1/1, false-abort 없음)
- 무엇: ping-pong 루프가드 tool-loop-pingpong.ts — 모델이 두 툴 사이를 무한 교대(A,B,A,B)하는 걸 trailing-alternation-run으로 감지(창20·warn6·block10), 결과 서명서 휘발필드(runId/tsIso/id/ts/timestamp) 재귀 strip. block→pingPongAbortedExecution(post-compaction 미러) 양쪽 루프 배선. 기존 stall 감지기(A,A,A만)의 사각을 메움.
- 왜: openclaw tool-loop-detection이 별도 케이스로 꼽는 실패모드. 12B는 2-툴 왕복에 잘 빠짐. stall(동일출력)만 잡던 Muse에 교대 감지 추가.
- 리뷰지점: 오탐이 최대 리스크(정당 다단계를 루프로 오인해 abort) → 유닛(genuine progress/stall/3-cycle=none)+Opus 독립 false-positive 배터리+model-loop 2841 green로 검증. id-strip이 args는 보존해 distinct-arg 병합 안 함(Opus 확인). mutation-RED 양방향(교대조건·volatile strip).
- 리스크: eval:computer-task가 ambient GEMINI_API_KEY로 Gemini 하이재킹(VQ-17, eval 정책위반) → MUSE_LOCAL_ONLY=true로 local-forced 재실행 시 PASS(1/1, add-works·multiply-intact·no-collateral, 실 다단계작업이 가드 하에 false-abort 없이 완료). 가드는 10-deep A↔B에서만 abort라 정당작업 불발현.
lesson: "LOCAL OLLAMA ONLY" eval이 실제로 로컬 강제를 안 하면 ambient 클라우드 키에 하이재킹됨 — eval 스크립트는 MUSE_LOCAL_ONLY/MUSE_DEFAULT_MODEL을 명시 강제해야(VQ-17).
