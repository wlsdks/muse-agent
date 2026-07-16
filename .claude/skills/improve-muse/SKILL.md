---
name: improve-muse
description: Autonomous HARDENING cycle for the Muse repo — find the highest-value reliability/health work on what ALREADY EXISTS (regression, real failure, live paper cut, hardening debt, deletion candidate), build it, verify it (maker≠judge, gate-delta), then commit AND push. Use for internal improvement passes and as a loop entrypoint. For NEW user-facing capabilities use grow-muse instead. Never returns "nothing to do".
---

# improve-muse — the hardening cycle (지키고 다듬는 쪽)

## What this is

One invocation = **one substantial hardening slice, carried end-to-end**:
find the most valuable problem in what Muse ALREADY IS → fix/harden/delete →
verify → commit AND push. Its sibling [`grow-muse`](../grow-muse/SKILL.md)
builds NEW capabilities; this skill keeps the existing product healthy. The
split exists because a single queue lets one kind of work crowd out the
other — maintenance must be explicitly queued or it silently loses
(industry consensus: analysis/planning/execution loop separation).

- **Never-empty.** Five FIND rungs guarantee a real item. "할 게 없다" is a
  BUG, never an output.
- **Self-contained.** It picks, builds, verifies, and pushes — it does not
  stop at a recommendation.
- **Analysis over retrieval.** The top rungs PROBE live reality (gates,
  runs, the booted product); ledgers are the fallback, not the source of
  truth. A list written last month is a hypothesis, not a fact.
- **Boundary:** BROKEN (defect, silent failure, debt, dead weight) → here.
  MISSING (capability that doesn't exist) → grow-muse. **Working-but-poor**
  (an existing surface that functions but serves the user badly — UX/quality)
  → grow-muse, because it changes what the user can do/feel. One item, one
  owner — never both, never neither.
- **Solo-loop limitation:** a loop that calls only this skill hardens forever
  and never grows. Pair or alternate with a grow-muse loop to move both axes.

## Standing authorizations (deltas from repo defaults — Jinan 2026-06-27)

- **PUSHES** on green verify (overrides "never push without approval" for
  this skill only). Never push red.
- **Auto-picks** without a human gate (exception: a genuine ⏳
  human-decision fork is skipped, never guessed).
- **Bigger slices** — a coherent unit, not the narrowest edit.

## The cycle

1. **ORIENT** — `pnpm self-eval` (regression auto-wins); `git log --oneline -8`
   (freshness oracle); `curl -s localhost:11434/api/tags` (live evals possible?).

2. **FIND — probe first, ledger later. Take the FIRST rung that yields, then stop.**

   1. **self-eval regression** → fixing it IS the slice.
   2. **failing-signal cluster** — `node scripts/scout-signals.mjs` (recurring
      real failures in `.muse/runs/`). A real failure beats a guess.
   3. **live pain probe (dogfood lens)** — spend ≤5 minutes PROBING the product
      a real user touches today, not reading about it: `muse doctor --json`;
      boot/hit the core surfaces (`ask` one question, `/health`, web loads);
      skim the newest `.muse/runs` errors and the latest user-sim findings if
      fresh. A paper cut found here (silent failure, wrong exit code, lying
      copy, dead affordance) outranks any ledger line — the most valuable
      sessions on record came from exactly this rung, and no ledger contained
      them. Error-analysis first, imagination never (`agent-testing.md`).
      **Dedup rule:** a probe finding you fix this fire needs no ledger line
      (the commit is the record); a finding you DON'T fix (too big, ⏳,
      deferred) gets one terse ◦ line so the next probe skips re-discovering
      it instead of re-picking the same cut every fire.
   4. **hardening backlog** — `docs/goals/backlog.md`, grep ★ OPEN then ◦ ready
      lines whose kind is hardening/reliability/test-teeth/debt. **Apply the
      FRESHNESS GUARD** (below). Parity/new-capability lines belong to
      grow-muse — skip them here.
   5. **subtraction pass** — the rung no ledger will ever contain: a dead or
      inert surface, an unused flag, a view/command nobody's path reaches, a
      stale doc that lies, duplicated logic. Net-negative LOC with green gates
      is a first-class slice (a deletion that is a PRODUCT call — removing a
      user-visible feature — is a ⏳ human fork, not the agent's).

   **RETRIEVAL DISCIPLINE:** never full-load a ledger — backlog.md (3k+ lines)
   is a retrieval index; grep ONLY the section you need. Context rot degrades
   the pick.

   **FRESHNESS GUARD:** before committing to ANY ledger item, cross-check
   git log + codegraph — an `◦ open` item may already be shipped. Already
   done ⇒ flip it to ✓ (hygiene) and continue FIND.

   **Tie-break rubric** (when two rungs both yield): score each 1–5 on
   user-felt impact today × trust-floor relevance ÷ effort+risk; note the
   scores in the pick line. No vibes-ranking.

3. **MODE** — in a loop fire, pick silently. In an interactive session,
   state the pick AND the top-2 runners-up with a one-line WHY each (the
   human deserves to see the ranking), then proceed without waiting.

4. **SCOPE** — one coherent goal = one commit, acceptance criteria up front,
   and **name the gate/metric this slice moves** (a scoreboard count, a
   battery rate, lint, a new test's existence). No nameable gate ⇒ too vague.

5. **BUILD** — per [`harness/host/dev-loop.md`](../../../harness/host/dev-loop.md) §3:
   deterministic code for policy/guards (never a prompt), tests first where
   they bite, rebuild touched packages.

6. **VERIFY (fail-closed, maker≠judge, outcome-tied)** —
   - `pnpm test:changed` + `tsc -b` + lint on touched files; live evals when
     Ollama is up; real-browser measurement for web UI.
   - Mutation check: the new test goes RED on a code mutation (run it, or
     state deterministic-by-construction when the assertion names the value).
   - **Independent evaluator** per `harness.md` risk-tiering: MANDATORY for
     user-visible strings, persisted formats, contracts, security paths, and
     the silent-failure classes; a pure internal refactor / dead-code
     subtraction may use the lighter tier (builder adversarial self-check +
     diff skim), recorded in the commit body. Uncertain ⇒ FAIL.
   - **GATE-DELTA:** record the named gate's before→after. A slice whose gate
     didn't move is `⚠ shipped-but-insufficient`, not done — the scoreboard
     decides sufficiency, not the ✓ mark.

7. **SHIP + CURATE** — one Conventional Commit (verification evidence in the
   body), `git push` on green. Write-back as CURATION: distill to ONE
   delta-bearing line, prune ≥1 stale entry (net line growth ≈ 0), record new
   findings as terse ◦ lines (incl. unfixed probe findings — the dedup rule).

## Guardrails (fail-closed — autonomy does NOT relax these)

- **Regression-first.** self-eval non-zero ⇒ that fix is the whole slice.
- **Maker ≠ judge.** The verifier is a different instance than the builder.
- **Verify before claim; push only on green.**
- **fabrication = 0**, `MUSE_LOCAL_ONLY`, draft-first outbound, banking out of
  scope — all still bind (`CLAUDE.md` + `.claude/rules/`).
- **⏳ human forks are skipped, never guessed.**
- **Concurrent-loop hygiene:** `git pull --rebase` before push, explicit
  `git add <paths>`, rebuild touched deps; non-fast-forward ⇒ rebase, never force.
- **Scope boundary:** if FIND surfaces a NEW-capability idea, don't build it
  here — record one ◦ line tagged `→grow-muse` and keep finding a hardening
  item. (Symmetric rule in grow-muse.)

## Forbidden outputs

| Rationalization | Reality |
|---|---|
| "할 게 없다" | A BUG — rung 3 (probe the live product) and rung 5 (subtraction) never come up empty. |
| "백로그에 ◦ open이니 할 일" | FRESHNESS GUARD first — shipped items are hygiene, not work. |
| "추천만 하고 멈춘다" | This skill finishes and pushes. Interactive mode shows the ranking, then proceeds. |
| "잔챙이 한 줄로 슬라이스 완료" | Scope a coherent substantial unit. |
| "테스트/lint 건너뛰고 푸시" | Green verify or no push. |
| "새 기능이 더 재밌겠다" | Scope boundary — tag `→grow-muse`, keep hardening. |
| "커밋했으니 done" | Done = the gate MOVED. No delta ⇒ `⚠ shipped-but-insufficient`. |
| "백로그 통째로 읽기" | Retrieval discipline — grep the section only. |

## Evaluation

[`evals.md`](evals.md): repo-state → expected end-to-end behavior. Grade the
outcome shape; grow it from real misses.
