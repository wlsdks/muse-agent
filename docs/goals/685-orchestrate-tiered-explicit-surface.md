# 685 — P10 s4 (orchestrate path): `muse orchestrate --tiered` runs each worker on a fast vs high-capability local model chosen from its role — the server classifies each enabled spec's `description` via `classifyTier` and dispatches it on the resolved tier model (s1 `AgentWorker.model`); absent `--tiered` is byte-identical, and the orchestrate response now surfaces each worker's `model`

## Why

P10 s4+s5 calls for tiering exercised end-to-end on TWO user surfaces:
the `muse ask` path (delivered, goal 683) AND `muse orchestrate
--tiered`. The orchestrate surface was still single-model: the server
built every worker with the run-default model
(`selected.map((spec) => createSpecWorker(spec, runtime))`), so a single
orchestration run could not split a lookup onto a fast model and the
reasoning onto a high-capability one — the whole point of P10.

This iteration wires the explicit orchestrate surface, reusing the
already-shipped tiering primitives: s1 (`AgentWorker.model` dispatch),
s2 (`classifyTier`), and the env tier-model convention from the ask
path. Each worker's tier is classified from its **spec role**
(`description`) — a "look up / fetch" worker → fast, an "analyze /
plan" worker → heavy — so one run spreads across both local tiers with
no new persistence.

### Why not the AgentSpec.tier migration

A persisted per-spec `tier` field (the "ideal" explicit control) would
require a DB migration across `@muse/agent-specs` (schema, kysely
store, migrations, validation) — too large for one tight commit.
Classifying the existing `description` delivers role-based tiering now,
behind the same model-neutral dispatch; an explicit persisted tier is a
future additive refinement.

## Slice

- `apps/api/src/multi-agent-routes.ts`:
  - `OrchestrateBody.tiered?: boolean` + strict boolean parse.
  - Exported `resolveOrchestrateTierModels(defaultModel, env)` —
    `MUSE_FAST_MODEL` / `MUSE_HEAVY_MODEL` (trimmed), each falling back
    to the run-default model.
  - Exported `buildSpecWorkers(specs, runtime, tierModels?)` — when
    `tierModels` is given, each worker's model is
    `classifyTier(spec.description) === "fast" ? fast : heavy`; absent,
    the run-default worker (unchanged).
  - `createSpecWorker` gains an optional `model` (set on the returned
    `AgentWorker` → the orchestrator's `withSelectedWorker` overrides
    `input.model`). Both the POST and SSE-stream handlers compute
    `input` first, then build workers via `buildSpecWorkers` with the
    resolved tier models when `tiered`.
  - The POST response result steps now carry `model` (the model each
    worker actually ran on) so the tiering is observable.
- `apps/cli/src/commands-orchestrate.ts`: `--tiered` flag → `tiered:
  true` in the request body (off by default).
- Tests:
  - `apps/api/test/multi-agent-tiered.test.ts`: `buildSpecWorkers` over
    two specs ("Look up facts" / "Analyze the trade-offs") + an
    echo runtime, run through the real `MultiAgentOrchestrator`
    (parallel) → asserts the two workers executed on two distinct tier
    models; an unrecognised role → heavy; no tier models → run-default.
    Plus `resolveOrchestrateTierModels` env-fallback.
  - `apps/cli/src/commands-orchestrate.test.ts`: `--tiered` sends
    `tiered: true`; omitting it sends no `tiered` field.

## Verify

- `pnpm --filter @muse/api test` + `--filter @muse/cli test`: green
  (new API tiering tests + CLI flag test).
- **Clean-mutation-proven**: making `buildSpecWorkers` ignore
  `tierModels` (always run-default) fails the "two tiers in one run"
  and "unrecognised role → heavy" tests (the analyst runs on the
  default instead of heavy). Restored; all green.
- `pnpm check`: EXIT=0. `pnpm lint`: 0/0.
- `pnpm smoke:broad`: 51 passed / 0 failed — all
  `POST /api/multi-agent/orchestrate` endpoints green, so the response
  `model` field addition + the worker-build refactor are
  surface-safe (absent `--tiered` is byte-identical).
- `pnpm check:capabilities`: ✓ every cited test/script file exists.
- Byte-hygiene scan on the four touched files: clean.
- `smoke:live` NOT run: the live two-tier round-trip needs a running
  server with two enabled specs + real Ollama tiers — that is exactly
  the still-open s5 proof. The diagnostic-provider `smoke:broad` is the
  HTTP gate for this surface; the tiering decision + dispatch are
  proven deterministically by the integration test.

## Status

P10 s4 BOTH surfaces now delivered (ask = 683, orchestrate = this).
The s4+s5 bullet remains `[ ]` pending ONLY the s5 `smoke:live` proof:
two workers running on two distinct real Qwen tiers + the live
low-capacity collapse.

| orchestrate run                              | worker models                          |
| -------------------------------------------- | -------------------------------------- |
| `--tiered`, "Look up …" + "Analyze …" specs  | fast + heavy (two tiers in one run)    |
| `--tiered`, unrecognised role                | heavy (default — no downgrade)         |
| no `--tiered`                                | all run-default (unchanged)            |

## Decisions

- **Classify the spec role (`description`), not the shared message** —
  in orchestration every worker receives the same user message, so the
  message can't differentiate tiers; the worker's role is the natural
  signal, and `classifyTier`'s default-heavy keeps an unrecognised role
  on the capable model.
- **Surface `model` per result step** — a tiered run is only useful if
  the user can see which model handled which worker; the field is
  additive and `smoke:broad` confirms it breaks no existing consumer.
- **Env tier models, mirroring the ask path** — `MUSE_FAST_MODEL` /
  `MUSE_HEAVY_MODEL`, no new persistence, consistent with goal 683.
- **`buildSpecWorkers` exported + tested via the real orchestrator** —
  the dispatch (s1 override) is exercised end-to-end at the orchestrator
  level, not a unit stub.

## Remaining risks

- **Role classification is heuristic** — a spec whose `description`
  lacks a lookup signal routes heavy (safe, possibly slower). Explicit
  per-spec tier (persisted) is the future precise control.
- **No live two-tier orchestrate round-trip yet** — the s5 proof; both
  surfaces are wired, so it is now purely an environment/test-harness
  task (a server with two specs + the two local Qwen models).
- **Capacity collapse (s3 `planTieredRun`) is not yet wired into the
  orchestrate server** — the server assigns tiers but does not yet
  collapse to single-heavy on a low-capacity host; that ties into the
  same s5 live work.
