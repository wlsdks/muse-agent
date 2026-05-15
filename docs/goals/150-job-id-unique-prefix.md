# 150 — `muse job status` / `muse job tail` accept a unique prefix

## Why

Job ids look like `job_2026-05-15T15-12-30_a1b2c3d4` — a long
date stamp + random 8-char tail. To check on a background job
the user had to copy the full id from `muse job list` (or the
`muse job run` output line above) and paste it back. Git solved
this years ago: `git checkout abc1234` accepts any unique commit
hash prefix. Same pattern fits jobs cleanly.

## Scope

- New `apps/cli/src/job-id-prefix.ts`:
  - `resolveJobIdByPrefix(input, allIds)` → discriminated union
    `{ kind: "exact" | "prefix" | "ambiguous" | "none" }`.
  - Pure helper — no IO, no commander — so it tests directly.
  - Trims input. Exact match wins even when another id would also
    prefix-match (e.g. `foo` vs `foobar`).
- `apps/cli/src/commands-jobs.ts`:
  - `listKnownJobIds()` — `readdir` of `~/.muse/jobs/` minus the
    `.jsonl` suffix.
  - `resolveOrReportJobId(io, input, command)` — central UX. On
    ambiguity prints all candidates + an exit-1 bail; on no-match
    points to `muse job list`.
  - `muse job status <id>` and `muse job tail <id>` both call
    through this helper. Full ids keep working unchanged.

## Test coverage

`apps/cli/src/job-id-prefix.test.ts` covers all four resolution
outcomes (exact, prefix, ambiguous, none) plus the whitespace-
trim and the exact-beats-prefix tie-break.

## Verify

- `pnpm --filter @muse/cli test` — 375 tests pass (6 new).
- `pnpm check` exit 0.
- `pnpm lint` exit 0.
- No real-LLM path touched (`smoke:live` unchanged).

## Status

done — long UUID-tail copy-paste is no longer a tax on
`muse job` ergonomics.
