# 458 — Direct coverage for the guard-pipeline fail-close / fail-open security contract

## Why

`guard-pipeline.ts` (`@muse/agent-core`) is the runtime's
security keystone — a CLAUDE.md non-negotiable: "Guards are
fail-close. Hooks are fail-open. Security is deterministic code,
never prompt instruction." Its three exported pipelines wrap
every model call:

- `evaluateGuards` — input guards; a guard **exception** or
  `{allowed:false}` decision must throw `GuardBlockedError` and
  short-circuit the run (fail-close);
- `applyResponseFilters` — a filter exception must be swallowed
  and the response left **unchanged** (fail-open);
- `applyOutputGuards` — an exception or `reject` must throw
  `OutputGuardBlockedError` (fail-close); a `modify` must replace
  the output **and chain the modified value into the next guard**.

Goal 407 pinned the individual guard **factories** (a guard
returning `allowed:false`). A grep confirmed the **pipeline
orchestration functions themselves have zero direct tests** —
`evaluateGuards` / `applyResponseFilters` / `applyOutputGuards`
are imported only by `agent-runtime.ts` and exercised solely via
full-runtime integration happy-paths. The single highest-value
invariant — *fail-close on a guard that throws* — was implicit-
only: a refactor that swallowed a guard exception (fail-**open**:
a thrown guard silently lets the run proceed) is a security
catastrophe that **every existing test still passes**. This is
exactly the `.claude/rules/testing.md` "no implicit-only coverage
of a safety mechanism" rule and the 407 / 424 / 430 / 434 / 438
precedent, at the pipeline layer 407 didn't reach. A `test:` —
diversifying the recent fix-streak — on a fresh module
(agent-core's guard-pipeline never directly tested).

## Slice

- `packages/agent-core/test/guard-pipeline.test.ts` (new, 6
  cases, minimal no-op tracer/metrics stubs): `evaluateGuards`
  fail-close on a thrown guard (`GUARD_ERROR`, later guards
  short-circuited) and on `{allowed:false}` (decision code
  propagated, all-allowed → no throw, order preserved);
  `applyResponseFilters` fail-open (a throwing filter leaves the
  response unchanged and the chain continues; non-throwing
  filters chain); `applyOutputGuards` fail-close on throw
  (`OUTPUT_GUARD_ERROR`), `reject` (decision code), `modify`
  (output replaced AND the modified value reaches the next
  guard), `allow` (passthrough).
- No `src` change — the pipeline is already correct; this pins
  the contract so a refactor can't silently weaken it.

## Verify

- New file 6/6 green; full `@muse/agent-core` suite 595 passed
  (49 files, +1 file / +6 it); tsc strict (agent-core) EXIT=0.
- **Mutation-proven teeth on the keystone**: changing
  `evaluateGuards`'s catch from `throw new GuardBlockedError(…,
  "GUARD_ERROR")` to `decision = { allowed: true }` (the exact
  fail-**open** security regression) makes the fail-close test
  fail; `src` then restored byte-identical (`git diff --stat`
  empty), suite back to 595 green.
- `pnpm check` EXIT=0, every workspace green (agent-core 595,
  cli 739, api …) — no regression; `pnpm lint` 0/0;
  `pnpm guard:core` clean; byte-scan clean; `git status` shows
  ONLY the new test file (zero `src` delta).
- Test-only, deterministic (no clock/network/LLM) — not a model
  request/response wire path; `smoke:live` does not apply (per
  `testing.md` / iteration-loop Step 9).

## Status

Done. The runtime's documented security contract — guards
fail-close (even on an exception), response filters fail-open,
output guards fail-close with reject/modify/allow semantics — now
has direct, mutation-proven unit coverage at the pipeline layer.
A refactor that flips `evaluateGuards`/`applyOutputGuards` to
fail-open, or makes `applyResponseFilters` fail-close, or breaks
`modify` chaining, now fails a fast test instead of silently
disarming the runtime's security.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]` and audited; test-coverage hardening of an existing
security mechanism, recorded honestly as a `test(agent-core):`
change with this backlog row — not a false metric (the
407/434/438 precedent).

## Decisions

- New `guard-pipeline.test.ts`, not an extension of
  `guards.test.ts`: the latter is scoped to guard *factories*
  (407); the *pipeline orchestration* is a distinct, previously
  untested unit — keeping them separate makes the security
  contract's coverage legible.
- Mutated the fail-close keystone specifically (not a cosmetic
  branch): a coverage test claimed to protect a security
  invariant must be shown to catch the precise catastrophic
  regression (fail-open) it exists to prevent — "Verified or it
  does not exist."
- Cast-stubbed tracer/metrics to their used surface only: the
  pipeline calls a handful of span/metrics methods; a no-op
  cast is the honest minimal harness (the guards.test.ts
  precedent for stubbing context).
