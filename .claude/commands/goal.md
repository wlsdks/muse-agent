---
description: Execute a Muse goal from docs/goals/
---

# /goal — execute a Muse goal

Read `docs/goals/README.md` for the prioritized index, then pick + execute
a single goal end-to-end.

## Input parsing

The user invokes as `/goal <arg>` where `<arg>` is one of:
- empty / `next` — pick the lowest `NNN` with status `open` in the README.
- `<NNN>` — execute that specific goal (e.g. `/goal 042` or `/goal 42`).
- `list` — print the open goals to chat without executing anything.
- `<NNN> defer <reason>` — flip the goal to `deferred` with the given
  reason instead of executing.

## Workflow

1. Read `docs/goals/README.md` to confirm the goal exists and is open.
2. Read `docs/goals/NNN-<slug>.md` for **Why / Scope / Verify**.
3. Execute the goal:
   - Survey first if Scope says to.
   - Make the changes.
   - Add narrow tests (per the testing rule).
   - Run gates in order: narrow package test → `pnpm check` → `pnpm lint`
     → `pnpm smoke:broad` (→ `pnpm smoke:live` if GEMINI_API_KEY set).
   - All gates must be green before commit.
4. Mark complete:
   - Update the goal md's `## Status` block: `done — <one-line summary
     of what shipped>`.
   - Flip the corresponding row in `docs/goals/README.md` from `open` to
     `done`.
5. Commit (single Conventional Commit per goal):
   - Title: `<type>(<scope>): <short title> (goal NNN)` or similar.
   - Body explains why + the concrete changes + verification line.
6. Brief summary to the user (1-3 sentences, with commit hash).

## Rules

- **One goal per commit.** Mixed-goal commits are not allowed.
- If a goal turns out to be a bad idea mid-execution: stop, mark
  `deferred` with concrete rationale (what you tried, what cost you
  found, what would change the calculation), commit *only* the
  status-flip + reasoning, and continue.
- Tests are the only form of verification. Add narrow tests; don't
  ship a request/response-touching change without `smoke:live`.
- No push without explicit user approval (CLAUDE.md push policy).
- Honour the existing rules under `.claude/rules/` — they're load-bearing.

## When the user types `/goal` with no arg

Default to `next`. Pick the lowest `NNN` whose status column is `open`
(skip `done`, `partial`, `deferred`) and execute it.

## Style

Update the user briefly when:
- Picking the goal ("Picking 042 — <title>")
- Starting the implementation
- Gates green + about to commit
- Done

Don't narrate every Read / Edit / Bash call. Show the diff via the
commit, not via the chat.
