---
name: improve-muse
description: Use when deciding what to work on next in the Muse repo — at the start of a dev session, after finishing a slice, or when it feels like there is nothing left to do. Muse-specific; the daily dev entrypoint.
---

# improve-muse — find the next slice

## Overview

One invocation answers ONE question: **"지금 Muse에서 가장 가치 있는 다음
작업은 무엇인가?"** The deliverable is a short ranked recommendation —
this skill does NOT build. Once a slice is picked (by Jinan, or by
standing autonomous instruction), execution follows
[`harness/dev-loop.md`](../../../harness/dev-loop.md) §3
(PLAN→BUILD→VERIFY→WRITE-BACK→COMMIT) in the normal conversation flow.

**"할 게 없다"는 이 스킬의 유효한 출력이 아니다.** The pipeline below
cannot return empty: a drained backlog means the recommendation IS a
refill scout; a blocked item means the recommendation IS the decision
that unblocks it.

## The pipeline (collect, then rank)

1. **ORIENT** — `pnpm self-eval` (a regression auto-wins rank #1);
   `git log --oneline -5` (what shipped recently);
   `curl -s localhost:11434/api/tags` (live batteries possible?).
2. **COLLECT candidates** from every source, in priority order:
   - (a) self-eval regression → rank #1, stop collecting.
   - (b) `docs/goals/backlog.md` ★ OPEN — a declared PREREQUISITE
     outranks the feature it unblocks.
   - (c) ⏳ blocked-on-Jinan items → "decision-needed" candidates.
     Surface them with the EXACT question + options; never hide them.
   - (d) ◦ ready items.
   - (e) If (a)–(d) yields fewer than 2 actionable candidates → run a
     gap-scout ([`docs/EXPANSION-PLAYBOOK.md`](../../../docs/EXPANSION-PLAYBOOK.md))
     and WRITE its findings back to the backlog — the scout output IS
     the candidate set. This step makes an empty answer impossible.
3. **RECOMMEND** — the deliverable, then STOP:
   - 1–3 candidates: what / why (source line in backlog or failing
     gate) / which gate it strengthens / risk + size.
   - One line: **"내 추천: …"** with the reason it beats the others.
   - Decision-needed (⏳) items listed separately as questions with
     options, so a pick unblocks them.

Building starts only after the pick. An autonomous loop with a standing
instruction takes the top recommendation as its pick and continues per
dev-loop.md — the finder/builder split still holds.

## Forbidden outputs (the failures this skill exists to prevent)

| Rationalization | Reality |
|---|---|
| "★ OPEN 섹션이 비어 있으니 할 게 없다" | Empty top section ≠ no work. Steps (c)–(e) still produce candidates; a refill scout IS the work. |
| "남은 건 blocked뿐이라 못 한다" | Surfacing the blocking decision with the exact question IS the recommendation. |
| "스킬이 호출됐으니 BUILD~COMMIT까지 지금 돌린다" | No — this skill ends at the recommendation. Execution follows dev-loop.md after the pick. |
| "추천만 하면 되니 self-eval은 생략" | ORIENT is the cheapest, highest-signal step; a regression auto-wins. Never skip it. |
| "백로그 읽기 귀찮으니 느낌상 가치 높은 걸 추천" | Every candidate must cite real state — a backlog line, a failing gate, or a labeled trace. |

## Hard rules

- Never end with "nothing to do" — fail-closed to the refill scout instead.
- Never ask "뭘 만들까" as a substitute for running the pipeline; the
  only question to the human is a SPECIFIC ⏳ fork, with options.
- This skill writes at most: backlog refill entries. No `src/` changes,
  no commits, no pushes.
- Non-negotiables stay with the builder: fabrication=0,
  `MUSE_LOCAL_ONLY`, draft-first outbound, verify-before-claim
  (`CLAUDE.md` + `.claude/rules/`).
