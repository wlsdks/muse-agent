# 550 — `proactiveSidecarFile` + `loadJwtRotationStateSync` reject empty `HOME=""` (goal-549 follow-up closing the last two HOME-resolving sites)

## Why

Goal 549's "Remaining risks" flagged two more
`${HOME ?? ""}/.muse/...` template-literal patterns:

```ts
// apps/api/src/tick-daemons.ts:111-112
const proactiveSidecarFile = env.MUSE_PROACTIVE_SIDECAR_FILE?.trim()
  || `${process.env.HOME ?? ""}/.muse/proactive-fired.json`;

// packages/autoconfigure/src/index.ts:825
file = `${env.HOME ?? process.env.HOME ?? ""}/.muse/auth-secrets.json`;
```

Both produce `/.muse/...` at the **filesystem root** when HOME is
unset (`undefined ?? ""` → `""` → `"" + "/.muse/..."` →
`"/.muse/..."`). Two concrete defects:

1. **Proactive sidecar at `/.muse/proactive-fired.json`**: the
   proactive-notice daemon writes the "fired" cursor here so it
   doesn't re-fire a notification. At root, the daemon would
   crash on every write (EACCES for non-root processes), missing
   every proactive surface.
2. **JWT auth secrets at `/.muse/auth-secrets.json`**: the
   autoconfigure JWT secrets loader tries to read the rotation
   state from here. At root, the loader fails silently (its own
   try/catch returns undefined), but the auth subsystem then
   spins up with NO previous-secret grace window — every
   outstanding signed-token grace period is lost.

Same empty-env-shadow defect class as goals 495 / 505 / 532 /
539 / 540 / 547 / 548 / 549. The cross-codebase HOME-resolution
sweep is now genuinely complete after these two fixes.

## Slice

- `apps/api/src/tick-daemons.ts` — added `homedir` import,
  extracted `resolveProactiveSidecarFile(env)` exported helper.
  The helper trims the override, falls through env HOME, falls
  through `homedir()`, throws on all-empty with a message
  pointing at both `MUSE_PROACTIVE_SIDECAR_FILE` and `HOME`.
  Wired into the daemon launcher.
- `packages/autoconfigure/src/index.ts` — replaced the inline
  template-literal with an explicit branch: if the explicit
  override is non-empty use it; otherwise compute env HOME
  (trimmed); if HOME is empty return `undefined` to keep the
  loader's "best-effort" contract (rotation state then comes
  from env-only). Mirrors the existing surrounding try/catch
  that returns undefined on any read failure.
- `apps/api/test/tick-daemons-sidecar.test.ts` — new file, 3
  focused tests covering the override / HOME-fallback /
  whitespace-HOME-fallthrough paths. The whitespace-HOME test
  uses an explicit `path / thrown` split so an AssertionError
  inside the try/catch can't be swallowed (lesson learned
  from goal 547's draft test bug).

## Verify

- New tests 3/3 green; full `@muse/api` suite green (244 passed,
  +3 vs baseline 241, 0 failed); full `@muse/autoconfigure`
  suite green (142 passed, 0 failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting
  `resolveProactiveSidecarFile` to the pre-fix one-liner
  (`process.env.HOME ?? ""` template literal) makes the
  whitespace-HOME test fail with the precise pre-fix symptom —
  `no leading whitespace in resolved path: expected '   /.muse/
  proactive-fired.json' not to match /^\s/u`. Fix restored,
  suite back to all green.
- `pnpm check` EXIT=0, every workspace green; `pnpm lint` 0/0;
  `pnpm guard:core` clean; byte-scan clean; `git status` shows
  only the three intended files.
- Pure path resolvers — no LLM request-response wire path;
  `smoke:live` does not apply (per `testing.md` / iteration-
  loop Step 9). The defended paths are the proactive sidecar
  + JWT secrets file location, not the model loop.

## Status

Done. The cross-codebase HOME-resolution sweep is now complete:
every `process.env.HOME ?? "~"` / `?.trim() ??` / inline-
template-literal site I could find has been swept through goals
495 / 505 / 532 / 539 / 540 / 547 / 548 / 549 / 550. A future
grep for `HOME ?? ` or `HOME?.trim() ??` should return zero
hits in production code.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets
are already `[x]` and audited; an empty-env-shadow `fix:` on
the last two HOME-resolving sites, recorded honestly with this
backlog row — not a false metric.

## Decisions

- Step-8 continuation from goal 549 onto the last two sibling
  sites — productive sweep closure, not same-area churn.
- Different recovery strategies per site:
  - tick-daemons throws (the daemon NEEDS the sidecar file
    to function; failing loud is the right posture).
  - autoconfigure returns undefined (the JWT loader is
    already best-effort — wrapped in try/catch returning
    undefined on every other error path).
  This matches each function's existing failure-mode posture.
- Did NOT extract a cross-package shared `resolveHome()` helper.
  Six sites now use slightly different shapes (some take an
  explicit override, some only env; some throw, some return
  undefined; the proactive-sidecar message is specific to its
  env var name). Each file's helper is 8-12 lines and the
  per-file specialisation is meaningful. A shared helper would
  invite over-abstraction.
- The whitespace-HOME test uses the path / thrown explicit-split
  pattern (not try/catch around expect) — the goal-547 lesson
  about AssertionErrors getting swallowed by try/catch is
  visible in the test structure.
