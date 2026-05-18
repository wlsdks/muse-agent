# Iteration-loop steering — the authoritative per-iteration contract

A fresh, context-free agent fires every ~20 min, reads this file +
`docs/goals/README.md` + `MEMORY.md`, ships exactly one commit, and
the loop repeats **forever**. No stop, no halt, no "ask a human",
no completion. Infinite operation is the invariant; everything
below is about *direction and honesty*, never about stopping.

The prior 39h run collapsed into janitorial busywork because the
judge, the worker, and the rule-author were one context-free agent
with a green-by-construction scoreboard. These rules deliberately
move judgment **out of the agent's discretion**.

## Invariants the loop CANNOT touch (P1 — immutable to the loop)

In an autonomous iteration the loop MUST NOT, as its goal, edit:
this file, `docs/goals/README.md` (except: append ≤1 backlog row,
flip status of goals it touched), the outward definition, the
banned-shapes list, `docs/goals/CAPABILITIES.md` rules, the
`MEMORY.md` family, or delete/relax any goal `.md` it did not
author this iteration. **Changing the contract is a human-only
action.** A goal whose subject is the loop's own steering,
backlog format, dashboard, or memory is inward churn — banned. If
the contract seems wrong, ship an outward goal anyway and leave one
line in that goal's `## Status`; never rewrite the rules to make
your own work pass.

## What "outward" means — one falsifiable test (P2)

Every goal's `## Why` must answer, concretely:
> "After this ships, name the new thing **Muse can perceive or do
> in the USER'S world** that it could not before, and the exact
> command/surface the user runs to exercise it."

If the only beneficiary is the loop, the developer, the dashboard,
or Muse's own internals → inward churn, banned, regardless of which
axis (Reach / Anticipation / Autonomy / Presence) is claimed.
"The user can watch the loop" is NOT Presence. A banned shape
(control-byte/escaping, defensive guard, re-sort, rename,
signature-only test) stays banned even inside an outward-labelled
epic — the slice must deliver the capability itself, not its
plumbing.

## Banned as a standalone goal (P-research #3 — deterministic)

Cosmetic guards, non-finite/defensive guards on already-validated
input with no observed failure, re-sort/re-format, comment /
dead-import / provenance sweeps, pure renames, tests that only
restate a signature or pin already-covered logic, lint-only. These
may only ride *inside* a capability goal, never be the deliverable.

## The per-iteration procedure (run in this order, every fire)

1. **Health check first (P-research #9).** `git status` must be
   clean and synced. If dirty/conflicted from an interrupted iter:
   the iteration's ONLY job is to restore a clean, synced tree —
   that counts as the iteration. Then run `pnpm check` +
   `pnpm smoke:broad`; if anything is red, repairing it is this
   iteration's goal (a real regression is outward-eligible).
2. **Stagnation scan (P-research #7).** `git log --oneline -8`.
   If ≥3 of the last commits are janitorial/banned-shape, or the
   same file/area churned repeatedly, or recent diffs are net-
   trivial → this iteration is REQUIRED to pick a goal in a
   different, outward category. Detection forces redirect, never a
   halt.
3. **Continuity before novelty (P5).** Read every open goal's
   `## Status` + `## Decisions` and the `## Rejected` ledger in
   `docs/goals/README.md`. **You MUST advance the oldest open
   epic's next undone slice before self-generating any new goal.**
   A new `NNN` is allowed only when no open epic has an undone
   slice.
4. **Goal selection (P-research #1, #2, #12).** The goal must sit
   at the *capability frontier* — non-trivial (state why) yet
   finishable as one real commit. It must be behaviourally distinct
   from the last 8 shipped goals along a *named* axis, and target a
   capability axis under-represented in the trailing window (spread
   across integrations / surfaces / providers / reasoning, not the
   same axis twice).
5. **Verification function up front (P-research #5).** The goal is
   not real until you can state: (a) an executable acceptance check,
   (b) the failing case it closes, (c) that the check fails before
   and passes after. No executable check ⇒ reject and regenerate.
6. **Implement, then adversarial self-critique (P-research #6).**
   After implementing, switch role: as a hostile reviewer whose
   only job is to prove "this iteration is busywork / fake
   progress / a banned shape in disguise", attack your own diff.
   If the attack lands, revise or regenerate before committing.
7. **Verify for real (P0, P-research #10).** `pnpm check` +
   `pnpm lint` (0/0) + `pnpm smoke:broad`. For ANY change on the
   request/response path, `pnpm smoke:live` MUST actually execute a
   round-trip. **`smoke:live` uses the loop PC's LOCAL OLLAMA QWEN
   ONLY — never a cloud API (GEMINI/ANTHROPIC/OPENAI); do not set
   or expect cloud keys.** "smoke:live auto-skips" is a banned
   justification, same tier as a skipped test. If it skips because
   local Ollama isn't reachable, making it run (start Ollama/Qwen,
   fix the picker) is itself the priority outward goal — Autonomy:
   the loop can verify itself.
8. **Capability ledger (P6 — the success metric).** Every shipped
   outward goal MUST append one line to `docs/goals/CAPABILITIES.md`
   naming a real user-exercisable capability + the exact
   command/surface + the executable check that proves it. If you
   cannot add such a line backed by a check, the iteration did NOT
   clear the bar — it is filler; widen scope. **If the count of
   executable capability checks has not strictly increased across
   the last 5 iterations, the next iteration's sole mandate is to
   add one real capability with its check** — flat capability over
   5 iters IS the degeneration signal; act on it, never stop.
9. **Commit.** One Conventional Commit, subject the dashboard can
   show verbatim. Append outcome to the goal's `## Status` +
   `## Decisions` (one line per non-obvious choice + why). If a
   discovery path was evaluated and deferred, add a `## Rejected`
   ledger line in `docs/goals/README.md` (area, iter, why) so a
   future fresh agent doesn't re-mine it.
10. **Continue.** The loop never stops. Backlog table edits are
    append/flip-only: never reorder, never delete an open goal's
    row, never rewrite another goal's status (P4 — minimises the
    merge surface on the shared remote).

## Guaranteed non-stall fallback (P7)

"Nothing permissible" is impossible by construction. If step 4
yields no outward goal finishable in one commit, the mandated work
is: **decompose the largest unbuilt `docs/design/*.md` gap (10+
docs, inexhaustible) into one more tracer-bullet vertical slice and
ship that slice's smallest end-to-end-real increment** — a working
vertical slice, never a stub/guard/test-only. A void iteration (no
functional diff) is a failed iteration: record why in the next
goal's `## Status` so the human can see a stall the loop couldn't
resolve — while still shipping the design-doc slice.

## Dashboard is infrastructure, not iteration work (P3)

The dashboard renders from git live; it needs no per-commit edit.
The loop NEVER commits a README LIVE_URL change, tunnel restart, or
dashboard tweak as shipped work — those don't clear the bar. Goal
376 is human-operated infra and must not reappear as self-generated
work.

## After-correction protocol

Only a human-directed change tightens this file. If the loop is
seen degenerating again, the human adds one concrete prohibition
here; the loop itself never edits it.
