# 681 — P10 s1: a worker can run a model distinct from the run default — `AgentWorker.model` is an optional per-worker override the orchestrator applies on dispatch (`withSelectedWorker` replaces `input.model` with the worker's), so in one orchestration run a fast model can take a lookup while a high-capability model takes the reasoning; a worker without an override runs byte-identically on the run default

## Why

A human added **P10 — Tiered local-model orchestration** to
`docs/goals/OUTWARD-TARGETS.md` on 2026-05-22. Its first bullet (s1):

> A worker can run a model distinct from the run default (per-worker
> model / `tier: fast|heavy` on the dispatch path, resolved via
> `~/.muse/models.json`); absent ⇒ today's single-model behaviour
> byte-identical. Check: one orchestration run whose workers
> demonstrably executed on different local models (integration).

The multi-agent engine (`@muse/multi-agent`: sequential / parallel /
race, `MultiAgentOrchestrator`) backs `muse orchestrate run` and
`POST /api/multi-agent/orchestrate`, but **every worker in a run shared
one model** — `AgentRunInput.model` was the single dispatch model and
the orchestrator passed it to every worker verbatim (`withSelectedWorker`
only stamped `selectedAgentId`). A fast model could not take a lookup
while a high-capability model took the reasoning in the same run.

This slice delivers the **dispatch-path mechanism**: a worker may carry
an optional `model`, and the orchestrator dispatches that worker with
`input.model` replaced by it. It is the necessary foundation for the
tier classifier (s2) and the capacity probe (s3); the `models.json`
tier→model resolution and the `muse ask` / `muse orchestrate --tiered`
surface wiring are explicitly later slices.

### Defect class / scope

**New outward capability (highest-priority human-added target).** Not a
guard/refinement — the foundational dispatch primitive for P10. Touches
`@muse/multi-agent` (last touched at 676, a one-line tiebreaker); this
is a genuine P10 feature slice on the human's new target, not churn.

## Slice

- `packages/multi-agent/src/index.ts`:
  - `AgentWorker` interface gains optional `readonly model?: string`
    (WHY comment: per-worker override; absent ⇒ run-default).
  - `RuntimeAgentWorker` constructor gains an optional trailing
    `model?: string` (the production LLM-backed worker carries the
    override the CLI/autoconfigure will set in s4). Backward-compatible
    — no existing callsite passes it.
  - `withSelectedWorker(input, worker)` (was `(input, workerId)`) now
    spreads `...(worker.model ? { model: worker.model } : {})` so a
    worker's declared model replaces `input.model` on dispatch; absent
    leaves `input.model` untouched. All three modes
    (`runSequential` / `runParallel` / `runRace`) dispatch through this
    one helper, so the override covers every mode.
- `packages/multi-agent/test/multi-agent.test.ts`:
  - **One integration test** (P10 s1): a parallel run with three
    workers — `fast`→`ollama/qwen3:1.7b`, `heavy`→`ollama/qwen3:8b`,
    and `plain` (no override) — asserts each result's
    `response.model` equals the worker's declared model, that the two
    tiers are distinct, that `plain` ran on the run-default
    `ollama/qwen3:4b`, and that the overridden model reached the worker
    body (its `output` echoes `input.model`).

## Verify

- `pnpm --filter @muse/multi-agent test`: 53 passed (1 new).
- **Clean-mutation-proven**: removing the
  `...(worker.model ? { model: worker.model } : {})` spread makes the
  new test fail — `fast` runs on the run-default `ollama/qwen3:4b`
  instead of its declared `ollama/qwen3:1.7b`. Restored; all green.
- `pnpm check`: EXIT=0 — every workspace builds + tests green.
- `pnpm lint`: 0 errors / 0 warnings.
- `pnpm smoke:broad`: 51 passed / 0 failed — all
  `POST /api/multi-agent/orchestrate` (sequential / parallel / race /
  stream) endpoints green, confirming the HTTP surface is byte-identical
  when no worker carries an override (today's production path).
- Byte-hygiene scan on both touched files: clean.
- `smoke:live` not required for s1: the override is not wired to any
  user surface yet (s4), so every existing flow is byte-identical (the
  `plain`-worker assertion + green orchestrate smoke prove this). The
  bullet's mandated check is "(integration)", which this delivers; the
  live two-tier round-trip is s4+s5.

## Status

P10 s1 delivered. P10 s2+s3 (deterministic tier classifier + capacity
probe) and s4+s5 (`muse ask` auto + `muse orchestrate --tiered`,
`smoke:live` two-tier round-trip) remain open.

| worker         | declared model     | executed on        |
| -------------- | ------------------ | ------------------ |
| `fast`         | `ollama/qwen3:1.7b`| `ollama/qwen3:1.7b`|
| `heavy`        | `ollama/qwen3:8b`  | `ollama/qwen3:8b`  |
| `plain` (none) | —                  | run-default (`qwen3:4b`) |

## Decisions

- **Override in the shared `withSelectedWorker` helper** — all three
  orchestration modes funnel dispatch through it, so one change covers
  sequential / parallel / race uniformly. No mode-specific code.
- **`SupervisorAgent` deliberately untouched** — it dispatches a single
  best-confidence worker (handoff path), not a multi-worker fan-out, so
  per-run tiering does not apply to it. Keeping it single-model avoids
  scope creep and a behavior change in the handoff path. (A
  single-worker model preference there is a separate concern if ever
  needed.)
- **Model lives on the worker, applied by the orchestrator** — keeps
  `@muse/multi-agent` model-agnostic (it never imports a provider); the
  worker merely declares a string, and the existing provider resolution
  in `agent-core`/`autoconfigure` picks the provider from `input.model`
  as it already does for the run default.
- **`models.json` resolution + CLI wiring deferred to s2+/s4** — s1 is
  the dispatch primitive only. Building tier classification and surface
  wiring in one commit would over-reach the slice and the bullet's
  grouping (`— 680 s1` vs `s2+s3`, `s4+s5`).

## Remaining risks

- **No surface sets `AgentWorker.model` yet** — until s4 wires the CLI /
  `muse ask` to populate it (via `models.json` / a tier classifier), the
  override is dormant in production. That is intentional sequencing, not
  a gap: s1's deliverable is the verified mechanism.
- **The override trusts the worker's model string** — an invalid /
  unresolvable model surfaces as the existing provider-resolution error
  from `agent-core` at run time, identical to passing a bad
  `input.model` today. No new validation layer is added here (it would
  belong with the s2 classifier that produces the strings).
- **Fan-in `response.model` is still the run default** — the aggregate
  orchestration response keeps the run-default model id; each worker's
  own model is visible per-step in `results[].result.response.model`
  (which the test asserts). That is the correct place for it — the
  aggregate did not run on a single model.
