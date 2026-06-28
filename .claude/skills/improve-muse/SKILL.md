---
name: improve-muse
description: Autonomous end-to-end improvement cycle for the Muse repo — find the single highest-value real work, scope it substantially, build it, verify it (maker≠judge), then commit AND push. Use at the start of a dev session, after finishing a slice, or as the SOLE per-iteration entrypoint of an infinite improvement loop. It carries one substantial slice all the way to a pushed commit and NEVER returns "nothing to do".
---

# improve-muse — autonomous improvement cycle

## What this is

One invocation = **one substantial improvement, carried end-to-end**: find
the most valuable real work → scope it properly → build it → verify it →
commit AND push. This is the SOLE entrypoint a loop needs — a cron/loop that
calls only this skill, every fire, runs Muse-improvement forever. So two
properties are load-bearing:

- **Never-empty.** There is ALWAYS a real next slice (the reservoirs below
  hold 200+ vetted opportunities + open hardening). "할 게 없다" is a BUG,
  never an output.
- **Self-contained.** It does not stop at a recommendation and wait. It picks
  the top item itself and finishes it. (The old finder-only split is retired.)

## Standing authorizations (deltas from the repo defaults — Jinan 2026-06-27)

This skill operates with autonomy the normal rules withhold; everything not
listed here still binds.

- **PUSHES.** After the verify gates are green it commits AND `git push`es the
  current branch — overriding the default "never push without approval" FOR
  THIS SKILL ONLY. Push happens only on green (see guardrails); never push red.
- **Auto-picks.** It chooses the top item without asking — no human gate on the
  pick. (A genuine human-decision ⏳ fork is the one exception: skip it, don't
  guess — see guardrails.)
- **Bigger slices.** Scope a meaningful unit, not the narrowest possible edit.

## The cycle

1. **ORIENT** — `pnpm self-eval` (a regression auto-wins; ~1.5s warm via the
   eslint cache, reuse this session's recent run if nothing changed since);
   `git log --oneline -8` (recently shipped — also the freshness oracle);
   `curl -s localhost:11434/api/tags` (are live evals possible?).

2. **FIND — prioritized, never-empty, RETRIEVE don't full-load.** Walk these in
   order; take the FIRST that yields a real item, then stop searching.
   **RETRIEVAL DISCIPLINE (load less, not cheaper):** NEVER read a whole ledger
   into context — backlog.md (3k+ lines) and capability-parity-backlog.md (2k+)
   are RETRIEVAL indexes, not documents to ingest. `grep`/extract ONLY the
   section you need (the ★ OPEN block, the ◦ ready lines, the one reservoir item
   you're scoping). A large context actively DEGRADES the pick — every frontier
   model gets worse as input grows and a single distractor misleads it (Chroma
   "context rot"; coding agents' primary failure mode). Caching does NOT fix this
   — cached-but-present tokens still rot the judgment; the fix is loading less.
   1. **self-eval regression** → fixing it IS the slice.
   2. **failing-signal cluster** — `node scripts/scout-signals.mjs` (recurring
      real failures in `.muse/runs/`). A real failure beats a guess.
   3. **backlog `docs/goals/backlog.md`** — ★ OPEN (a prerequisite outranks
      what it unblocks), then ◦ ready. **Apply the FRESHNESS GUARD** (below).
   4. **capability-parity reservoir** — [`docs/goals/capability-parity-backlog.md`](../../../docs/goals/capability-parity-backlog.md)
      (200+ vetted, code-grounded opportunities vs hermes/openclaw) filtered by
      [`capability-parity-judgment.md`](../../../docs/goals/capability-parity-judgment.md)
      (`build`/`core`/`strengthens` items only — skip off-strategy).
   5. **gap-scout** — [`docs/EXPANSION-PLAYBOOK.md`](../../../docs/EXPANSION-PLAYBOOK.md):
      inert/dead-but-tested surfaces, thin-coverage packages, hardening.
   The reservoir guarantees this never comes up empty. Pick the SINGLE
   highest-value item and write a one-line WHAT+WHY+gate-it-strengthens.

   **FRESHNESS GUARD** (before committing to ANY ◦/★/⏳ item): the backlog lags
   reality — an `◦ open` item may ALREADY be shipped (observed: A2/A3). Cross-
   check against `git log` + codegraph (does the symbol/wiring already exist?).
   Already done ⇒ it is a one-line backlog-hygiene fix (flip to ✓), NOT the
   slice — then continue FIND for a real item.

3. **SCOPE (bigger, but ONE coherent goal).** Frame a substantial unit — a real
   capability/hardening/wiring with acceptance criteria — not a one-line tweak,
   and not a sprawl of unrelated edits. One coherent goal = one commit. Define
   the acceptance criteria up front (the planner contract,
   [`harness/core/handoff-template.md`](../../../harness/core/handoff-template.md))
   AND **name the gate/metric this slice will move** (a self-eval scoreboard count,
   a specific eval battery's rate, lint, a new test) — VERIFY measures its
   before→after, so a slice with no nameable gate is too vague to be "done".

4. **BUILD** — implement per [`harness/host/dev-loop.md`](../../../harness/host/dev-loop.md) §3:
   one coherent slice, deterministic code (policy/guards are code, never a
   prompt), tests first where they bite. Build the packages you touched.

5. **VERIFY (fail-closed, maker≠judge, OUTCOME-tied).** A slice is NOT done until:
   - the narrow related tests + `tsc -b` build + `pnpm lint` pass — run
     `pnpm test:changed` (vitest `related` on your git-changed files, NOT a whole
     package suite; ~12.8k cases across 1194 files makes a full run per slice pure
     waste), the rung that exposes THIS change; live evals when Ollama is up;
   - a mutation check confirms the new test has teeth (RED on a code mutation);
   - an **independent evaluator** (a different subagent than the one that built
     it) judges PASS against the acceptance criteria. Uncertain ⇒ FAIL, don't
     pass. `fabrication=0` is a release gate, never relaxed.
   - **GATE-DELTA (done means the gate MOVED, not that a commit landed):** record
     the named gate's before→after in the `pnpm self-eval` scoreboard. "Done" is
     a MEASURED outcome, not a self-report — an LLM agent is an unreliable self-
     evolver, so a slice whose gate did not move (or regressed) is NOT done even
     if it compiles and committed: reopen it as `⚠ shipped-but-insufficient`.
     This is the answer to "이미 했어도 부족할 수도 있다" — the scoreboard, not the
     ✓ mark, decides sufficiency.

6. **SHIP + CURATE** — one Conventional Commit (English subject), then **`git
   push`** the current branch (standing authorization above) — ONLY after VERIFY
   is green. Then WRITE-BACK as CURATION, not accretion (a ledger that only grows
   becomes the distractor that rots the next pick):
   - **distill** the shipped item to ONE verified-done line carrying its gate-
     delta (`✓ X — gate Y 0.55→0.45`), not a paragraph;
   - **prune** at least one now-stale/obsolete entry each fire (net line growth
     ≈ 0 — the backlog is a curated retrieval index, not an archive);
   - record any new finding as a terse ◦ refill line.
   A loop re-invokes for the next slice; an interactive caller gets a short
   Korean report.

## Guardrails (fail-closed — autonomy does NOT relax these)

- **Regression-first.** self-eval non-zero ⇒ that fix is the whole slice.
- **Maker ≠ judge.** The verifier is a different instance than the builder.
- **Verify before claim.** No "works" without the gate output; push only on green.
- **fabrication = 0**, `MUSE_LOCAL_ONLY`, draft-first outbound, banking out of
  scope — all still bind (`CLAUDE.md` + `.claude/rules/`).
- **⏳ human-decision forks are NOT the agent's to make.** A security-posture
  tradeoff / product call / scope decision: SKIP it (leave it ⏳, record why)
  and pick the next buildable item — never stop the loop, never guess the human's
  call.
- **Concurrent-loop hygiene** (main worktree): `git pull --rebase` before push,
  explicit `git add <paths>` (never `-A`), rebuild touched deps (stale dist
  masquerades as a bug). On a non-fast-forward, rebase and retry — never force.

## Forbidden outputs

| Rationalization | Reality |
|---|---|
| "할 게 없다 / nothing to do" | A BUG. The reservoirs hold 200+ real items; FIND just didn't reach them. |
| "후보 추천만 하고 멈춘다" | Retired. This skill finishes the slice and pushes — it does not wait at a list. |
| "백로그에 `◦ open`이니 아직 할 일" | Run the FRESHNESS GUARD — an already-shipped item is hygiene, not work. |
| "잔챙이 한 줄 고치고 슬라이스 완료" | Too small. Scope a substantial coherent unit (bigger slices are the directive). |
| "테스트/lint 건너뛰고 커밋·푸시" | Push only on a green VERIFY. Red ⇒ no push. No exceptions. |
| "⏳ 사람 결정인데 내가 정해서 진행" | Skip it, record why, take the next buildable item. Don't guess a human call. |
| "백로그/저수지를 통째로 읽고 후보 고름" | RETRIEVAL DISCIPLINE — grep the section you need; full-loading a 3k-line ledger rots the pick (context rot). |
| "커밋했으니 done" | Done = the gate MOVED on the scoreboard. No before→after delta ⇒ `⚠ shipped-but-insufficient`, not ✓. |
| "백로그에 done 줄만 계속 추가" | CURATE: distill to one delta-bearing line + prune a stale entry (net ≈ 0). An append-only ledger becomes the distractor. |

## Evaluation (this skill ships with evals — `agent-testing.md`)

[`evals.md`](evals.md): repo-state → expected end-to-end behavior (regression /
stale-but-open / blocked-only / reservoir-pull / properly-scoped / green-gate-
before-push). Grade the outcome shape, grow it from real misses.
