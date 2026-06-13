# Loop journal — agent-core-cognition

Per-loop journal (loop-creator v1.14.0). Cron 39b9bdec (15m). Successor to the
fires 1–41 chain recorded in the shared `loop-digest.md` (retired for this loop to
avoid cross-loop conflict). Theme: agent-core Muse cognition core strengthening,
paper-grounded (public arXiv only), 5-theme round-robin → gap-scout. Tier1.

## fire 1 · 2026-06-13 · skill v1.14.0 · 9b6b5a3e
meta: value-class=new-capability · pkg=@muse/agent-core+@muse/cli · kind=recall-ranking-selection · verdict=PASS · firesSinceDrill=1
ratchet: testFiles 905→906 (+commands-ask-adaptive-k) · fabrication 0 (STRENGTHENED — fewer decoys) · eval n/a (deterministic selection)
- 무엇: Adaptive-k (arXiv:2506.08479, Taguchi/Maekawa/Bhutani EMNLP 2025) — `selectByScoreGap` (largest consecutive-gap knee) trims the `muse ask` grounding window to `effectiveK = min(topK, gap-cut)` in `diversifyAskChunks`. Trim-only (cap topK, floor 1, top match always kept). Distinct from shipped MVT (mean give-up vs largest cliff).
- 왜+arXiv: fixed topK=3 padded the prompt with near-miss decoys when scores fall off a cliff (fabrication surface for the local 12B); the paper's single-pass distribution-based k trims to the natural knee. Diversified off the last 2 council/semantic fires (40/41). arXiv:2506.08479.
- 리뷰지점: maker=Sonnet / judge=Opus 4.8 (independent, Fable-5 세션 미가용). v1 FAIL (FLOOR: gap-cut fed the trimmed set to classifyRetrievalConfidence which keys on top AND runner-up → borderline-flat verdict flipped "ambiguous"→"confident", false confidence). v2 PASS: split prompt-window trim from verdict input (notesGroundingFraming takes UNTRIMMED preGapScored). Judge swept ALL trimmed-set consumers floor-safe/fail-closed; counterfactual non-vacuous (verdict-from-trimmed → confident); non-inert real-revert (cliff→1 fails when disabled). Independent re-verify: agent-core 1943 + cli 2563 + builds + lint green.
- 리스크: 낮음 — trim-only count selection over the user's own chunks; verdict provably unchanged (from untrimmed distribution); fewer chunks → lower coverage → MORE ungrounded (fail-closed); fail-open on flat distribution. Caveat (process): the Opus judge accidentally `git checkout`ed the uncommitted commands-ask.ts mid-judging and reconstructed it byte-faithfully — orchestrator independently re-ran the full suite (floor + counterfactual + value tests pass) before commit, confirming soundness. Backlog: extend to recall/render surfaces; A/B gap vs MVT vs fixed on embedder-ab; per-query-type k.

## fire 2 · 2026-06-13 · skill v1.14.0 · bcab580e
meta: value-class=wiring (merge-integration/regression-fix) · pkg=@muse/recall+@muse/cli+@muse/agent-core · kind=merge-resolution · verdict=PASS · firesSinceDrill=2
ratchet: testFiles ~915 (origin refactor) · fabrication 0 · lint pass→fail→pass (regression fixed)
- 무엇: ORIENT의 `git merge origin/main`이 origin의 **@muse/recall 패키지 추출**(diversifyAskChunks/notesGroundingFraming/ScoredChunk가 commands-ask.ts→packages/recall/src/chunks.ts로 이동)을 끌어왔고, fire-1이 같은 함수들을 commands-ask.ts에서 수정했던지라 충돌. 내가 markers 미해결 상태로 merge를 잘못 커밋(lint pass→fail 회귀) → reset 후 재해결.
- 왜+근거: ①의 "self-eval non-zero면 그 회귀가 이번 이터레이션" — lint 회귀(conflict marker)가 fire 2의 일. commands-ask.ts는 origin 구조 채택(함수 @muse/recall import) + fire-1 call-site(preGapScored→verdictInput) 보존; chunks.ts에 fire-1 adaptive-k(selectByScoreGap, arXiv:2506.08479)+floor-fix 재이식(origin 추출본은 fire-1 이전). followup-capture-hook.test.ts의 in-test 배럴 dynamic import(~5s cold transform > 5000ms)가 결정적 타임아웃 → 정적 import로 근본 수정(17/17, 1.21s).
- 리뷰지점: maker=Opus worker(복잡 멀티패키지 merge). 별도 ④b 적대 judge 없음 — merge-resolution은 fire-1 슬라이스(이미 fire 1서 Opus judge v2 PASS)를 재배치한 것이라, 결정적 게이트로 검증: lint exit 0(markers 제거=회귀픽스), @muse/recall 70, agent-core followup 17/17, cli ask+adaptive-k floor 테스트 통과, fire-1 floor-fix(verdict=untrimmed) chunks.ts에 보존+통과. 오케스트레이터 독립 재검증(전 게이트 직접 실행). 51 origin 파일 중 commands-ask.ts만 충돌(나머지 auto-merge).
- 리스크: 낮음 — origin 구조+fire-1 가치 둘 다 보존, selectByScoreGap 단일 정의(agent-core, origin이 MMR 셀렉터 안 옮김). pnpm check 잔여 실패=문서화된 mcp playbook-store weighted-eviction 타임아웃 flake(미터치, scope상 mcp 회피, 경부하서 통과). pnpm install로 recall→mcp workspace symlink 배선(lockfile 무변). 교훈: merge 시 markers를 docs뿐 아니라 `git diff --name-only --diff-filter=U` 전체로 확인할 것(이번에 commands-ask.ts marker를 놓쳐 회귀 커밋).
