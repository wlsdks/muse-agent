# 581 — `muse trust grant` / `muse trust block` surface a transition warning when the tool was previously in the opposite list

## Why

Security UX completeness on the per-user tool-trust calibration
surface. The pre-fix flow:

```bash
$ muse trust block shell.exec
Blocked 'shell.exec' for stark (now 3 blocked)

# Later, a different operator runs:
$ muse trust grant shell.exec
Granted 'shell.exec' for stark (now 4 trusted)
```

The second command silently:
1. Removed `shell.exec` from `blockedTools`.
2. Added it to `trustedTools`.

The output line said "now 4 trusted" — a count, not the
transition. The operator had no signal that they just
overrode a security gate someone (themselves, last week)
deliberately set. Same shape for `block` flipping a
trusted tool to blocked.

The `revoke` / `unblock` paths already have typo-detection
(goal 118) for "this tool wasn't in the list". This goal
closes the symmetric gap on the additive paths: surface the
transition when `grant` is doing more than "add to trusted",
or `block` is doing more than "add to blocked".

## Slice

- `apps/cli/src/commands-trust.ts:170-184` — `grant`
  peeks the trust file before the mutate so it knows if
  the tool was already in `blockedTools`. The stdout line
  appends ` (previously BLOCKED — now moved to trusted)`
  when the transition fires; otherwise unchanged.
- `apps/cli/src/commands-trust.ts:217-231` — symmetric
  `block` change. Peeks `trustedTools`, appends
  ` (previously TRUSTED — now moved to blocked)` on
  transition.
- Both blocks reuse the existing `readTrustFile` /
  `entryFor` helpers from the same file (already imported,
  no new dependencies). Matches the goal-118 `revoke` /
  `unblock` shape byte-for-byte.
- `apps/cli/test/program.test.ts` — added one `it(...)`
  immediately after the goal-118 typo-detection test:
  four scenarios — grant of a blocked tool (transition
  surfaces), grant of a fresh tool (no transition),
  block of a trusted tool (transition surfaces), block
  of a fresh tool (no transition).

## Verify

- New `it(...)` green; full `@muse/cli` suite green (1032
  passed, +1 vs baseline 1031, 0 failed); tsc strict
  EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the
  `grant`'s pre-state peek + transition tail to the bare
  pre-fix shape makes the new test fail with
  `expected ... to contain "previously BLOCKED — now
  moved to trusted"` — the silent demotion of the
  security gate is exactly the pre-fix symptom. Fix
  restored, suite back to all green.
- `pnpm check` EXIT=0, every workspace green (apps/api
  249 passed, apps/cli 1032 passed); `pnpm lint` 0/0;
  `pnpm guard:core` clean; byte-scan clean; `git status`
  shows only the three intended files.
- Pure CLI write surface — no LLM request-response wire
  path; `smoke:live` does not apply (per `testing.md` /
  iteration-loop Step 9). The defended path is the
  `muse trust grant` / `block` write surfaces, not the
  model loop.

## Status

Done. Both write paths now make the transition visible:

| Operation | Pre-fix output | Post-fix output (when transitioning) |
| --- | --- | --- |
| `grant` of a blocked tool | `Granted '<t>' for <k> (now N trusted)` | `... (now N trusted) (previously BLOCKED — now moved to trusted)` |
| `block` of a trusted tool | `Blocked '<t>' for <k> (now M blocked)` | `... (now M blocked) (previously TRUSTED — now moved to blocked)` |
| `grant`/`block` of a fresh tool | unchanged (no transition) | unchanged |

A future grep for any other write-surface that silently
moves data between security-relevant lists could surface
more candidates; deferred.

No CAPABILITIES line / no OUTWARD-TARGETS flip: a
security UX completeness `fix:` on the existing trust
surface, recorded honestly with this backlog row — not a
false metric.

## Decisions

- Transition tail uses ALL-CAPS for the previous list
  (`BLOCKED` / `TRUSTED`). Reason: scanability — the
  operator's eye lands on the capital word in a
  concise stdout line. Same shape goal-100's
  did-you-mean uses (lowercase suggestion) but for
  loudness, not for politeness — the use cases are
  different.
- Did NOT add the transition tail when the tool was
  ALREADY in the target list (idempotent re-grant /
  re-block). Reason: that case is genuinely a no-op
  with no security impact; surfacing a transition
  warning would dilute the real warning's signal.
- Did NOT add a `--force` flag or interactive
  confirmation. Reason: this is the CLI for a
  personal JARVIS — the operator IS the user. A
  surfaced warning is the right grain; gating
  behind a confirmation prompt would block
  scripted automation (the typical motivation for
  using `muse trust` at all).
- The peek uses `readTrustFile(trustPath())` + `entryFor`
  — exactly the pattern goals 118 (revoke / unblock
  typo-detection) established. Cross-handler
  convention is uniform.
- Mutation reverts the GRANT branch (one of two
  identical fixes). The BLOCK branch has a byte-
  identical shape and would mutate-fail identically;
  cross-handler convention is to test one
  representative of a symmetric pair.
- The test asserts FOUR scenarios (grant-with-
  transition, grant-without-transition, block-with-
  transition, block-without-transition) so the
  asymmetry is pinned: transition surfaces ONLY when
  there's a real transition, NEVER on additive writes.
- Step-8 sub-defect-class check: security UX
  completeness on a trust-write surface is distinct
  from the recent case-insensitivity (580),
  comparator-determinism (578/579), persona
  ergonomics (577), error-UX (576), did-you-mean
  (575). Fresh defect-class slot.
