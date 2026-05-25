# Test-Verification Journal

A separate branch (`worktree-test-verification`) whose sole job is to
hammer the existing Muse codebase with tests, learn from every failure,
and record the *patterns* behind defects — not to ship product features.
Method: observe → reproduce deterministically → root-cause → fix or
document → re-verify.

Baseline: branch cut from committed `main` HEAD `7afb8135` (the active
dev agent's uncommitted WIP on `main` is deliberately excluded — an
unstable mid-flight target is not a verification baseline).

Full-suite baseline (vitest 4.1.6, node 20): ~5688 tests across 26
workspaces, all green on a *clean* (no-`dist`) run.

---

## Finding 001 — vitest 4 silently re-enabled `dist` test collection → flaky double-run

**Severity:** medium-high (flaky CI + stale-code false confidence)
**Where:** every package that `tsc`-compiles test files into `dist/`
(apps/cli is the worst: 81 test files). Surfaced as 4 intermittent
failures in `apps/cli/src/voice-playback.test.ts`.

### How it was observed
Two back-to-back full `pnpm test` runs disagreed: run 1 = 1898 passed,
run 2 = 4 failed | 1894 passed in apps/cli. Same code, different result
⇒ flakiness, not a logic bug.

### Reproduction (deterministic)
- The failing tests always took ~5000 ms → they hit vitest's 5 s
  `testTimeout`, not an assertion failure.
- The failures appeared as BOTH `src/voice-playback.test.ts` and
  `dist/voice-playback.test.js` — the same test running twice.
- `npx vitest list` in apps/cli: **831 collected from `dist/`, 831 from
  `src/`** — every test collected twice.
- Run in isolation (`vitest run src/voice-playback.test.ts`): 12/12
  pass, fast, every time → the flake is contention, not the test logic.

### Root cause
`vitest@4.1.6` ships `defaultExclude = ["**/node_modules/**", "**/.git/**"]`
— the `defaults` chunk contains **zero** occurrences of `dist`. vitest ≤3
excluded `**/dist/**` by default; **vitest 4 dropped it.** This repo:
1. compiles `*.test.ts`/`*.spec.ts` into `dist/` via `tsc` (build
   tsconfig `include: ["src/**/*.ts"]`), and
2. has **no vitest config** in the affected packages.

So after the vitest 4 bump, `vitest run` collects both the `src`
originals and the compiled `dist` copies. apps/cli doubles to 162+ test
files; its two `synthesizeAndPlay` cleanup tests read the **shared real
`os.tmpdir()`** and diff `muse-speak-*` entries — under the doubled
parallel fs load the sync fs work + `readdir(/tmp)` occasionally exceeds
5 s and times out.

### Second-order hazard (proven)
`dist` is **stale**: it contributed 831 tests while current `src` has
1067. Tests were running 1067 current + 831 old compiled cases. Editing
`src` without rebuilding makes the runner execute outdated `dist` copies
→ a fixed bug can still "fail" and a broken `src` can still "pass". This
is a verification-integrity defect, not just wasted time.

### Fix
- `apps/cli/vitest.config.ts` restoring `exclude: ["**/node_modules/**",
  "**/dist/**"]`.
- Defense-in-depth: `voice-playback.test.ts` now redirects `$TMPDIR` to
  a private per-test dir (os.tmpdir() reads it per call), so the
  before/after diff is scoped and `readdir` is tiny — the test can no
  longer be polluted by any concurrent worker, regardless of runner
  config.

### Verified
apps/cli with `dist/` present (previous failure condition): **82 files /
1067 tests, 3 consecutive identical green runs.** Lint clean.

### Pattern learned
A major-version bump of the test runner can silently widen what gets
*collected*. Any monorepo that compiles tests into an output dir and
relies on the runner's default exclude is exposed. Repo-wide guard:
every package that emits compiled tests needs an explicit `dist` exclude
(or must stop emitting test files into the build output).

### Repo-wide scope + stale-dist evidence
Most packages keep tests in a top-level `test/` dir (build tsconfig is
`include: ["src/**/*.ts"]`, so `test/` is never compiled — those run
once). Only `src`-colocated test files get compiled into `dist` and
double-collected. Packages with `src`-colocated tests: agent-core,
autoconfigure, mcp, messaging, model, scheduler, tools (+ apps/cli,
which colocates ALL 81 in `src`). Same `dist`-exclude config added to
all of them.

Test-count drop once the stale `dist` copies stop running (baseline →
fixed, both with `dist` present):

| package      | before | after | stale dupes removed |
|--------------|--------|-------|---------------------|
| apps/cli     | 1898   | 1067  | 831 |
| mcp          | 957    | 792   | 165 |
| tools        | 185    | 123   | 62  |
| model        | 180    | 134   | 46  |
| scheduler    | 99     | 62    | 37  |
| messaging    | 232    | 197   | 35  |
| autoconfigure| 269    | 256   | 13  |
| agent-core   | 692    | 672   | 20  |

The removed counts are **not** a clean 50% of each suite — proof the
`dist` copies were compiled from an *older* `src` with different test
counts. The runner was reporting green on outdated code: a real
verification-integrity defect, repo-wide, masked as "more tests pass."
