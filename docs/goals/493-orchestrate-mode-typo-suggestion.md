# 493 — `muse orchestrate run --mode <typo>` offers a "did you mean" suggestion (goal-468/472/486 sibling)

## Why

`muse orchestrate run` accepts `--mode sequential | parallel |
race` and rejects everything else with a flat
`--mode must be 'sequential', 'parallel', or 'race' (got 'X')`
— exit 1, no recovery hint. The codebase otherwise uniformly
offers a `closestCommandName` fuzzy hint at every typo
surface: top-level CLI unknown command (goal 099), chat-REPL
slash (468), persona use (094), feeds remove, tasks complete,
jobs list `--status`, remind cancel, approval approve/deny
(486), and ~15 more. Orchestrate was the inconsistent
dead-end.

`--mode parralel` (a one-character typo of `parallel`) is the
realistic case: the user is mid-flow, fat-fingers the letter,
the CLI errors but doesn't tell them they're one character
away from `parallel`. Same shape as goal 486 (approval typo)
and 468 (slash typo) — established convention, missing one
site.

`commands-orchestrate.ts` had **no direct test file**, so the
validator's exact behaviour was implicit-only — both the
typo case and the no-false-suggestion case (an unrelated
input must NOT get a misleading hint) were untested.

## Slice

- `apps/cli/src/commands-orchestrate.ts` — imports
  `closestCommandName`, hoists the literal mode list into a
  shared `ORCHESTRATE_MODES` constant, and the `--mode`
  validator now appends ` — did you mean 'X'?` when there is
  a close match. With no close match the error is
  byte-identical to the prior message (same exit code, same
  line shape) — zero regression to the existing UX.
- `apps/cli/src/commands-orchestrate.test.ts` — first direct
  test of `commands-orchestrate`: each of the three modes
  accepted via `parseAsync`; `--mode parralel` rejects with
  `did you mean 'parallel'`; `--mode totallydifferent`
  rejects with the original message (no false guess).

## Verify

- New test 3/3 green; full `@muse/cli` suite green (790 passed,
  0 failed); tsc strict (cli) EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the
  validator to the prior single-line throw makes the typo
  test fail with the precise pre-fix symptom (the error
  message no longer matches `/did you mean 'parallel'/`)
  while the accept-three-modes and no-false-guess tests stay
  green; fix restored, suite back to 3 green.
- `pnpm check` EXIT=0, every workspace green — no regression;
  `pnpm lint` 0/0; `pnpm guard:core` clean (no IMMUTABLE-CORE
  touched); byte-scan clean; `git status` shows only the two
  intended files.
- Pure local string logic (`closestCommandName` is a tested
  pure helper) — no LLM / model request-response wire path;
  `smoke:live` does not apply (per `testing.md` /
  iteration-loop Step 9).

## Status

Done. A typo'd `--mode parralel` / `--mode racee` now gets
the codebase-wide "did you mean" recovery instead of a flat
dead-end. The remaining inconsistent error-UX site is closed;
the `closestCommandName` pattern is now applied at every
multi-choice argument surface I could find. First direct
`commands-orchestrate` test coverage.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets
are already `[x]` and audited; an error-UX `fix:` continuing
the codebase-wide actionable-error convention, recorded
honestly with this backlog row — not a false metric.

## Decisions

- Mirrored the goal-486 (approval) inline shape verbatim:
  `closestCommandName(input, candidates)` + hint-only when
  truthy + identical phrasing. The codebase already
  established the wording, and a near-variant after seven
  consistent precedents would be exactly the drift the
  single-pattern rollout exists to prevent.
- Hoisted the mode list into `ORCHESTRATE_MODES` rather than
  duplicating the literal array between the validator and
  the closestCommandName candidates: a future "add a new
  mode" change MUST update both sites; the const guarantees
  it.
- Integration-tested via `program.parseAsync` so the
  assertion covers the WIRED path — call-site forgot-to-
  import / forgot-to-rebuild bugs surface in this test, not
  just at the synthetic helper level.
