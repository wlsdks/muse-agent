# 488 — `activityPath` no longer resolves to `""` when `MUSE_ACTIVITY_FILE=` is empty (goal-478/481/482/483 residual sibling)

## Why

The goal-478/481/482/483 empty-env-shadow class fixed four
surfaces in a tight run; iterations 484-487 covered distinct
defect classes per Step-8 redirect. The class has a residual
unfixed sibling on a real user-facing surface:

`activityPath()` (`apps/cli/src/commands-routine.ts:44`)
returned `process.env.MUSE_ACTIVITY_FILE?.trim() ?? <default>`.
Optional-chain-`.trim()` flips `undefined` → `undefined`
(falls back to default — correct) and any non-empty value →
itself trimmed (correct). But an **empty / whitespace-only**
env value flows through as `""`:

- `""?.trim()` → `""`
- `"" ?? default` → `""` (empty is not nullish)
- `activityPath()` returns `""`

Then `readActivity("")` (line 51) is a relative path
(resolves against CWD). It either reads a stray CWD-rooted
`activity.jsonl` file (silently corrupting the rhythm summary
with whatever happens to be there) or returns `[]` for
ENOENT — and `muse routine` reports "no sessions" for a user
whose `~/.muse/activity.jsonl` exists. Reachable via the same
"shell that pre-clears env" launcher pattern goals 478/481/482/
483 already documented.

Same defect class, byte-identical fix shape.

## Slice

- `apps/cli/src/commands-routine.ts` — `activityPath` now
  reads the trimmed env value into a local, returns the
  non-empty trimmed path or the `~/.muse/activity.jsonl`
  default. Same semantic as `resolveDefaultUserKey` (482),
  `resolveMuseEnvPath` (483), and the `createOllamaEmbedder`
  fix (481). Behaviour byte-identical for every previously
  non-empty trimmed env value; only the empty-shadow path is
  closed.
- `apps/cli/src/commands-routine.test.ts` — extended (the
  existing 4 `computeRoutine` tests untouched) with an
  `activityPath` describe: `MUSE_ACTIVITY_FILE=""` and
  `"   "` both fall back to the home-rooted default (regex
  pinned to `\.muse[/\\]activity\.jsonl$`); a non-empty
  trimmed path is returned (with surrounding whitespace
  trimmed).

## Verify

- Extended test 6/6 green; the existing `computeRoutine`
  tests still green (no wrong premise); full `@muse/cli`
  suite green (787 passed, 0 failed); tsc strict (cli) EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting to the
  original `?.trim() ?? default` chain makes the
  empty-env test fail with the precise pre-fix symptom
  (`expected '' to match /…activity\.jsonl$/` — the empty
  string flowed through as the path) while every other test
  stays green; fix restored, suite back to 6 green.
- `pnpm check` EXIT=0, every workspace green — no regression;
  `pnpm lint` 0/0; `pnpm guard:core` clean (no IMMUTABLE-CORE
  touched); byte-scan clean; `git status` shows only the two
  intended files.
- Pure path-resolution logic — no LLM / model
  request-response wire path; `smoke:live` does not apply
  (per `testing.md` / iteration-loop Step 9).

## Status

Done. A user with `export MUSE_ACTIVITY_FILE=` (the "zero out
leaked env" launcher pattern) no longer has `muse routine`
silently read the wrong file (or report no sessions) — the
default `~/.muse/activity.jsonl` resolves correctly when env
is empty/whitespace-only. The goal-478/481/482/483 class
covers one more sibling surface.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets
are already `[x]` and audited; a correctness `fix:` on a
recurring defect class, recorded honestly with this backlog
row — not a false metric.

## Decisions

- Step-8 redirect from the class held for 4 iterations
  (484–487 across `cli` `routine` arithmetic, `scheduler`
  test, `cli` `approval` typo, `memory` `token-estimator`
  test). The class run is over per the iteration-loop's
  same-area-churn semantics; a residual sibling on a real
  user-facing surface is a legitimate slice this iteration.
- Inline fix mirroring the established empty-as-unset trim +
  length-check convention rather than extracting a shared
  helper for the third sibling-class slot: the codebase
  already has `resolveMuseEnvPath` (483) and
  `resolveDefaultUserKey` (482) — adding a third near-twin
  is the drift those helpers exist to prevent, so the
  one-line inline form is the right shape until a fifth
  call-site appears to justify consolidation.
