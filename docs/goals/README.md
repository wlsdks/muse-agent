# Goals

The self-driving backlog for the autonomous iteration loop.

The loop **never stops and never asks a human for work**. Every
iteration it discovers, defines, and ships the next genuinely-
productive piece of forward development, appends what it discovers
to this backlog, and continues — indefinitely. This is a self-
evolving (자가발전) loop: each iteration must leave Muse materially
more capable than the last.

The earlier run (goals 255–372) failed **not** because it self-
generated work — that is the intended engine — but because the
self-generated work was cosmetic janitorial churn (non-finite
guards, control-byte strips, re-sorts, comment sweeps). The fix is
not a stop button and not a human checkpoint. The fix is a
**productivity bar** the loop must clear every iteration, plus a
concrete discovery procedure so the self-generated goal is always
real forward progress.

## What "productive" means (the bar — every iteration must clear it)

An iteration's goal is valid **only** if it is one of:

- **New user-visible capability** — Muse can do something it
  couldn't before.
- **Closing a design-doc gap** — `docs/design/*.md` describes intent
  the code doesn't yet fully deliver; this iteration narrows it.
- **Architecture deepening with stated leverage** — a boundary or
  contract whose change makes ≥2 future goals cheaper. Say which.
- **A dogfood-observed real bug** — you ran Muse, saw it behave
  wrong, and cite the observed failure.

**Banned — never self-generate a goal of this shape** (this is
exactly what 255–372 degenerated into):

- defensive / non-finite guards on already-validated input with no
  observed failure story,
- control-byte / escaping / sanitiser sweeps with no reported
  breakage,
- re-sort / re-format / relative-time niceties,
- comment / provenance / dead-import sweeps,
- tests that only restate a signature or pin already-covered logic,
- pure renames.

If the obvious next step looks like one of these, it does **not**
count as an iteration. Filler is forbidden; stopping is forbidden;
asking a human is forbidden. The only exit from an iteration is
shipped real progress — widen discovery until you find it.

## Self-generation — how the loop finds its next goal

Run this discovery procedure each iteration, in order; take the
**first source that yields a goal clearing the bar**:

1. **Dogfood**: exercise a real Muse surface aligned with the
   mission (`project_muse_identity`). Observe an actual wrong
   behaviour → that bug is the goal.
2. **Design-doc gap**: pick a `docs/design/*.md`, diff its described
   intent against the code, take the largest unbuilt slice.
3. **Mission capability gap**: compare Muse against JARVIS-class
   behaviour the mission demands; the missing capability is the goal.
4. **Architecture leverage**: a deepening that unblocks ≥2 future
   goals — state the leverage explicitly.
5. **Evidence-backed quality/perf**: a *measured* regression or
   hotspot (numbers, not speculation).

Then append it to the table below as the next `NNN`, write
`NNN-slug.md` (`## Why`, `## Scope`/`## Slices`, `## Verify`,
`## Status`), and execute. **Self-expansion of this backlog is the
engine — it is required, not forbidden.** The table grows for as
long as the loop runs; there is no terminal state.

## Forward-progress guard (keeps infinite ≠ churn)

- **No more than 2 consecutive iterations on the same capability
  surface.** The third must move to a different surface or deepen
  architecture.
- Every 3 iterations must include at least one *new user-visible
  capability* or *design-doc-gap closure* — not three architecture
  or three bug-fix iterations in a row.
- If discovery only surfaces banned-shape work, that is the signal
  that the current scope is mined out: **escalate by widening
  scope** (deeper dogfood, a fresh `docs/design/` area, a new
  mission capability). Never emit filler, never stop, never ask.

## Workflow per iteration

1. Read [`.claude/rules/iteration-loop.md`](../../.claude/rules/iteration-loop.md)
   and auto-memory `MEMORY.md`.
2. Run the discovery procedure → a goal that clears the bar.
3. Append it as the next `NNN` here; write its md.
4. Epic? Do the next undone slice only — one slice = one commit.
5. Execute → `pnpm check` → `pnpm lint` (0/0) → `pnpm smoke:broad`
   → `pnpm smoke:live` (when a provider key is set).
6. Commit (Conventional Commits, one goal/slice per commit).
7. Flip `## Status` → `done — <hash>` / `slice N done — <hash>`,
   update the table.
8. Continue to the next iteration. Never halt.

## Epics

A goal may exceed one iteration: mark it `epic`, list ordered
tracer-bullet `## Slices`, ship one slice per commit.

## Backlog

Seeded with three grounded goals; the loop appends `376, 377, …`
itself via discovery.

| #   | Goal                                                                    | Category       | Status         |
| --- | ----------------------------------------------------------------------- | -------------- | -------------- |
| 373 | [Proactive multi-device routing](373-proactive-multi-device-routing.md) | epic / feature | slice 2/3 done |
| 374 | [`muse ask --notes-only`](374-muse-ask-notes-only.md)                   | feature        | open           |
| 375 | [Web UI history panel](375-web-history-panel.md)                        | epic / feature | open           |
| …   | *self-generated via discovery — never ends*                             |                |                |
