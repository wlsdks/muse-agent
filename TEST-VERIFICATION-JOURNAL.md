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

---

## Finding 002 — prose brackets before a JSON plan silently lose the whole plan

**Severity:** medium-high (silent `PLAN_GENERATION_FAILED`; directly
degrades local-Qwen tool-calling reliability — a first-class concern per
`tool-calling.md`)
**Where:** `packages/agent-core/src/plan-execute.ts` —
`extractJsonArray` / `parsePlan`. No dedicated test file existed; the
only coverage was a few happy-path cases in `agent-runtime.test.ts`.

### How it was observed
While scanning for untrusted-text parsers, `extractJsonArray` anchored
on the *literal* first `[` (`text.indexOf("[")`). The runtime model is
local Qwen, which routinely emits prose before its JSON. Probed five
realistic preambles against the built code:

| model preamble                         | extracted | plan |
|----------------------------------------|-----------|------|
| `here is the plan for steps [1-3]:`    | `[1-3]`   | **null** |
| `I will do [0,5) then:`                | `null`    | **null** |
| `- [x] step one` (markdown checkbox)   | `[x]`     | **null** |
| `Per the docs [2], plan:`              | `[2]`     | **null** |
| `tags: ["a","b"] then <plan>`          | `["a","b"]` | **null** |

Every one of these silently dropped a perfectly valid trailing plan.

### Root cause
Committing to the first `[` is fragile against the exact output the
local planner produces. Markdown task lists, numeric ranges, citations,
and example arrays all put a `[` in the preamble.

### Fix (and two failures that taught the final shape)
1. First attempt — "return the first balanced span that is *valid
   JSON*." Failed two new tests: a markdown `- [ ]` is a valid **empty**
   JSON array and a citation `[2]` is a valid **1-element** array, so
   they still won.
2. Final — `parsePlan` now walks **every** top-level JSON-array
   candidate (`iterateJsonArrayCandidates`) and returns the first
   NON-EMPTY array whose every entry is a valid step; a lone empty array
   is still the valid empty plan, but an empty `[ ]` in prose no longer
   shadows a real plan. `extractJsonArray` keeps the lower-level "first
   valid JSON array" contract.
3. Third failure — an existing test (`args:[]` ⇒ null) regressed because
   the candidate scanner resumed at `start+1` and descended into the
   array's **interior**, picking up the nested `args:[]` as a bogus
   empty-plan candidate. Fixed by resuming past the balanced span
   (`end+1`) so only top-level arrays are candidates.

### Verified
New adversarial suite `plan-extract-prose-brackets.test.ts` (14 cases)
green; full agent-core suite 686 passed (was 672, +14); lint clean.
Irreducible limit pinned by a test: only a *plan-shaped* array appearing
in prose before the real plan can still shadow it.

### Pattern learned
"Parse the first match of a delimiter" is a trap for untrusted LLM text
— the model's natural prose collides with the delimiter. Walk candidates
and let the *consumer's* validity test pick, instead of committing to
the first lexical hit. And every retry/repair scan must advance past
what it already consumed, or it re-mines the interior.

---

## Finding 002b — same bug, second site: followup LLM detector

**Severity:** medium (soft feature — `confidence: "low"`, rule detector is
the gold standard — but a real correctness gap on untrusted model text)
**Where:** `packages/agent-core/src/followup-llm-detector.ts` —
`extractJsonArrayBody`.

Acting on Finding 002's "pattern learned," I checked the sibling parser
and it had the **same** first-`[` anchoring bug — plus a worse one: it
scanned brackets with **no JSON-string awareness**, so a `]` inside a
promise's `originalText` (e.g. `"meet [boss] at 3pm] sharp"`) closed the
array early and dropped every followup. Reproduced via the public API
with a stub `ModelProvider` (4 cases, 3 red).

**Fix:** extracted the robust scanner into a shared
`src/json-array-scan.ts` (`iterateJsonArrayCandidates`,
`extractFirstJsonArray`, string-aware `balancedArrayEnd`) and pointed
BOTH `plan-execute` and the followup detector at it — one correct
implementation instead of two subtly-different fragile ones. The followup
parser now walks candidates and returns the first array yielding ≥1 valid
promise.

**Verified:** agent-core build clean; 690 passed (+4); lint clean.

### Pattern reinforced
A defect found by reasoning about a *class* (not a single line) should
trigger a sweep for siblings. Here the sweep found a second, worse
instance and justified consolidating both onto one tested implementation.
