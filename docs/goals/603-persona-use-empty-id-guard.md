# 603 — `muse persona use ""` rejects empty id with a clear message (closes the UX asymmetry with sibling `add` / `remove` empty-id guards)

## Why

The three CLI persona-mutation commands share an `<id>` positional
argument that's the persona name to register / switch to / delete:

| Command                  | Pre-fix on empty id                                           |
| ------------------------ | ------------------------------------------------------------- |
| `muse persona add "" …`  | `"add: <id> must not be empty"` (explicit, clear)            |
| `muse persona remove ""` | `"remove: <id> must not be empty"` (explicit, clear)         |
| `muse persona use ""`    | **`"use: no persona with id ''"`** with did-you-mean candidates (misleading) |

`use` fell through to the generic lookup error path that the
`<typo-id>` case uses, producing the misleading frame "your id is
the empty string — here are the suggestions" along with a
`closestCommandName` lookup against an empty input (which the
length-aware cap correctly rejects, but the wrapping error message
still leads with `no persona with id ''`).

Realistic trigger: a shell `$VAR` that resolved to empty —
`muse persona use "$PERSONA"` where `PERSONA` was unset — hits
this confusing path.

Step-8 redirect: distinct from recent finite-guard (595/596),
file-mode (598/599), timeout-window (600), regex (601),
Invalid-Date (602), boolean-spelling (597), and parity (593/594)
sweeps. Defect class is UX consistency between sibling commands —
narrow, ergonomic, fresh.

## Slice

- `apps/cli/src/commands-persona.ts:registerPersonaCommand` `use`
  action:
  - Added an empty-id guard right after `const trimmed = id.
    trim();`, mirroring the byte-for-byte equivalent in `remove`
    (already at line 134) and `add` (already at line 59-63).
  - Stderr message `"muse persona use: <id> must not be empty"`
    + `process.exitCode = 1` + `return`. Same exit-code contract
    as the sibling commands.
  - Added a short WHY comment explaining the asymmetry being
    closed and the realistic `$VAR`-empty shell-expansion
    scenario.
- `apps/cli/test/program.test.ts`:
  - One new `it(...)` block right after the existing
    `muse persona use <typo-id>` test (which exercises the
    did-you-mean path). Two assertions:
    - `muse persona use ""` → stderr contains
      `"must not be empty"`; does NOT contain the misleading
      `"no persona with id"` lookup-error frame; `process.
      exitCode === 1`.
    - `muse persona use "   "` (whitespace-only) → same — the
      existing `trim()` collapses to "" and the guard fires.

## Verify

- `@muse/cli` suite green (1041 passed, +1 vs baseline 1040, 0
  failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): removing the
  empty-id guard makes the new test fail with the lookup path's
  `"no persona with id ''"` frame surfacing (the `not.toContain
  ("no persona with id")` assertion catches the fall-through).
  Fix restored.
- `pnpm check` EXIT=0 (apps/api 258 passed, apps/cli 1041
  passed, every workspace green); `pnpm lint` 0/0; `pnpm
  guard:core` clean; `git status` shows only the two intended
  files.
- No LLM request-response wire path touched; `smoke:live` does
  not apply (per `testing.md` / iteration-loop Step 9). The
  defended path is a pre-action input validator on the CLI.

## Status

Done. The persona-mutation command family now has consistent
empty-id handling:

| Command                  | Before                                          | After                                                |
| ------------------------ | ----------------------------------------------- | ---------------------------------------------------- |
| `muse persona add "" …`  | `"add: <id> must not be empty"`                | unchanged                                            |
| `muse persona remove ""` | `"remove: <id> must not be empty"`             | unchanged                                            |
| `muse persona use ""`    | `"use: no persona with id ''"` (misleading)   | `"use: <id> must not be empty"` (**fixed**)         |
| `muse persona use "  "` (whitespace) | `"use: no persona with id ''"`     | `"use: <id> must not be empty"` (**fixed**)         |

No CAPABILITIES line / no OUTWARD-TARGETS flip: a UX
consistency `fix:` on the CLI persona surface, recorded honestly
with this backlog row — not a false metric.

## Decisions

- **Mirror the sibling commands byte-for-byte.** The `add` and
  `remove` actions already use the same shape: trim, then
  `if (trimmed.length === 0) { stderr; exitCode = 1; return; }`.
  Re-using the exact pattern means a future maintainer who wants
  to refactor (e.g. extract a shared `requireNonEmptyId`
  helper) can sweep all three in one pass.
- **Did NOT touch `muse persona show --id ""`.** That command's
  empty `--id` falls back to "show the active persona" (since
  `--id` is optional). The semantics are subtler: `--id ""`
  could mean "I didn't actually want the flag" OR "I intended
  to pass an id but my $VAR was empty." Falling back to active
  is defensible, and aligning to the same error path would
  break the legitimate "no `--id` flag" case. Out of scope.
- **Two assertions in the test:** the affirmative `must not be
  empty` check AND the negative `not.toContain("no persona
  with id")` check. The second is load-bearing — without it, a
  future bug that prints BOTH error messages (e.g. due to a
  refactor that doesn't `return` after the empty-id guard)
  would silently slip through.

## Remaining risks

- **`muse persona show --id ""`** is intentionally NOT changed
  here (see Decisions). If a future iteration decides the
  silent-fallback is also confusing, the same empty-id guard
  would apply.
- The shell-expansion `$VAR`-empty case is fully handled, but
  callers piping JSON to the CLI may pass quoted empty strings
  via other paths (e.g. `xargs`). The trim+empty-guard covers
  all of them.
- Other CLI commands that take a single positional id without
  guarding empty: a follow-up audit could sweep across
  `muse trust grant/block/revoke/unblock`, `muse feeds remove`,
  etc. Each one's defensive empty-id check is small, but the
  sweep is its own iteration.
