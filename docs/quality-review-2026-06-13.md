# Muse source-quality review — 2026-06-13

Scope: source-tree structure, module composition, package management, build/test
wiring. Method: codegraph (worktree-local index) + static metrics + knip. Read-only
review — no code changed. Branch `quality-review`, worktree `/tmp/muse-quality-review`.

## Verdict

The macro-architecture is genuinely healthy: a clean layered package DAG with **no
cycles**, **zero external-dependency version drift**, strict TS, and a real
provider-neutral adapter seam. The quality problems are **not** in how packages
relate — they are (a) a build graph that doesn't model its own dependencies, and
(b) core domain logic that has pooled inside the CLI app layer instead of living
behind reusable seams. Both are fixable without re-architecting.

## What's healthy (keep)

- **Layered DAG, no cycles.** `shared`/`model`/`db` are leaves; `agent-core` mid-stack;
  `autoconfigure` is a clean composition root (~19 deps, expected); `api`/`cli` are top
  consumers. Cycle check: none.
- **Zero version drift.** No external dep is pinned to two versions across 30 workspaces.
- **Strict TS base** (`strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`).
- **Modern, consistent toolchain**: pnpm 10.18, TS 6, ESLint 10 (flat), vitest 4, knip 6.
- **Adapter seam honored**: vendor SDKs stay inside `packages/model`; `agent-core` is neutral.
- **Test breadth**: 526 `*.test.ts` files plus the deterministic eval batteries.

## Findings (ranked by leverage)

### 1. [High] Build graph has no TS project references — root cause of "stale dist"
Every package builds with a bare `tsc -p tsconfig.json`; **0 packages** declare
`composite`/`references`, and there is no `tsc -b`. Cross-package correctness relies
entirely on pnpm's `-r --sort` topological order. When an upstream package's `dist/`
is stale, a downstream package type-checks against the old surface — the recurring
"stale dist" failures.
**Fix:** add `composite: true` + `references` to each package tsconfig and build with
`tsc -b`. Incremental, dependency-correct builds; stale-dist class disappears.
Single highest-leverage structural change.

### 2. [High] Grounding/citation logic leaked into the CLI (`commands-ask.ts`)
`apps/cli/src/commands-ask.ts` is **3,912 LOC, 78 exports, 67 top-level functions**.
codegraph shows the helpers (`selectMemoryFacts`, `formatSourceReceipts`,
`rankEpisodeHits`, `selectGroundingActions`, `drawBestGroundedRedraft`, …) are each
called from a **single** internal site — extracted from one mega-function purely to be
unit-testable, all exported, none reused. This is a shallow god-file (interface ≈
implementation) **and** a contract violation: `CLAUDE.md` says server/CLI/future
surfaces share the `agent-core` runtime, yet the grounding presentation+selection
logic — Muse's core edge — is CLI-only and the API cannot reuse it.
**Deepening:** lift selection + citation formatting + receipts + staleness + redraft
into a domain module (in `agent-core`, or a new `grounding` package) behind a small
interface; the CLI command becomes a thin caller. Restores locality, gives the API
leverage, and the unit tests move to the seam where they belong.

### 3. [Medium] CLI app is oversized (48K LOC / 191 files)
Largest single workspace, bigger than any package. Many command files carry domain
logic, not just presentation: `commands-today` 1396, `commands-daemon` 1330,
`commands-doctor` 1235, `commands-notes-rag` 1102, `commands-calendar` 977. Same
pattern as #2 at smaller scale — push business logic down into domain packages, keep
commands thin.

### 4. [Medium] `mcp` package is the largest package (28K LOC / 121 files)
A hub (loopback servers, proactive-notice loop, relative-time). Worth a cohesion pass
to confirm it is one deep thing and not a catch-all. Lower confidence than #1–#3.

### 5. [Low] Inconsistent test placement
526 tests in `test/` dirs vs 88 co-located in `src/`. Two conventions coexist and
`testing.md` doesn't pin one. Pick one, document it in the rule.

### 6. [Low] ~50 unused exported types (knip)
Mostly exported-but-unused interfaces/types across cli/api/web. Make local or delete;
wire `pnpm deadcode` into CI as report-only so it doesn't regrow.

### 7. [Low] No pnpm catalog
Versions are manually consistent today (good — 0 drift) but nothing enforces it.
Adopt `catalog:` in `pnpm-workspace.yaml` to make consistency structural.

### 8. [Low] Four single-file 500+ LOC leaf packages
`cache` (525), `prompts` (601), `resilience` (514), `shared` (240) are one `index.ts`
each. Fine as leaves; only split if they keep growing.

## Suggested order of attack
1. TS project references (#1) — unblocks the recurring build pain, mechanical, high payoff.
2. Extract the grounding/recall presentation seam out of `commands-ask.ts` (#2) — the
   one change that most strengthens the core edge AND the shared-runtime contract.
3. Opportunistic: thin the other large CLI command files (#3) as they're touched.
4. Hygiene: knip cleanup + CI gate (#6), test-placement rule (#5), pnpm catalog (#7).
