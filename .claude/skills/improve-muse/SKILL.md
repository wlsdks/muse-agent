---
name: improve-muse
description: Use when deciding what internal/hardening work to do next on the Muse repo — at the start of a maintenance pass, after a regression or real failure surfaces, or as the per-fire entrypoint of a hardening loop. Covers defects, silent failures, debt, dead code. For a NEW user-facing capability, use grow-muse instead.
---

# improve-muse — the hardening cycle

One invocation = one hardening slice, end-to-end: find the most valuable
problem in what Muse ALREADY IS → fix/harden/delete → verify → commit AND
push. Sibling `grow-muse` builds what doesn't exist yet.

**Boundary (one item, one owner):** BROKEN / debt / dead weight → here.
MISSING capability → grow-muse. Working-but-poor UX of an existing surface →
grow-muse. Cross-finds get one ◦ line tagged `→grow-muse`, never built here.
A loop calling only this skill hardens forever — pair it with a grow-muse
loop to move both axes.

**Standing authorizations (Jinan 2026-06-27, this skill only):** push on
green verify (never red); auto-pick with no human gate (a genuine ⏳
human-decision fork is skipped with a note, never guessed); scope bigger —
a coherent unit, not the narrowest edit.

## The cycle

1. **ORIENT** — `pnpm self-eval`: non-zero ⇒ the regression IS the slice,
   stop finding. Else `git log --oneline -8`; is Ollama up?

2. **FIND — probe live reality first; ledgers are the fallback. Take the
   FIRST rung that yields:**
   1. self-eval regression.
   2. `node scripts/scout-signals.mjs` — recurring real failures in `.muse/runs/`.
   3. **Live pain probe (≤5 min):** `muse doctor --json`; hit the core
      surfaces (one `ask`, `/health`, web loads); skim newest run errors.
      A paper cut found here (silent failure, wrong exit code, lying copy,
      dead affordance) outranks every ledger line. Fixed this fire ⇒ the
      commit is the record; NOT fixed ⇒ one terse ◦ line so the next probe
      doesn't re-pick it.
   4. `docs/goals/backlog.md` — grep the ★ OPEN block then ◦ hardening
      lines ONLY (never load the whole file). Before committing to any
      item, cross-check git log + codegraph: already shipped ⇒ flip to ✓
      and keep finding.
   5. **Subtraction pass:** dead surface, unused flag, lying doc, duplicate
      logic. Net-negative LOC with green gates is a first-class slice.
      (Removing a user-visible feature is a ⏳ product call.)

   Two rungs both yield? Score user-felt impact × trust-floor relevance ÷
   effort, note it in the pick line. Interactive session: state the pick +
   top-2 runners-up with one-line WHYs, then proceed. Loop fire: pick silently.

3. **SCOPE** — one coherent goal = one commit, acceptance criteria up
   front, and **name the gate this slice moves**. No nameable gate ⇒ too vague.

4. **BUILD + VERIFY** — per `harness/host/dev-loop.md` §3: `pnpm
   test:changed` + build + lint; mutation-RED the new test; independent
   evaluator per `harness.md` risk-tiering (silent-failure classes
   mandatory, pure internal refactor may use the lighter tier — record
   which). **Gate-delta:** record before→after; a slice whose gate didn't
   move is `⚠ shipped-but-insufficient`, not done.

5. **SHIP + CURATE** — one Conventional Commit (evidence in body), push on
   green. Write-back is curation: ONE delta-bearing ✓ line, prune ≥1 stale
   line (net ≈ 0).

## Rationalizations (all observed — reject on sight)

| Excuse | Reality |
|---|---|
| "할 게 없다" | Rungs 3 and 5 never come up empty. Probe, then subtract. |
| "백로그에 ◦ open이니 할 일" | Freshness first — already-shipped items are a ✓ flip, not work. |
| "커밋했으니 done" | Done = the gate MOVED. No delta ⇒ shipped-but-insufficient. |
| "백로그 통째로 읽고 고르기" | Grep the section. Full-loading rots the pick. |
| "새 기능이 더 가치 있어 보임" | Tag `→grow-muse`, keep hardening. One item, one owner. |

Golden set: [`evals.md`](evals.md) — grade outcome shapes, grow from real misses.
