# Goals

Prioritized work items for the autonomous iteration loop.

This backlog was **reset on 2026-05-18**. The previous backlog (goals
001–372) drove ~39 hours of uninterrupted loop work that converged
into low-value janitorial micro-fixes — the substantive roadmap was
largely complete, but the loop had no instruction to *stop*, so it
kept minting one safe edge-case goal every ~20 minutes. The full
history is preserved in `git log` and `CHANGELOG.md`. This file and
[`.claude/rules/iteration-loop.md`](../../.claude/rules/iteration-loop.md)
exist to prevent that failure mode from recurring.

## What the loop is for

The loop's job is to **deepen Muse toward its mission** — a
provider-neutral, JARVIS-class AI conductor (see auto-memory
`project_muse_identity.md`). It is *not* to stay busy. A loop that
produces nothing this iteration because no goal clears the bar is
working correctly; a loop that invents a cosmetic goal to avoid
stopping is not.

## The value bar (a goal is eligible only if it clears this)

A goal belongs in the Open table below **only** if it is one of:

- **User-visible capability** — a new thing a Muse operator can do.
- **Architecture deepening** — a real module boundary, contract, or
  testability improvement that makes the next feature cheaper.
- **A genuine robustness gap with a concrete failure story** — not
  "this could theoretically be non-finite" but "X input observably
  breaks Y for a real user."

**Not eligible** (these are what the old backlog degraded into):
cosmetic edge-case hardening with no observed failure, defensive
guards on already-validated inputs, restating-the-obvious tests,
comment sweeps. If that is all that's left, the loop **stops**.

## Workflow

1. Read [`.claude/rules/iteration-loop.md`](../../.claude/rules/iteration-loop.md)
   and auto-memory `MEMORY.md` first.
2. Pick the lowest open `NNN` from the table below whose category is
   the highest-priority among open goals (see priority order).
3. Read its `NNN-slug.md`.
4. If it's an **epic**, do the next undone slice only — one slice =
   one commit. Don't attempt the whole epic in one iteration.
5. Execute → `pnpm check` → `pnpm lint` → `pnpm smoke:broad` →
   `pnpm smoke:live` (when a provider key is set).
6. Commit (one goal/slice per commit, Conventional Commits).
7. Flip the goal's `## Status` to `done — <hash>` (or
   `slice N done — <hash>` for epics) and update the table here.
8. **If no open goal clears the value bar: do not invent one. Halt
   and surface that the backlog is exhausted so a human can set
   strategic direction.** This is the single most important rule.

## Priority order (highest first)

1. `architecture` — deepening that unblocks later features
2. `feature` — user-visible capability
3. `robustness` — only with a concrete failure story
4. *(nothing else is eligible — see the value bar)*

Within the same category, lowest open `NNN` wins.

## Epics

A goal may be larger than one iteration. Mark it `epic` and list
ordered tracer-bullet slices in its md (`## Slices`). Each slice is
independently shippable and verifiable — one commit per slice. This
replaces the old "single-iter only" admission rule, which is what
starved the deep work in the first place.

## Open backlog

Seeded with the genuinely-remaining forward work grounded in the
design docs and the previously-deferred feature set. Humans add
strategic goals here — the loop must not.

| #   | Goal                                                                    | Category       | Status |
| --- | ----------------------------------------------------------------------- | -------------- | ------ |
| 373 | [Proactive multi-device routing](373-proactive-multi-device-routing.md) | epic / feature | slice 1/3 done |
| 374 | [`muse ask --notes-only`](374-muse-ask-notes-only.md)                   | feature        | open   |
| 375 | [Web UI history panel](375-web-history-panel.md)                        | epic / feature | open   |

When all three are `done` and no human has added a strategic goal,
the loop halts per workflow step 8 — that is the expected, correct
terminal state, not a problem to route around.
