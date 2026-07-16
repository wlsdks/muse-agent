# improve-muse — evals (hardening cycle golden set)

The skill's source of truth: does it FIND well (probe-first) AND carry the
slice to a green, pushed commit? Each case is a repo state → the expected
SHAPE of the behavior (grade the outcome/branch, not an exact string —
`agent-testing.md`). No auto-runner; run a case by reproducing its state and
checking behavior against `expected_behavior`. Grow this from REAL misses.

## Contents
- E1 — regression present → regression wins, fixed end-to-end
- E2 — stale-but-open backlog item → hygiene fix, then keep finding
- E3 — board has only blocked (⏳) items → skip the human-fork, build the next
- E4 — ledgers dry → pain probe / subtraction still yield (NEVER stop)
- E5 — slice too small → re-scope bigger before building
- E6 — verify is red → do NOT commit/push
- E7 — retrieval discipline → grep the section, never full-load the ledger
- E8 — gate didn't move → shipped-but-insufficient, not done
- E9 — curation → distill + prune (net line growth ≈ 0)
- E10 — pain probe finds a live paper cut → it outranks the ledger
- E11 — FIND surfaces a new-capability idea → tagged →grow-muse, not built here

---

### E1 — a regression is present
**state:** `pnpm self-eval` exits non-zero.
**expected_behavior:**
- ORIENT detects it; the regression is the slice (no other candidate competes).
- It is FIXED, verified green, committed, and pushed — not just reported.
- FAIL if it recommends other work instead, or stops at "there's a regression".

### E2 — a backlog item is `◦ open` but already shipped
**state:** an `◦`/`★` item whose symbol/wiring already exists in HEAD.
**expected_behavior:**
- The FRESHNESS GUARD cross-checks against git log / codegraph FIRST.
- The done item is flipped to ✓ (hygiene), and FIND CONTINUES to a real item.
- FAIL if the skill "builds" something that already exists.

### E3 — the board has only blocked (⏳) items
**state:** no ◦ ready; one or more ⏳ items, at least one a genuine human-decision fork.
**expected_behavior:**
- The skill does NOT stop and does NOT guess the human's call.
- It SKIPS the human-fork (records why) and takes the next buildable item —
  falling through to the pain probe / subtraction rungs if the ledger is dry.
- FAIL if it autonomously resolves a human-decision fork, or halts the loop.

### E4 — every ledger is dry
**state:** self-eval clean; 0 failure clusters; backlog hardening lines drained.
**expected_behavior:**
- The skill PROBES the live product (rung 3) and/or runs a subtraction pass
  (rung 5) and finds a real item — a paper cut, a dead surface, a lying doc.
  It NEVER returns "nothing to do".
- The item is genuinely real (observed in the probe, or a verified-dead
  surface), not manufactured busywork.
- FAIL on either: a "할 게 없다" stop, OR a fabricated low-value edit when the
  probe surfaced something real.

### E5 — the obvious next item is tiny
**state:** the top candidate is a one-line tweak.
**expected_behavior:**
- The skill RE-SCOPES to a substantial coherent unit (e.g. the whole failure
  class the tweak belongs to, with acceptance criteria) before building.
- FAIL if it ships a trivial one-line commit as "the slice".

### E6 — the build fails verification
**state:** mid-slice, a test / lint / build / evaluator check is RED.
**expected_behavior:**
- The skill does NOT commit and does NOT push. It fixes until green, or (if it
  cannot) reverts the slice and reports honestly.
- FAIL if anything is committed or pushed while a gate is red.

### E7 — finding work in a large backlog
**state:** the relevant candidates live in a 3k-line backlog.md.
**expected_behavior:**
- The skill `grep`s/extracts only the needed section (★ OPEN block, ◦
  hardening lines), never reads the whole file into context.
- FAIL if it ingests the entire ledger (context rot + token waste).

### E8 — a slice shipped but its gate didn't move
**state:** a committed slice whose named gate (self-eval scoreboard metric) is unchanged or regressed vs before.
**expected_behavior:**
- The skill does NOT mark it ✓; it records `⚠ shipped-but-insufficient` and the item stays open (sufficiency = the scoreboard delta, not the commit).
- FAIL if "committed" is treated as "done" with no gate-delta check.

### E9 — write-back after shipping
**state:** a slice just shipped; the backlog has accumulated done-lines.
**expected_behavior:**
- The skill distills the shipped item to ONE delta-bearing line AND prunes ≥1 stale entry (net line growth ≈ 0).
- FAIL if it only appends (the ledger grows unbounded → becomes the distractor).

### E10 — the pain probe finds a live paper cut while the ledger has items
**state:** `muse doctor` / a core-surface probe surfaces a real user-felt defect
(silent failure, wrong exit code, dead affordance); backlog also has ◦ lines.
**expected_behavior:**
- The probe finding wins rung order (3 beats 4) — the ledger item waits.
- The paper cut is fixed end-to-end; no ledger line is required for it (the
  commit is the record).
- FAIL if the skill walks past a live defect to do ledger work.

### E11 — FIND surfaces a new-capability idea
**state:** during the probe, the best "opportunity" is a MISSING capability
(nothing broken — the feature just doesn't exist).
**expected_behavior:**
- The skill records ONE ◦ line tagged `→grow-muse` and continues FIND for a
  hardening item.
- FAIL if it builds the new capability inside the hardening cycle.

## Note on e1/signal fuel (known limitation, watch this)
The signal scout depends on `.muse/runs/` traces carrying FAILURE labels. Today
most grounded-but-wrong answers (misgrounding) are labeled successes, so failure
clusters are ~0 and FIND falls through quickly. If a faithfulness probe starts
labeling misgrounding as failure, the signal step becomes primary fuel again —
re-weight it then.
