# Loop journal — self-improvement

**Theme:** hermes-style self-improvement machinery — Playbook (strategy memory,
RL-style reward↑/decay) · whetstone (weakness ledger) · Skill authoring ·
Reflection/dreaming · memory consolidation (Mem0-style). Strengthen + PROVE each,
keeping the grounding floor (fabrication=0) intact.

**Autonomy:** Tier1.5 — dedicated branch `loop/self-improvement` in a /tmp
worktree; each fire commits locally and syncs from LOCAL main (rebase) to stay
conflict-free; **every 3 fires FF-merges into LOCAL main** (진안 directive). Hard
floor: NO push, NO remote auto-merge, NO force, NO `--no-verify`.

**Cadence:** session cron `0b48bb96`, 20 min. **Stop:** `CronDelete 0b48bb96` or cmux.

**Surfaces & packages:** `@muse/mcp` (playbook/whetstone stores) · `@muse/agent-core`
(reflection, playbook ranking) · `@muse/memory` (consolidation/decay) · `@muse/skills`
(authoring/curate). Live battery: `pnpm eval:self-improving` (LLM merge/preference/pattern
paths) + `pnpm eval:agent` (judge/shadow-trial) when those are touched.

---

## fire 1 · 2026-06-20 · skill v2.0.0 · `1b9d31a7`
meta: value-class=micro-fix · pkg=@muse/mcp · kind=correctness/RL-ranking · verdict=PASS · firesSinceDrill=1
ratchet: testFiles=1057 (tests added to existing file) · fabrication 0 · gates: mcp 35/35 + check (saturation-only timeouts, clean in isolation) + self-eval ok + lint pass · eval:self-improving N/A (deterministic store, no LLM path)

- **무엇:** `retainPlaybookEntries` bank-overflow eviction을 raw point-estimate `reward`
  정렬 → PEVI Wilson-LCB `retentionUtility`(inline-replicated `rankingUtility`) 정렬로
  교체. no-tally는 `clampReward(reward)`로 byte-identical 폴백.
- **왜:** injection 경로(`rankingUtility`, Wilson LCB)와 생존 랭킹이 불일치 → thin-but-lucky
  전략이 battle-tested 전략을 파괴적으로 evict (PEVI arXiv:2012.15085 edge c). paper-grounded
  fire 3이 `effectiveStrategyReward`(shrinkage) 잘못 복제로 롤백된 그 항목의 corrected fix.
- **리뷰지점:** mcp는 의도적으로 agent-core 무의존(자체 REWARD_MIN/MAX) → import 아닌 inline-
  replicate가 정답. 판별 테스트(thin 1/0 reward=5 vs proven 11/9 reward=1, cap=1)는 old에서
  RED("thin" 생존) → new에서 GREEN("proven"). ④b 독립 Opus judge가 올바른 함수 복제(util
  proven −1.58 vs shrinkage +0.43로 구분)·산수·1870 통과 확인.
- **리스크:** 낮음 — 결정론적 store 로직, 공개 API 무변경, retentionUtility는 file-private,
  4개 레거시 retain 테스트 byte-identical. recency discount는 미적용(time-free, index tie-break
  유지 — `rankingUtility` nowMs-undefined 형태와 동일).
- **형제-감사:** raw-reward eviction sort는 이 한 곳뿐(injection 경로는 이미 rankingUtility) — clean.
