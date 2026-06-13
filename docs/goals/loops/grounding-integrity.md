# Loop journal — GROUNDING INTEGRITY & SELF-IMPROVEMENT RELIABILITY

> Theme: ① grounded≠true ceiling (poisoned/untrusted source → confident "grounded" lie) redteam + deterministic defense · ② self-improvement subsystem (playbook/reflection/weakness-ledger/background-review) reliability+coverage · ③ self-judge meta-eval (maker=judge compensating control) hardening.
> Worktree `/tmp/muse-grounding-integrity` (branch `loop/grounding-integrity`). Tier1.5 — local commit + merge to LOCAL main when green, NEVER push. Convention: [README](README.md).

## fire 1 · 2026-06-13 · skill v1.14.0 · c09f3465
meta: value-class=redteam-defense · pkg=@muse/agent-core+@muse/cli · kind=A · verdict=PASS · firesSinceDrill=1
ratchet: cli tests +3 cases (2558 pass) · agent-core suite pass · lint 0/0 · fabrication 0 · grounding floor intact (additive warning only)
- 무엇: dead `groundedOnUntrustedOnly` 완화를 `muse ask` verdict 경로에 wiring — faithful이지만 untrusted-only(MCP/web tool output, `trusted:false`) 출처에만 근거한 답에 provenance 경고를 surface. 함수는 agent-core index에 re-export조차 안 돼 있던 죽은 코드(프로덕션 호출자 0).
- 왜: grounded≠true 천장의 한 벡터를 닫음 — source veracity는 고정 로컬모델로 알 수 없으나 source TRUST(provenance bit)는 알 수 있고, 그걸 사용자에게 노출해 추가 검증을 유도.
- 리뷰지점: `commands-ask.ts` verdict 경로 — 라벨은 "grounded" 유지(답은 faithful), stderr 경고만 추가. `!verdictNotice && imageAttachments===0` 가드로 already-ungrounded/vision 경로 불변. 독립 Opus judge가 5개 적대 체크 전부 PASS.
- 리스크: tool 출처 citation 형식(`[from tool: X]`)이 실제 모델 출력과 어긋나면 프로덕션 발화율이 낮을 수 있음 — 단위테스트는 함수 계약을 고정하지만 e2e 발화율은 후속 `eval:grounding-delta`로 측정 필요(backlog 후보로 기록).

## fire 2 · 2026-06-13 · skill v1.14.0 · 0a38b477
meta: value-class=reliability-coverage · pkg=@muse/autoconfigure · kind=B · verdict=PASS · firesSinceDrill=2
ratchet: autoconfigure distill-queue +2 tests (4 pass) · lint 0/0 · fabrication 0 · mutation-verified non-vacuous (RATCHET: fire1=redteam-defense/agent-core+cli → fire2=reliability-coverage/autoconfigure, diversified)
- 무엇: 무인 distill-consumer(`distillQueuedCorrections`)의 두 안전 불변식을 OUTCOME 테스트로 고정 — dud(빈 correction)·fail-soft(distiller undefined) 둘 다 큐에서 drain(잼 방지) + zero 전략 기록(비-corrective 신호는 교훈 날조 안 함). 소스는 이미 정확(`doneIds.push`가 두 가드보다 앞), 무방비였던 보장을 보호.
- 왜: 매 idle tick 도는 무인 소비자라 잼이면 같은 dud를 영원히 재처리, fence가 뚫리면 비-correction에서 가짜 lesson 생성 — Muse edge가 의존하는 류의 불변식인데 테스트 0이었음.
- 리뷰지점: 실제 파일-백드 큐/playbook 스토어(enqueueLearnEvent/readPendingLearnEvents/readPlaybook) 위 OUTCOME; test1의 distill은 throw 주입(빈 이벤트가 distill 전에 fence됨을 증명). mutation(drain을 가드 뒤로 이동)→test red→revert로 비-공허성 증명, 독립 Opus judge가 자체 mutation 2종으로 재확인 PASS.
- 리스크: 테스트-only 슬라이스(소스 무변경) — 회귀 가드 가치이지 신규 동작 아님. pnpm check 전체는 단일 테스트파일 변경엔 불비례라 패키지 빌드+테스트+lint로 대체.
