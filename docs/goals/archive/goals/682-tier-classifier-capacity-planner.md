# 682 — P10 s2+s3: a deterministic tier classifier (`classifyTier`) routes simple lookups to the fast model and reasoning to the high-capability model (default-heavy so reasoning is never silently downgraded), and a capacity-aware planner (`planTieredRun`) collapses the run to the single heavy model sequentially when the host cannot hold both tiers — failing OPEN to single-heavy if the capacity probe throws

## Why

P10 s1 (goal 681) gave a worker an optional `model` so the orchestrator
can dispatch different workers on different local models. But nothing
*decided* which tier a task belongs to, nor what to do when the host
cannot keep two models resident at once. P10's second bullet (s2+s3):

> A deterministic tier classifier routes simple lookups to the fast
> model and reasoning to the high-capability model, defaulting to heavy
> when unsure (never silently downgrade reasoning), AND a capacity probe
> collapses the run to the single high-capability model (sequential)
> when the host cannot hold both at once (fail-open to single-heavy on
> probe error). Check: labelled tasks route to the expected tier; a
> faked low-capacity host collapses to one model (integration).

This iteration delivers that decision layer as two pure, deterministic
functions in a new `@muse/multi-agent/tiering.ts` — no live LLM, no
provider import (the package stays model-agnostic). It sits between the
eventual surface wiring (s4) and the s1 dispatch primitive: given task
text, decide a tier; given host capacity, decide whether to run both
tiers in parallel or collapse to one.

### Defect class / scope

**New outward capability — continuity slice of the human-added P10
target.** Advancing the oldest open epic's next undone bullet (procedure
step 3). Touches only `@muse/multi-agent`; this is a deliberate
multi-slice epic the human directed, not area churn.

## Slice

- `packages/multi-agent/src/tiering.ts` (new):
  - `ModelTier = "fast" | "heavy"`, `TierModels`, `TieredTask`,
    `TieredAssignment`, `TieredRunPlan`, `PlanTieredRunArgs`.
  - `classifyTier(text)`: lowercases, then **reasoning-first** — any
    `REASONING_SIGNALS` hit (analyze / design / why / compare / strategy
    / … + Korean 왜 / 분석 / 설계 / 비교 / 설명 / 전략) → `heavy`; else any
    `LOOKUP_SIGNALS` hit (what is / define / convert / how many / … +
    무엇 / 정의 / 변환 / 몇) → `fast`; else `heavy`. Reasoning-first means a
    both-signal task ("define a strategy…") stays heavy; default-heavy
    means an unrecognised task is never downgraded to the fast model.
  - `planTieredRun({ tasks, models, canHoldBothTiers })`: awaits the
    capacity probe; on a thrown probe OR `false` it returns every task
    on `models.heavy`, `mode: "sequential"`, `collapsedToHeavy: true`;
    otherwise it assigns each task its `classifyTier` model,
    `mode: "parallel"`, `collapsedToHeavy: false`.
- `packages/multi-agent/src/index.ts`: re-exports the new types +
  `classifyTier` / `planTieredRun`.
- `packages/multi-agent/test/tiering.test.ts` (new): 7 tests —
  classifyTier (fast lookups / heavy reasoning / default-heavy /
  both-signal-stays-heavy, incl. Korean) and planTieredRun
  (parallel-per-tier when both fit / collapse-to-heavy-sequential when
  not / fail-open-to-heavy on probe throw).

## Verify

- `pnpm --filter @muse/multi-agent test`: 60 passed (7 new).
- **Clean-mutation-proven, three ways**:
  - flip `classifyTier`'s default `return "heavy"` → `"fast"`: the
    default-when-unsure test fails (an unrecognised task downgrades).
  - drop the `if (!canHoldBoth) return heavyOnly()` branch: the
    low-capacity-collapse test fails (it stays parallel/mixed).
  - remove the `try/catch` fail-open: the probe-throw test fails (the
    rejection propagates instead of collapsing to heavy).
  Restored; all 60 green.
- `pnpm check`: EXIT=0 — every workspace builds + tests green.
- `pnpm lint`: 0 errors / 0 warnings.
- Byte-hygiene scan on the three touched files: clean.
- `smoke:live` / `smoke:broad` not applicable: this is a pure decision
  module not yet wired to any surface (s4 does that) and imports no
  provider — there is no request/response wire path in this slice. The
  bullet's mandated check is "(integration)", delivered by
  tiering.test.ts.

## Status

P10 s2+s3 delivered. P10 s4+s5 remain: wire the tiering into the
`muse ask` / REPL path (auto, behind a flag) and `muse orchestrate
--tiered`, proven by a `smoke:live` round-trip whose workers ran on two
distinct local Qwen tiers and whose low-capacity path collapsed to one.

| input                                   | tier   |
| --------------------------------------- | ------ |
| "what is the capital of France"         | fast   |
| "convert 5 km to miles" / "몇 시야"       | fast   |
| "analyze the trade-offs…" / "비교해줘"    | heavy  |
| "define a strategy to cut latency"      | heavy (reasoning-first) |
| unrecognised / ""                       | heavy (default) |

| capacity probe        | plan                                    |
| --------------------- | --------------------------------------- |
| holds both tiers      | per-tier models, parallel               |
| cannot hold both      | all heavy, sequential, collapsed        |
| throws                | all heavy, sequential, collapsed (fail-open) |

## Decisions

- **Reasoning-first ordering** — a task carrying both a lookup and a
  reasoning signal must stay heavy; checking reasoning before lookup
  guarantees that without a scoring scheme. The safety direction
  (false-heavy is harmless; false-fast risks downgrading real
  reasoning) is what the bullet demands.
- **Default heavy, not fast** — an unrecognised / signal-less task is
  routed heavy. Fast requires positive lookup evidence. This is the
  literal "never silently downgrade reasoning" requirement.
- **Substring `.includes` matching, not word-boundary** — most signals
  are phrases ("what is", "step by step") and Korean stems agglutinate
  without spaces, so substring is the right primitive (mirrors the
  CJK-substring stance in `index.ts`'s keyword matcher). A false-heavy
  substring hit (e.g. "airplane" → "plan") errs to the safe tier, so it
  needs no extra guarding here.
- **`canHoldBothTiers` is an injected probe `() => boolean | Promise`**
  — keeps `tiering.ts` free of any OS / Ollama coupling; the real probe
  (model residency / VRAM check against the local Ollama) is wired at
  the surface in s4. The collapse + fail-open semantics live here where
  they are deterministically testable.
- **Pure module, not wired into the orchestrator yet** — s2+s3 is the
  decision; s4 connects `planTieredRun` output to the s1
  `AgentWorker.model` dispatch on the actual `muse ask` / orchestrate
  surface. Bundling that wiring here would over-reach the slice.

## Remaining risks

- **The classifier is heuristic, not learned** — a lookup phrased
  unusually ("capital, France?") with no signal routes heavy (slower
  but correct). That is the intended conservative bias; a richer
  classifier is out of scope and would risk false-fast downgrades.
- **Signal lists are English + Korean only** — other languages route
  heavy by default (safe). Extending the lists is a later, additive
  change, not a correctness gap.
- **No surface consumes `planTieredRun` yet** — dormant until s4, by
  design. The deliverable here is the verified decision layer.
