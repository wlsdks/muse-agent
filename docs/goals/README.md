# Goals

The self-driving backlog for the autonomous iteration loop.

The loop **never stops, never asks a human for work, never
completes**. It fires every ~20 min, ships one commit, repeats
forever. Infinite operation is the invariant.

**The authoritative per-iteration contract is
[`.claude/rules/iteration-loop.md`](../../.claude/rules/iteration-loop.md).**
Read it first, every iteration, with `MEMORY.md`. This file is the
backlog + the definitions it references.

## The direction: expand OUTWARD

The 255–372 run collapsed into janitorial busywork because the
work circled Muse's own internals. Self-expansion is the engine;
the missing constraint was **direction**. Every goal must expand
Muse outward — the user's always-on personal AI assistant that
reaches into their real tools and life and acts for them, growing:

- **Reach** — a new external surface Muse can perceive/act through.
- **Anticipation** — surfacing/acting *before* being asked.
- **Autonomy** — completing a real multi-step task with less
  human steering than before.
- **Presence** — reachable/aware across more of the user's day.

### Outward — the one falsifiable test (P2)

Every goal's `## Why` must answer concretely: *"After this ships,
name the new thing **Muse can perceive or do in the USER'S
world** that it could not before, and the exact command/surface
the user runs to exercise it."* If the only beneficiary is the
loop, the developer, the dashboard, or Muse's internals → inward
churn, banned, whatever axis is claimed. "The user can watch the
loop" is NOT Presence.

## Banned as a standalone goal

Cosmetic/defensive guards with no observed failure, re-sort/
re-format, comment/dead-import/provenance sweeps, pure renames,
signature-only or already-covered tests, lint-only. May ride
*inside* a capability goal; never the deliverable. Full procedure,
stagnation redirect, and non-stall fallback are in the contract.

## Steering is immutable to the loop (P1)

The loop must NOT, as a goal, edit the contract, this file's
prose, the banned list, the outward definition,
`CAPABILITIES.md`'s rules, the `MEMORY.md` family, or delete/relax
goals it didn't author this iteration. It may only: append ≤1
backlog row, flip status of goals it touched, append to
`CAPABILITIES.md` and the Rejected ledger. **Contract changes are
human-only.**

## Success metric

[`CAPABILITIES.md`](CAPABILITIES.md) is the only success metric —
an append-only inventory of real user-exercisable capabilities,
each with an executable check. Every shipped outward goal adds one
line. Flat count over 5 iterations = degeneration → next iteration
must add one real capability (the contract enforces this).

## Backlog hygiene (every iteration, append/flip-only)

- Keep only the **5 most recently completed** goal files; on the
  6th completion delete the oldest done one (git keeps history).
- Table = all open goals + last 5 done.
- The table is **append/flip-only**: add ≤1 row, flip status of
  goals you touched; never reorder, never delete an open row,
  never rewrite another goal's status (minimises merge surface on
  the shared remote — P4).
- Finish the oldest open epic's next undone slice before
  self-generating a new goal (P5).

## Rejected ledger (P5 — so fresh agents don't re-mine)

Append one line when a discovery path is evaluated and deferred:
`- <area> — iter <hash> — deferred: <reason>`

(none yet)

## Dashboard = infrastructure, not iteration work (P3)

`scripts/dashboard-server.mjs` is a read-only, 127.0.0.1-only view
rendered live from git — it needs no per-commit edit. The loop
NEVER commits a README LIVE_URL change, tunnel restart, or
dashboard tweak as shipped work. Goal 376 is closed as
human-operated infra and must not reappear as self-generated work.

## Epics

A goal may exceed one iteration: mark it `epic`, list ordered
tracer-bullet `## Slices`, ship one slice per commit, record
non-obvious choices in the goal's `## Decisions`.

## Backlog

| #   | Goal                                                                    | Category       | Status         |
| --- | ----------------------------------------------------------------------- | -------------- | -------------- |
| 373 | [Proactive multi-device routing](373-proactive-multi-device-routing.md) | epic / outward | slice 2/3 done |
| 374 | [`muse ask --notes-only`](374-muse-ask-notes-only.md)                   | outward        | done (pre-built) |
| 375 | [Web UI history panel](375-web-history-panel.md)                        | epic / outward | slice 1/3 done |
| …   | *self-generated outward via discovery — never ends*                     |                |                |

Closed infra (not loop work): 376 progress dashboard + tunnel —
human-operated; see its md.
