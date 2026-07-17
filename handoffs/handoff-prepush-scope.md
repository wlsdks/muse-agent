# Push-scoped pre-push gate

## Header

- **Task:** prepush-scope
- **Goal:** keep local pushes fail-closed for relevant compile/lint failures without running repo-wide deterministic gates or live-model evaluation for unrelated pushes.
- **Why:** the current hook runs root typecheck, web typecheck, and full-repo lint on every push. A stale install produced misleading browser-test type errors, while docs-only and non-web pushes still pay every gate.
- **Stage:** COMPLETE
- **Worker:** Codex

## Acceptance criteria

- [x] The original browser-test failure is diagnosed separately from hook policy: a frozen install followed by root `typecheck:fast` and web typecheck resolves `vitest-browser-react` and its matcher augmentation.
- [x] The hook computes the union of files in every pushed ref before selecting deterministic gates; direct/manual invocation with no ref input falls back to the full gate.
- [x] Ref input is validated and changed paths are collected NUL-safely across refs with macOS Bash 3.2-compatible deduplication. Malformed/no input, unknown objects, or diff failure selects the full deterministic gate.
- [x] Docs/assets-only pushes are recognized only by an explicit allowlist, acquire the shared push lock, and invoke no pnpm gate. Every unknown/unclassified path selects the full deterministic gate.
- [x] Code/config changes run root `typecheck:fast`; web typecheck runs only for `apps/web`, `packages/shared`, or root dependency/TS config changes.
- [x] ESLint runs only on an array of existing changed lintable files with `--`, not `eslint .`; deleted files, whitespace/leading-dash names, and non-lintable files are handled safely. A classification fallback runs full lint.
- [x] Live-model grounding is no longer a surprise default pre-push cost. It remains path-scoped and runs only with explicit `MUSE_RUN_PREPUSH_GROUNDING=1`; its absence never weakens deterministic compile/lint gates.
- [x] Missing pnpm blocks when a deterministic gate is required, but does not block a docs/assets-only push.
- [x] `MUSE_SKIP_PREPUSH_ALL=1` remains the explicit emergency bypass. `MUSE_SKIP_PREPUSH=1` remains a compatible explicit grounding skip.
- [x] Hook tests cover docs-only, non-web code, web-impact code, changed-file lint arguments, whitespace/option-like names, deletion, multi-ref union, new/force-updated refs, malformed/no input/diff failure fallback, unknown-path full gating, fail-closed compilation, missing pnpm, grounding precedence/opt-in, and emergency bypass.
- [x] Versioned hook is committed, merged to local main, and the installed `core.hooksPath` continues to point at it.

## Verification

- One RED→GREEN tracer at a time in `scripts/githooks-pre-push.test.mjs`.
- `node --test scripts/githooks-pre-push.test.mjs`.
- Reproduce the original gate sequence: `pnpm -s typecheck:fast` then `pnpm --filter @muse/web typecheck`.
- Run a synthetic docs-only hook input and a synthetic web-code hook input through the public hook script.
- Changed-file ESLint and `git diff --check`.
- Independent completion evaluation against this handoff.

## Worker notes

- Reproduced the reported failure in a fresh worktree: before install,
  `vitest-browser-react` could not be resolved. `pnpm install --frozen-lockfile`
  followed by the hook's real root and web typecheck sequence passed, so this
  was stale install state rather than a browser-test source regression.
- Replaced unconditional root + web + full-repo lint with a fail-closed,
  multi-ref scope classifier. Docs/assets-only pushes skip pnpm; known code
  runs root typecheck plus relevant web/changed-file lint; unknown state runs
  the full gate.
- Made the live grounding battery explicit opt-in and kept release pushes
  opted in through the release skill.
- Redirected the shared lock heartbeat's stdio. Without this, subprocess
  callers waited for the background process's first 30-second sleep even
  after the hook itself had exited.
- Verification: pre-push public tests 21/21; push-lock tests 7/7; hook setup
  tests 9/9; `bash -n`; root TS7 graph typecheck; direct web typecheck;
  changed test ESLint with `--no-ignore`; and `git diff --check` all pass.

## Evaluator verdict

- **PLAN PASS.** The corrected criteria preserve fail-closed deterministic safety while limiting cost only when scope is positively known. Docs/assets skipping is allowlist-only; unknown paths, malformed/no ref input, unknown objects, and diff failures all select the full gate. Multi-ref collection is NUL-safe and macOS Bash 3.2-compatible, ESLint receives safe existing-file argv after `--`, pnpm remains mandatory whenever deterministic gates are selected, and grounding requires explicit opt-in while both bypass variables retain their documented scope. The expanded tests cover the compatibility and adversarial boundaries needed for implementation.
- **COMPLETION PASS.** The implementation and focused verification satisfy the classifier, Bash 3.2, ref-edge, lint-argv, grounding, pnpm, and lock contracts. Independent runs passed the public hook suite (21/21), push-lock suite (7/7), `bash -n`, `git diff --check`, root TS7 graph typecheck, and direct web typecheck. No fail-open classifier or ref-edge regression was found. The evaluated commit `647b5322e` is now the clean local `main` HEAD, and `core.hooksPath` points to the versioned `scripts/githooks` directory.
- **Concrete blockers:** none.

## Status log

- 2026-07-17 · Codex · PLAN · acceptance and compatibility contract drafted.
- 2026-07-17 · independent evaluator · PLAN · fail-closed classifier, Git/ref failure fallback, NUL-safe lint arguments, and multi-ref compatibility coverage required; PLAN FAIL.
- 2026-07-17 · Codex · PLAN · added explicit allowlist/default-full classification, fail-closed ref/diff fallback, NUL-safe dedupe and lint argv, multi-ref/new/force/delete compatibility coverage, and grounding precedence.
- 2026-07-17 · independent evaluator · PLAN · all prior fail-closed and compatibility blockers are explicit and testable; PLAN PASS.
- 2026-07-17 · Codex · BUILD · scoped hook, stale-install diagnosis, heartbeat fix, 21 public-hook cases, and operating docs completed; focused verification green.
- 2026-07-17 · independent evaluator · COMPLETION · implementation and focused adversarial verification pass; overall COMPLETION FAIL only because commit/merge integration remains outstanding.
- 2026-07-17 · independent evaluator · COMPLETION · integration confirmed at local main commit `647b5322e`; installed hook path correct; COMPLETION PASS.
