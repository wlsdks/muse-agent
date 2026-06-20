# Loop journal — `paper-grounded`

Theme: 논문-근거 차별화 기능 강화 — Muse의 고유 엣지(deterministic grounding/citation 게이트 ·
RGV rubric verifier · Playbook/RL-flavored strategy memory · whetstone metacognition)를 한 fire에
하나씩 STRENGTHEN하고 라이브/결정론 배터리로 PROVE한다. grounded-surface 카운트는 절대 안 떨어진다.

Worktree `/tmp/muse-paper-grounded` · branch `loop/paper-grounded-features` (Tier2: push, 사람이 머지) ·
cron `f969ae76` (15m, session-only). 매 fire ⓪에서 `git fetch origin && git rebase origin/main`로
작업 전 main 최신을 땡긴다. 규약: [README](README.md).

---

## fire 1 · 2026-06-20 · skill v1.14.0 · b415f08f
meta: value-class=wiring · pkg=@muse/agent-core,@muse/recall,@muse/cli · kind=grounding-gate-calibration · verdict=PASS · firesSinceDrill=1
ratchet: testFiles 1054→1056 · fabrication 0 · groundedSurfaces=28 (no drop) · groundedCases=45 · differentiationBatteries=6 · precheck:grounding recall-citation-gate 2/2 + rubric-reverify 2/2 PASS, faithfulness-rate SKIPPED(box >150s 타임아웃 — pass 아님)
- 무엇: RGV recall 게이트(verifyGrounding / classifyRetrievalConfidence)가 하드코딩 DEFAULT_CONFIDENT_AT=0.55에 묶여 conformal-캘리브레이션 임계값 `MUSE_GROUNDING_MIN_COSINE`를 무시하던 것을 — chat 게이트와 동일한 순수 resolver를 추가하고 recall 진입점(commands-ask 단일홉/--repair/--why · @muse/recall verdict+chunks)에 threading. 옵트인·fail-safe(누락/무효 env면 무변화).
- 왜: muse doctor --calibration이 emit하는 캘리브레이션 임계값을 chat은 존중하는데 recall은 무시 → monitor(conformal)→remediate(gate) 루프가 주 grounded 표면에서 끊겨 있었음. KnowNo conformal coverage(arXiv:2307.01928) 출력을 게이트에 배선해 닫음. 차별화 엣지 (a)fabrication=0 floor + (b)RGV verifier STRENGTHEN, 가법적(표면 카운트 불변).
- 리뷰지점: resolver parse가 chat-grounding.ts와 정확히 일치(분기 없음, fallback 상수만 0.55 vs 0.5). 독립 judge가 chunks.ts threading revert→ent 테스트 RED로 mutation faithfulness 실증. verdict.ts threading은 동일 resolver 재사용이나 전용 mutation 테스트는 없음(기존 recall 328 그린이 가드).
- 리스크: 낮음 — 캘리브레이션 값을 낮게 set하면 cosine 확신-프레이밍 바가 내려갈 수 있으나 chat 게이트와 동일 계약이고 결정론 citation 게이트가 하드 백스톱이라 fabrication 유입 불가.
