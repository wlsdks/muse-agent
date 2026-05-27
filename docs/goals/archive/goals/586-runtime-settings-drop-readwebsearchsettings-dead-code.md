# 586 — drop the unused `readWebSearchSettings` / `WebSearchRuntimeSettings` / `DEFAULT_WEB_SEARCH` dead-code sibling from `@muse/runtime-settings`; replace its orphaned test with direct coverage of `parseBooleanSetting`

## Why

Goal 585 closed the on-snapshot env-flag spelling defect in
`packages/autoconfigure/src/setup-status.ts:readWebSearchEnvSnapshot`.
Its `## Remaining risks` section noted the parallel-but-unused
sibling `readWebSearchSettings` in
`packages/runtime-settings/src/index.ts:229` that still hardcoded
the literal `enabledRaw === "true"` and `envFlag === "off"`
checks — a known asymmetric path nobody calls.

A repo-wide grep confirmed:

| Symbol                       | Production callers | Test callers                                  |
| ---------------------------- | ------------------ | --------------------------------------------- |
| `readWebSearchSettings`      | none               | the file's own test                           |
| `WebSearchRuntimeSettings`   | none               | (only its own type annotation in the helper)  |
| `DEFAULT_WEB_SEARCH`         | none               | (only used inside `readWebSearchSettings`)    |

The production webSearch read goes through
`runtimeSettings.getBoolean(...)` in
`apps/api/src/server-helpers.ts:137`, which already uses the
rich `parseBooleanValue` parser. So the sibling helper was pure
dead code carrying an inconsistent (and stricter) parser
contract — risk of someone discovering and using it later
and getting silently wrong behavior.

`.claude/rules/code-style.md` is explicit:

> If you are certain that something is unused, you can delete
> it completely.

Plus: while the surviving public helper `parseBooleanSetting`
is exported, it had **no direct test coverage** — the only
exercises were the indirect path through `getBoolean`
(spelling-set coverage) and the dead `readWebSearchSettings`'s
contract test. Removing the dead path leaves the public helper
under-tested unless its own direct test is added.

Step-8 redirect: the prior 7-of-10 commits sat in `apps/cli/*`
on the `--json` envelope sweep; this iteration moves to
`packages/runtime-settings` and the defect class is dead-code
removal + test-coverage strengthening, not another tiebreaker
or envelope-shape change.

## Slice

- `packages/runtime-settings/src/index.ts` — delete
  `readWebSearchSettings` function, `WebSearchRuntimeSettings`
  interface, and the `DEFAULT_WEB_SEARCH` constant. Rewrite the
  comment block above `parseBooleanSetting` to drop the
  goal-marker reference and explain its role (tri-state parser
  shared between the internal `getBoolean` and external
  consumers wiring custom boolean settings).
- `packages/runtime-settings/test/web-search-settings.test.ts`
  → renamed to `parse-boolean-setting.test.ts` with content
  replaced by 4 direct `parseBooleanSetting` tests:
  - unset value returns `undefined`,
  - every standard truthy spelling (true / 1 / yes / on,
    case-insensitive, trimmed) returns `true`,
  - every standard falsy spelling (false / 0 / no / off,
    case-insensitive, trimmed) returns `false`,
  - unrecognised spellings (empty, whitespace, `enabled`,
    `disabled`, `y`, `n`, `xyz`, `truue`, `2`, `-1`) return
    `undefined` so callers can fall back to their own default.

## Verify

- `@muse/runtime-settings` suite green (10 passed — was 7, net
  +3: -3 dead-code tests deleted, +4 direct-helper tests
  added; the runtime-settings `getBoolean` integration tests
  unchanged).
- **Clean-mutation-proven** (Edit-based): replacing
  `parseBooleanValue`'s spelling-set logic with strict
  `=== "true" | "false"` makes 3 tests fail (the new direct
  truthy-spelling test, plus the two long-standing
  `getBoolean` integration tests that exercise `"1"` and
  `"Yes"`). Restored, suite back to all green.
- `pnpm check` EXIT=0 (apps/api 249 passed, apps/cli 1040
  passed, every workspace green); `pnpm lint` 0/0; `pnpm
  guard:core` clean; `git status` shows only the two intended
  files.
- No LLM request-response wire path touched; `smoke:live`
  does not apply (per `testing.md` / iteration-loop Step 9).
  No external API contract changed — the deleted symbols had
  zero production callers.

## Status

Done. The `@muse/runtime-settings` package's web-search-shaped
dead code is gone:

| Symbol                       | Before        | After                                          |
| ---------------------------- | ------------- | ---------------------------------------------- |
| `readWebSearchSettings`      | exported, 0 callers | **deleted**                              |
| `WebSearchRuntimeSettings`   | exported, 0 callers | **deleted**                              |
| `DEFAULT_WEB_SEARCH`         | local, 0 callers    | **deleted**                              |
| `parseBooleanSetting`        | exported, 0 direct tests | exported, 4 direct tests                |

Goal 585's `## Remaining risks` item #1 (the asymmetric
sibling) is now closed. The convention split between the
`autoconfigure` snapshot reader (which got the spelling-symmetry
fix in 585) and the runtime-settings helper (which carried the
literal-only check) no longer exists: the literal-only check is
deleted, not aligned, so it can never drift again.

No CAPABILITIES line / no OUTWARD-TARGETS flip: a
maintainability `refactor:` (dead-code removal + direct-test
addition) on the supporting library, recorded honestly with
this backlog row — not a false metric.

## Decisions

- **Delete over align.** Two options were possible:
  (a) keep `readWebSearchSettings`, swap its literal checks for
  `parseBooleanSetting` so it matches the production path; or
  (b) delete it entirely. Chose (b) per `.claude/rules/code-
  style.md`'s explicit "if unused, delete it completely" rule.
  Aligning a zero-caller helper just preserves an attractive
  nuisance. The production webSearch read goes through
  `RuntimeSettings.getBoolean(...)` which is the supported path
  — anyone wanting webSearch state should use that.
- **Keep `parseBooleanSetting` exported.** Even though no
  external caller is found today, the function is a clean,
  small, stable parser primitive — exactly the kind of helper a
  downstream consumer wiring custom boolean RuntimeSetting
  values would want to share with `getBoolean`. Removing it
  would be a breaking change to the package's stable surface
  for no real maintenance win (its body is 5 lines, all
  defensible). Direct test coverage compensates for the loss
  of indirect exercise from the deleted helper.
- **Test-file rename via `git mv`.** The file was
  `web-search-settings.test.ts` but its content is now
  `parseBooleanSetting` tests — the name would mislead future
  maintainers. `git mv` keeps the rename detectable in `git log
  --follow` for traceability of the file's original purpose.
- **Direct test for `parseBooleanSetting` (4 cases).** Mirrors
  the structure of the goal-585 `MUSE_WEB_SEARCH` tests
  (separate truthy / falsy / unrecognised cases) so a future
  spelling-set change is byte-symmetric across the two
  surfaces. Also pins the tri-state semantics (undefined for
  unset OR unrecognised, distinct from boolean) so a callsite
  expecting that distinction cannot regress silently.
- **Comment cleanup.** The old comment block on
  `parseBooleanSetting` was a goal-marker (`Goal 127 — …`)
  followed by an explanation. Per `.claude/rules/code-
  style.md`'s comment policy, the goal marker is rot —
  history lives in `git blame` / commit messages. Rewrote
  the comment block to describe the contract only (case-
  insensitive trim, full spelling set, undefined for unknown)
  without the marker.
- **Mutation choice.** The classic mutation here is "narrow
  the spelling set" — replace the `Set.has()` checks with
  literal `=== "true" | "false"`. This was chosen because:
  (1) it breaks the new direct test and the long-standing
  `getBoolean` integration tests simultaneously (3 failures),
  (2) it represents the realistic regression — a careful
  developer might "tighten" the parser to literal-only without
  realising every spelling-fallback caller depended on the
  permissive set.

## Remaining risks

- `parseBooleanSetting`'s 4-line public surface is now well-
  defended. If any future iteration discovers an actual
  external consumer should use it (e.g. an env-flag reader in
  another package wants a shared parser), that's a clean
  follow-up: import + use.
- The web-search consumer chain still has the live env-flag
  reader at `packages/autoconfigure/src/setup-status.ts:111`
  (`readWebSearchEnvSnapshot`) and the live store-side reader
  via `runtimeSettings.getBoolean(...)` in
  `apps/api/src/server-helpers.ts:137`. Both use the rich
  parser; the surface is consistent.
