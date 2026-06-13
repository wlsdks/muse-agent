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
