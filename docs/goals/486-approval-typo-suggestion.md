# 486 — `muse approval approve/deny <id>` offers a "did you mean" suggestion for a typo (goal-468/472 sibling)

## Why

`muse approval approve <id>` and `muse approval deny <id>`
(`apps/cli/src/commands-approval.ts`) terminate the pending-
approval audit trail's decision flow — and 20+ other id-taking
CLI surfaces (`muse feeds remove`, `muse tasks complete`,
`muse jobs cancel`, `muse persona use`, `muse remind cancel`,
`muse trust`, `muse history`, `muse memory`, `muse recall`, …)
all give the user a fuzzy `closestCommandName` "did you mean"
recovery on a typo'd id. **Approval was the inconsistent
dead-end**: a mis-typed id printed
`Request 'req-abc12' not found.` and exited 1, with **no hint
that `req-abc123` was sitting one character away in the
pending list**.

The approve/deny commands are the most action-prone of the
id-takers — they mutate the on-disk approval ledger AND a typo'd
approve grants nothing while a typo'd deny doesn't deny what
was meant. Without a "did you mean" the operator has to
`muse approval list`, eyeball the id, and re-type it — exactly
the friction the `closestCommandName` pattern was built to
eliminate.

`commands-approval.ts` had **no direct test file** so the
typo-recovery contract was implicit-only; the existing approve/
deny actions hit the FS and weren't unit-tested in place.

## Slice

- `apps/cli/src/commands-approval.ts` — import
  `closestCommandName`. Both the `approve` and `deny` actions'
  `if (!target)` branches now compute
  `closestCommandName(id, all.map(e => e.id))` and emit
  `Request '<id>' not found. — did you mean '<suggestion>'?
  (run \`muse approval list\` to see pending ids)` when a
  close match exists. With no close match the output is
  byte-identical to the prior message plus the `(run …)` tail
  — same exit code, same line shape.
- `apps/cli/src/commands-approval.test.ts` — first direct
  test of `commands-approval`: stubs `MUSE_APPROVALS_FILE` /
  `MUSE_TRUST_FILE` to tmp paths and runs the registered
  command via commander. Asserts typo → `did you mean
  '<correct>'` on **both** approve and deny; asserts garbage
  (`totallydifferent`) yields **no false suggestion**.

## Verify

- New test 3/3 green; full `@muse/cli` suite green (787 passed,
  0 failed); tsc strict (cli) EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting just the
  `approve` site to the prior `Request '${id}' not found.\n`
  makes the `approve` test fail with the precise pre-fix
  symptom (`expected 'Request \'req-abc12\' not found.\n' to
  contain 'did you mean \'req-abc123\''`) while the `deny` and
  no-match tests stay green; fix restored, suite back to 3
  green.
- `pnpm check` EXIT=0, every workspace green — no regression;
  `pnpm lint` 0/0; `pnpm guard:core` clean (no IMMUTABLE-CORE
  touched); byte-scan clean; `git status` shows only the two
  intended files.
- Pure local string logic (`closestCommandName` is a pure
  helper) — no LLM / model request-response wire path;
  `smoke:live` does not apply (per `testing.md` /
  iteration-loop Step 9).

## Status

Done. A mis-typed approval id on `approve` / `deny` now gets
the codebase-wide "did you mean" recovery the other 20+
id-taking surfaces already provide. The operator no longer has
to bounce through `muse approval list` to find the typo. First
direct `commands-approval` test coverage.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]` and audited; an error-UX `feat`/`fix:`
consistency rollout closing the last id-taking CLI surface
without typo recovery, recorded honestly with this backlog row
— not a false metric.

## Decisions

- Mirrored `commands-feeds.ts:170-175` and goal 468's inline
  pattern verbatim (`closestCommandName(id, candidates)`,
  hint-only when truthy, single line shape) rather than
  introducing a wrapper helper: the central helper is already
  mutation-proven, and a wrapper for one call site would add
  surface without value.
- Integration-tested via commander (`program.parseAsync`) so
  the assertion covers the **wired** path — call-site forgot-to-
  import / forgot-to-rebuild bugs surface in this test, not
  just a synthetic unit-level call.
- Asserted both approve and deny (not just one) — the central
  helper is shared but the bug class "forgot to apply it at one
  site" is per-site; pinning both sides is the
  structural-regression guard.
