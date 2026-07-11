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
