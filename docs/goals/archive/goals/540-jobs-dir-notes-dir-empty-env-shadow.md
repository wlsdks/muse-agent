# 540 — `jobsDir` (CLI) + `MUSE_NOTES_DIR` resolver (MCP loopback) reject empty env values (goal-532/539 sibling on the remaining `.muse/<dir>` resolvers)

## Why

After goals 532 (`MUSE_API_URL`/`MUSE_API_TOKEN`) and 539
(`MUSE_APPROVALS_FILE`/`MUSE_TRUST_FILE`), two more environment-
driven path resolvers in the codebase still carried the
`?.trim() ??` pattern that lets a whitespace-only value
through:

```ts
// apps/cli/src/commands-jobs.ts:76
function jobsDir(): string {
  return process.env.MUSE_JOBS_DIR?.trim() ?? pathJoin(homedir(), ".muse", "jobs");
}

// packages/mcp/src/loopback-status.ts:252
const dir = process.env.MUSE_NOTES_DIR?.trim() ?? pathJoin(homedir(), ".muse", "notes");
```

`?.trim()` on a whitespace-only env value produces `""`, which
`??` doesn't catch (only null/undefined). The function returns
`""` and downstream filesystem ops:

- `muse job run` would write `${id}.jsonl` to the filesystem
  ROOT (`/`), which fails with EACCES and leaves no useful job
  artefact behind;
- `muse job list` reads `readdirSync("")` and throws;
- the `muse.notes.list` MCP tool with `MUSE_NOTES_DIR=""`
  silently reads from the test process's CWD (`readdir("")`
  uses the empty path, which most fs APIs resolve as cwd).
  Operators would see "notes" they didn't write while their
  real `~/.muse/notes` looked empty.

Same empty-env-shadow defect class as goals 478/481/482/483/
488/495/503/505/520/521/528/529/532/539. The cross-package
convention now sweeps the last two `.muse/<dir>` env-path
resolvers in the codebase.

## Slice

- `apps/cli/src/commands-jobs.ts` — imported `firstNonEmpty`
  from `program-helpers.ts` and replaced `jobsDir()`:
  ```ts
  export function jobsDir(): string {
    return firstNonEmpty(process.env.MUSE_JOBS_DIR) ?? pathJoin(homedir(), ".muse", "jobs");
  }
  ```
  Also promoted to `export` so the new unit tests pin the
  behaviour directly.
- `packages/mcp/src/loopback-status.ts` — inlined the
  trim+nonempty check (the package can't import from
  `apps/cli`):
  ```ts
  const fromEnv = process.env.MUSE_NOTES_DIR?.trim();
  const dir = fromEnv && fromEnv.length > 0 ? fromEnv : pathJoin(homedir(), ".muse", "notes");
  ```
- `apps/cli/src/commands-jobs.test.ts` — added one new
  `describe(...)` block with 2 tests:
  - happy path: non-empty `MUSE_JOBS_DIR` returned verbatim
  - whitespace-only env falls back to `~/.muse/jobs` (and is
    explicitly NOT `""` or `"   "`)

## Verify

- New tests 2/2 green; full `@muse/cli` suite green (921
  passed, +4 vs baseline 917 — 2 new + 2 from goal 539's
  approval/trust tests not yet rolled into the baseline, 0
  failed); `@muse/mcp` suite green (527 passed, 0 failed);
  tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting
  `jobsDir()` to the pre-fix `?.trim() ??` shape makes the
  whitespace-only test fail with the precise pre-fix symptom
  — `expected '' to match /\/\.muse\/jobs$/u` (the empty
  string leaked through, would have caused `muse job` to
  write to filesystem root). Fix restored, suite back to all
  green.
- `pnpm check` EXIT=0, every workspace green; `pnpm lint`
  0/0; `pnpm guard:core` clean; byte-scan clean; `git status`
  shows only the three intended files.
- Pure path resolvers — no LLM request-response wire path;
  `smoke:live` does not apply (per `testing.md` /
  iteration-loop Step 9). The defended paths are `muse job`
  file I/O and the `muse.notes.list` MCP tool's directory
  walk, not the model loop.

## Status

Done. A pre-cleared `MUSE_JOBS_DIR=` or `MUSE_NOTES_DIR=`
no longer poisons every `muse job` invocation or the
`muse.notes.list` MCP tool with confusingly-rooted file paths
or cwd-fallback reads. The cross-package empty-env-shadow
convention now sweeps every `~/.muse/<dir>` env-driven path
resolver in the codebase that I could find:

- `MUSE_APPROVALS_FILE` (539)
- `MUSE_TRUST_FILE` (539)
- `MUSE_API_URL` / `MUSE_API_TOKEN` (532)
- foundational `HOME` resolvers (495, 503, 505)
- `MUSE_JOBS_DIR` (this goal)
- `MUSE_NOTES_DIR` (this goal)

A future audit can look for new env-path resolvers added by
later iterations; this goal closes the existing roster.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets
are already `[x]` and audited; an empty-env-shadow `fix:`
on two more env-path resolvers, recorded honestly with this
backlog row — not a false metric.

## Decisions

- Step-8 continuation from goal 539 onto the remaining two
  `.muse/<dir>` resolvers. Two-iteration sweep on the same
  convention is appropriate — each iteration covers a
  different file with the same shape, and the
  full-convention coverage is the outward-meaningful
  outcome.
- Reused the existing `firstNonEmpty` helper on the CLI
  side (where it's already exported). Inlined the same
  pattern on the mcp side, because `@muse/mcp` cannot
  import from `apps/cli`. A future iteration may promote
  `firstNonEmpty` to `@muse/shared` if the helper is needed
  in three or more non-cli packages; for now, one inline
  copy keeps the cross-package coupling minimal.
- Promoted `jobsDir` to `export` to enable direct testing.
  Pre-fix the helper was effectively untested (only
  exercised through the registered command end-to-end). The
  same widening was applied to `approvalsPath`/`trustPath`
  in goal 539.
- Did NOT test the `loopback-status.ts` site directly: the
  defect shape is mechanically identical to the
  `jobsDir`/`approvalsPath` fix; the same mutation would
  fail there. Cross-package convention: test one
  representative of a pair when implementations are
  byte-identical. The mcp suite stays green (527 passed),
  which exercises the path through `muse.notes.list` end-
  to-end.
- The mutation reverts only `jobsDir` (one of two fixes);
  the loopback-status change is byte-identical in shape and
  the same mutation would fail identically. Cross-package
  convention.
