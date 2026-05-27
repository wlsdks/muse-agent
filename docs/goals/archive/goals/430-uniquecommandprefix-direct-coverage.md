# 430 — Direct coverage for `uniqueCommandPrefix`

## Why

`uniqueCommandPrefix` (`apps/cli/src/program.ts`) is the prefix→
command resolver in the **unknown-command UX** — the
highest-frequency CLI error moment ("did you mean …?" after a
typo). It was module-private and only covered **implicitly**
through the unknown-command handler tests, while its sibling
resolver `closestCommandName` (same UX, same file-family) is an
explicit export with its own direct unit test. `.claude/rules/
testing.md` requires "direct unit tests for every export of every
helper module — no implicit-only coverage"; goals 407 / 424 set
the precedent of pinning existing correctness-critical helpers
directly (non-speculative regression-prevention, not new
behaviour).

The function's correctness hinges on two easily-regressed edges:
the `< 2`-char guard (a 1-char prefix is too weak to
disambiguate) and the **ambiguous → `undefined`** rule (never
guess when >1 command shares the prefix). A refactor that broke
either — e.g. returning `matches[0]` on an ambiguous prefix —
would silently mis-suggest on every near-miss typo, with nothing
failing.

(Investigation note: this iteration first probed
`proactive-notice-loop` / `briefing-imminent` / persona /
wake-word / api routes and found them all sound and internally
consistent. A suspected `firedKey` space-join collision was
analysed, proven **not reachable** — `startIso` is a fixed
no-space ISO appended last, so `kind␠id␠startIso` is uniquely
decodable — and fully reverted to pristine rather than ship a
banned defensive-guard-without-observed-failure. The honest
outcome of an exhausted bug surface is a sanctioned
coverage-hardening deliverable, not a manufactured fix.)

## Slice

- `apps/cli/src/program.ts` — add `export` to
  `uniqueCommandPrefix` (one keyword; behaviour-neutral),
  mirroring how `closestCommandName` is exported for direct
  testing.
- `apps/cli/test/program.test.ts` — new `describe(
  "uniqueCommandPrefix")`: unambiguous prefix → the single
  command; case-insensitive; ambiguous prefix → `undefined`;
  `< 2`-char / blank guard; no-match → `undefined`; an exact full
  name is still its own unique prefix.

## Verify

- `@muse/cli` `uniqueCommandPrefix` describe 6/6; full
  `@muse/cli` suite green (69 files / 737, +6); tsc strict (cli)
  clean. The existing unknown-command handler tests (which
  exercise it indirectly) still pass — the `export` is
  behaviour-neutral.
- `git status` shows only `program.ts` + its test changed
  (`proactive-notice-loop.ts` confirmed byte-identical to HEAD —
  the reverted false-bug left zero residue).
- `pnpm check` EXIT=0, every workspace green (cli 737, api 195,
  …); `pnpm lint` 0/0; `pnpm guard:core` clean; byte-scan clean.
- Pure deterministic helper verified with fixtures; not a model
  request/response path — no `smoke:live` applies.

## Status

Done. The prefix-resolution helper behind the most common CLI
typo-recovery path now has direct unit coverage of its
disambiguation and length-guard contract, matching the parity
its sibling `closestCommandName` already had. A refactor that
weakens "ambiguous → no guess" now fails a fast test.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]`; test-coverage hardening of an existing helper,
recorded honestly as a `test(cli):` change with this backlog row
— not a false metric. Same discipline as goals 407 / 424.

## Decisions

- Exported the helper for a direct test rather than asserting
  only through the handler: the codebase already does exactly
  this for `closestCommandName` and for the `program.ts`
  persona/history re-exports — parity, not a new pattern.
- Did NOT ship the `firedKey` change: re-analysis proved the
  collision unreachable, so it would have been
  defensive-hardening-without-observed-failure (loop-banned). It
  was reverted to byte-identical pristine and explicitly recorded
  here so the near-miss is visible, not hidden.
