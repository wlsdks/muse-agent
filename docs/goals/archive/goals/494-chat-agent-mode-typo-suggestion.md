# 494 — `muse chat --mode <typo>` offers a "did you mean" suggestion (goal-493 sibling)

## Why

`parseAgentMode` (`apps/cli/src/chat-repl.ts:599`) validates
the `muse chat --mode react | plan_execute` flag — the
toggle between the agent's two reasoning loops (single-tool-
loop ReAct vs. plan-then-execute). Pre-fix it threw
`--mode must be 'react' or 'plan_execute' (got 'X')` with no
recovery hint. Goal 493 closed the identical pattern for
`muse orchestrate run --mode`; this is the direct sibling on
`muse chat`. With ~20 other multi-choice argument surfaces
already offering a `closestCommandName` fuzzy hint, the chat
mode validator was the last one I could find inconsistent.

Typo case: `muse chat --mode reactt` (one extra 't') or
`--mode plan_execut` (one missing 'e'). Pre-fix dead-end;
post-fix the user sees `did you mean 'react'?` /
`did you mean 'plan_execute'?` and recovers.

`parseAgentMode` was exported but had **no direct test
coverage**, so both the accept-modes and the typo cases were
implicit-only.

## Slice

- `apps/cli/src/chat-repl.ts` — imports `closestCommandName`,
  hoists the two modes into a shared `AGENT_MODES` constant,
  and `parseAgentMode` now appends ` — did you mean 'X'?`
  when a close match exists. With no close match the error
  is byte-identical to the prior message (same wording,
  same throw point) — zero regression to the existing UX.
- `apps/cli/src/chat-repl.test.ts` — new file, first direct
  test of `parseAgentMode`: undefined → undefined; the two
  documented modes accepted (case + whitespace insensitive);
  near-miss typos (`reactt`, `plan_execut`) get the
  did-you-mean hint; garbage gets the prior message with no
  false guess.

## Verify

- New test 4/4 green; full `@muse/cli` suite green (794 passed,
  0 failed); tsc strict (cli) EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the
  validator to the prior single-line throw makes the typo
  test fail with the precise pre-fix symptom (the error
  message no longer matches `/did you mean 'react'/`) while
  the accept-modes / no-false-guess tests stay green; fix
  restored, suite back to 4 green.
- `pnpm check` EXIT=0, every workspace green — no regression;
  `pnpm lint` 0/0; `pnpm guard:core` clean (no IMMUTABLE-CORE
  touched); byte-scan clean; `git status` shows only the two
  intended files.
- Pure local string logic — no LLM / model request-response
  wire path; `smoke:live` does not apply (per `testing.md` /
  iteration-loop Step 9).

## Status

Done. A typo'd `muse chat --mode reactt` now gets the
codebase-wide "did you mean" recovery instead of a flat
dead-end. The `closestCommandName` pattern is now applied at
every multi-choice argument surface I could find. First
direct `parseAgentMode` test coverage.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets
are already `[x]` and audited; an error-UX `fix:` continuing
the codebase-wide actionable-error convention, recorded
honestly with this backlog row — not a false metric.

## Decisions

- Mirrored goal 493 (orchestrate --mode) byte-for-byte: same
  `AGENT_MODES` const + same inline shape + same wording.
  The cross-CLI convention must read identically.
- Hoisted `AGENT_MODES` to a const so future modes update
  both the validator branch and the closestCommandName
  candidates atomically — same anti-drift design 493 took.
- Tests are pure (no commander) since `parseAgentMode` is a
  pure exported helper, mirroring the 493 commander
  integration test's intent at the unit level. Smaller test
  surface, equally direct coverage.
