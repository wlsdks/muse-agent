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

## fire 2 · 2026-06-20 · skill v2.0.0 · `7b22ce7f`
meta: value-class=wiring · pkg=@muse/cli (+@muse/mcp) · kind=whetstone learn→apply / DRY-unify · verdict=PASS · firesSinceDrill=2
ratchet: testFiles=1057→1058 (new chat-weakness-nudge.test.ts) · fabrication 0 · gates: mcp 1872 + cli 2766 + check EXIT=0 ALL packages clean + self-eval ok + lint pass

- **무엇:** chat의 하드코딩 repeat-weakness nudge를 공유 `askTimeWeaknessNudge` + 추출한
  `renderAskTimeNudge`(단일 axis-aware KO/EN 문구)로 통일. ask는 byte-identical 리팩터,
  chat은 `chatRepeatWeaknessNudge`(ledger 읽기→선택→렌더)로 교체.
- **왜:** 기존 chat nudge는 이번-턴 refusal에서만·이번-턴 count로·grounding-gap "노트 추가"만
  하드코딩 → **source-conflict 재조정 힌트 불가 + mastery 억제 불가**. ask는 이미 공유 헬퍼 사용 →
  chat을 parity로 끌어올리고 두 표면 문구 drift 차단 (N1 follow-up).
- **리뷰지점:** ④b 독립 Opus judge가 **md5로 ask 4문구 byte-identity 확정** + 행동 델타(ledger
  기반 발화=ask와 동일 의도적 parity) 안전 + misgrounding 제외 보존 + lazy-import 불변식 + mutation
  RED 재현. chat은 @muse/mcp를 runtime `await import`(bun 바이너리), 타입만 `import type`.
- **리스크:** 낮음 — 결정론적, recordChatWeaknessForTurn 양 분기 불변(부작용 동일), fail-close(throw→
  no nudge). nit: chat이 grounded 성공 시 recordWeaknessResolved 안 함(ask는 함) → 닫힌 gap이 BKT
  mastery까지 계속 nudge (backlog ◦ NEXT로 등록, 범위 밖·기존 공유-ledger 속성).
- **형제-감사:** ask/chat 두 point-of-use 표면 모두 이번에 공유 헬퍼로 수렴 — recap은 별도 selectVolatileBeliefs 경로(무관).
