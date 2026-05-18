# 364 — extractDueHint (watch-folder --as-task due parsing) had zero coverage

## Why

This iteration verify-and-rejected several mature surfaces
(import temp-cleanup is `finally`-guarded; `isSafeMuseEntry`
fully tested at program.test.ts:4491; `uniqueCommandPrefix` /
top-level did-you-mean transitively covered; the watch-folder
de-dupe is sound — in-flight guard + archive +
startup-readdir restart-recovery).

The genuine, non-tautological gap: `extractDueHint`
(`apps/cli/src/commands-watch-folder.ts`) — the pure parser
that pulls a due-date hint from the first 8 lines of a file
dropped into the watched inbox (`due:` / `deadline:` / Korean
`마감:`, `:`/`-` separator) and feeds it to `parseTaskDueAt` on
the `--as-task` path — was **module-private with zero test
references** in a command that has **no test file at all**. A
JARVIS-defining ambient capability (drop a file with
"due: tomorrow" → it becomes a task with that dueAt); a silent
regression here would mis-parse or drop ingested due dates with
nothing to catch it.

## Scope

`apps/cli/src/commands-watch-folder.ts`: `extractDueHint`
exported (one-word change, the established 346/352/354/357
boundary-helper-for-testability pattern; the `fs.watch` loop
itself isn't unit-testable). No behaviour changed.

New `apps/cli/src/commands-watch-folder.test.ts`, 5 cases
pinning the real contract:

- `due:` / `DUE -` / `deadline:` extraction, case-insensitive,
  with indentation + surrounding-whitespace trimming;
- the Korean `마감` keyword;
- **keyword-anchored, not any mid-line "due"**:
  `"the report is due: tomorrow"` → `undefined`, and
  `"Due Date: 2026-01-01"` → `undefined` (only the exact
  keyword + separator, *not* "due date:");
- the **first-8-lines** scan window (line 9 ignored, line 8
  honoured) and first-match-wins;
- empty value (`due:`) / no keyword / empty body → `undefined`.

Every expected value — especially the keyword-anchor and
8-line-window subtleties — was **empirically verified against
the built module before asserting** (the verify-don't-guess
discipline that caught nuances in goals 346/357).

## Verify

- `pnpm --filter @muse/cli test` — 616 pass (+5; new file).
  The existing CLI suites stay green.
- `pnpm check` — every workspace green (apps/cli 621 incl. the
  test/ glob, apps/api 165, all packages). `pnpm lint` —
  exit 0. The goal-227 enforcement test (328) stays green; the
  test file self-scans clean (Korean text is normal printable).
- No real-LLM request/response path touched (deterministic
  string extraction). The deterministic suite, with the
  pre-write empirical verification, is the rigorous
  verification.

## Status

done — the watch-folder due-hint parser now has direct
coverage of its keyword set (incl. Korean `마감`), the
keyword-anchor (rejects "due date:" / mid-line "due"), the
first-8-lines/first-match window, and the empty/no-keyword
fallbacks, closing an implicit-only-coverage gap on the
ambient file-ingestion → task path. No behaviour changed.
