# 569 — chat-REPL `/forget --All` / `/forget ALL` wipe sentinel is case-insensitive (goal-568 sibling closing the last slash-handler outlier)

## Why

Direct goal-568 follow-up. Goal 568 normalized the
case-sensitive enum sentinels in `/tools` and `/persona`,
and the "Status" section claimed "A future grep for
`arg === "[a-z]+"` inside the slash dispatcher should
return zero hits". A fresh grep showed one outlier the
literal-letters regex didn't catch (it has a `--` prefix):

```ts
// /forget — line 280, pre-fix
if (arg === "--all" || arg === "all") {
  // wipe ALL the user's memory for the active persona
}
```

`/forget --All` or `/forget ALL` slips past the
case-sensitive equality and falls through to the per-key
delete path. The handler then reports `(key '--All' not in
memory)` — exactly the goal-568 trap on the third remaining
slash sentinel.

This iteration closes the convention sweep so every
sentinel match in the slash dispatcher is case-insensitive.

## Slice

- `apps/cli/src/chat-repl-slash.ts:280` — extracted the
  arg into a `sentinel` local via `arg.trim().toLowerCase()`
  and reused it for both equality checks. The non-sentinel
  passthrough at line 286 still uses the original `arg` so
  a real memory key keeps the user's casing.
- `apps/cli/src/chat-repl-slash.test.ts` — added a new
  `describe(...)` block with 4 `it`s:
  - `/forget --All` triggers the wipe (mixed-case dash form)
  - `/forget ALL` triggers the wipe (no dashes, all-caps)
  - `/forget '  --all  '` trims surrounding whitespace
  - `/forget some-key` does NOT trigger the wipe (real-key
    inputs preserve the per-key delete path)
- The test file's `deps` typing was widened from
  `satisfies SlashDeps` to `: SlashDeps`. The `satisfies`
  operator narrowed `memoryStore` to the literal
  `undefined`, blocking the new test's `memoryHarness`
  from supplying a fake store. Pure test-infrastructure
  widening; no behaviour impact on the existing tests.

## Verify

- New `it(...)` blocks green; full `@muse/cli` suite green
  (1027 passed, +4 vs baseline 1023 reported earlier in
  the iteration, 0 failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the
  `sentinel = arg.trim().toLowerCase()` line back to the
  pre-fix bare `arg === "--all" || arg === "all"` causes 3
  of the 4 new tests to fail simultaneously (`--All`,
  `ALL`, `  --all  ` no longer trigger the wipe path; the
  fourth `some-key` test passes either way as the
  negative). Fix restored, suite back to all green.
- `pnpm check` EXIT=0, every workspace green (apps/api 244
  passed, apps/cli 1027 passed); `pnpm lint` 0/0; `pnpm
  guard:core` clean; byte-scan clean; `git status` shows
  only the three intended files.
- Pure REPL dispatcher — no LLM request-response wire
  path; `smoke:live` does not apply (per `testing.md` /
  iteration-loop Step 9). The defended path is the chat
  REPL `/forget` slash handler, not the model loop.

## Status

Done. A fresh grep for case-sensitive sentinel equality
inside `chat-repl-slash.ts` returns ONLY non-sentinel
literal matches (`cmd ?? ""`, model-name passthrough,
etc.). Every enum-arg comparison in the slash dispatcher
now normalizes via `.trim().toLowerCase()` before
matching — convention complete.

No CAPABILITIES line / no OUTWARD-TARGETS flip: a direct
goal-568 sibling closing the last case-sensitive sentinel
in the slash dispatcher, recorded honestly with this
backlog row — not a false metric.

## Decisions

- Same byte-for-byte normalisation shape goal 568 used
  (`const sentinel = arg.trim().toLowerCase()`).
  Cross-handler convention is now uniform.
- The per-key delete path at line 287 still uses the
  original `arg` (not `sentinel`). Reason: memory key
  names are user-defined and case-significant (`name`
  and `Name` are different facts in the user-memory
  store). Only the meta-sentinel needs the normalisation.
- Added a negative assertion (`/forget some-key` → no
  wipe) to pin the asymmetry: case-insensitivity applies
  ONLY to the meta-sentinel, NOT to real keys. A future
  regression that over-lowercased the key path would
  break this assertion.
- The test harness widening (`satisfies SlashDeps` →
  `: SlashDeps`) mirrors goal 568's harness fix for
  `ctx`. Both pieces of state (`ctx` and `deps`) now
  use the wider interface type so mutation tests can
  supply non-default values.
- Step-8 sub-defect-class check: this is the third
  case-sensitive-sentinel fix in two iterations (568:
  `/tools` + `/persona`; 569: `/forget`). The convention
  is now fully uniform across the slash dispatcher. Goal
  570 must redirect to a fresh defect class.
