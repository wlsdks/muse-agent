# 680 — Model-tier-aware sub-agent orchestration (fast lookup · heavy reasoning · capacity-aware)

Category: epic / outward (proposed P10)

## Why

Falsifiable-outward: **Muse routes a simple lookup to a fast local
model and a reasoning step to a high-capability local model within
ONE orchestration run — automatically in the normal ask/REPL path
and explicitly via `muse orchestrate`, degrading to a single
high-capability model when the host cannot hold both at once.**
Exercised by an orchestration whose workers demonstrably run on
different Ollama models (and a forced low-capacity host that
collapses to one), proven by a `smoke:live` round-trip.

What ALREADY exists (do NOT rebuild — audited in code 2026-05-22):

- The orchestration engine: `@muse/multi-agent` —
  `OrchestrationMode = "sequential" | "parallel" | "race"`,
  `SupervisorAgent`, `AgentMessageBus`, orchestration history.
- LLM-backed workers: `RuntimeAgentWorker` /
  `createSpecWorker(spec, runtime)` in `apps/api/multi-agent-routes.ts`.
- User surfaces: `muse orchestrate run|list|get` (CLI) and
  `POST /api/multi-agent/orchestrate`.
- Diagnostic coverage: `smoke:broad` exercises the endpoint,
  including `parallel mode runs all workers concurrently`.

The genuine gap (precise, code-verified):

1. **No per-worker model.** `AgentSpec` carries `mode`, `toolNames`,
   `keywords` — but **no `model` field**. The orchestration takes a
   single run-level `model` (`input.model ?? options.defaultModel`)
   that ALL workers share. There is no way to say "this worker runs
   the fast model, that one runs the heavy model." Model-tiering is
   structurally impossible today.
2. **No tier classifier.** Nothing decides "simple lookup → fast"
   vs "reasoning → heavy."
3. **No capacity arbitration.** Loading two Ollama models at once
   needs combined VRAM/RAM; if the host can't, concurrent loads
   thrash (eviction) and are slower than one. There is no probe /
   fallback to a single high-capability model.
4. **Explicit-only.** `muse orchestrate` is a manual command; the
   default `muse ask` / REPL path never auto-fans-out or tiers.
5. **Never live-verified.** Only `smoke:broad` (diagnostic
   provider, no real model). No `smoke:live` round-trip proves
   tiered orchestration on real local models.

Single-user / local-Ollama is the design point (per identity
memory): no multi-tenant scheduler — capacity arbitration is about
ONE machine's model residency, not fair-sharing.

## Slices

1. **Per-worker model on the spec/dispatch path.** Add an optional
   model (or `tier: "fast" | "heavy"`) to the worker dispatch so a
   worker can run a model distinct from the run default; absent ⇒
   today's single-model behaviour byte-for-byte (no regression).
   Resolve a tier→concrete-model mapping from config
   (`~/.muse/models.json` already exists). Narrow unit + the
   existing orchestration tests stay green.
2. **Tier classifier (deterministic first).** A conservative rule
   that labels a sub-task `fast` (retrieval / formatting / single
   factual lookup) vs `heavy` (multi-step reasoning / planning),
   defaulting to `heavy` when unsure (never silently downgrade a
   reasoning task). Unit-tested on labelled cases.
3. **Capacity-aware fallback (the user-stated caveat).** Probe the
   Ollama host's loaded-model capacity (`/api/ps` / `/api/show`);
   if it cannot hold the fast + heavy pair concurrently, collapse
   the run to the single high-capability model (sequential), logged
   so the user can see why. Fail-open to single-heavy on any probe
   error. Integration-tested with a faked low-capacity host.
4. **Transparent auto-routing in the ask/REPL path.** When the
   default path detects a fan-out-worthy request, it runs the
   tiered orchestration under the hood and returns one coherent
   answer — the user never names a model. Off by default behind a
   flag until proven; opt-in does not change a plain single-turn
   ask. Integration + `smoke:live`.
5. **Explicit `muse orchestrate --tiered` surface + live proof.**
   Surface the tier assignment in `muse orchestrate run` output and
   close the epic with a `smoke:live` orchestration whose workers
   demonstrably executed on different local models (and the
   low-capacity collapse path).

## Verify

- Per slice: narrowest touched-package test
  (`pnpm --filter @muse/multi-agent test`, `@muse/cli`, `apps/api`)
  + `pnpm lint` 0/0.
- Slices 3–5 touch the request/response path ⇒ the relevant
  `pnpm smoke:live` endpoint MUST run a real local-Ollama round-trip
  (two distinct Qwen tiers, e.g. a small + a larger Qwen you have
  pulled). The `CAPABILITIES.md` line + the P10 bullet flip happen
  there, never on a unit-only test.
- Cross-package wiring (spec → worker → runtime) ⇒ `pnpm check`.

## Status

Open — authored 2026-05-22 by human command (this is NOT a
loop-self-authored target). Substrate audited present; the five
slices above close the model-tiering + capacity + auto-routing
gap. First slice = per-worker model on the dispatch path (slice 1).

Correction to the OUTWARD-TARGETS "Audited reality" line: it lists
"multi-agent orchestration" under **SOLID & live-proven — do NOT
rebuild**. That is overstated — the engine and surfaces are solid,
but it is `smoke:broad` (diagnostic) verified only, single-model,
and not live-proven. This goal closes that honesty gap by adding
the missing tiering + a real `smoke:live` round-trip.

## Decisions

- **Deterministic tier classifier before any LLM-based router**
  (slice 2): a model-picking-a-model loop is more cost and more
  nondeterminism for a decision a keyword/shape rule handles well
  enough; defer an LLM router until a deterministic rule is proven
  insufficient (YAGNI).
- **Default to `heavy` when the classifier is unsure** — a wrongly
  downgraded reasoning task is a visible quality regression; a
  wrongly upgraded lookup only costs latency. Asymmetric risk ⇒
  conservative default.
- **Capacity collapse is sequential-on-heavy, not parallel-on-fast**
  — when the box can't hold both, correctness (heavy model) beats
  speed (fast model). Matches the user's stated caveat ("둘 다 키면
  못 버티면 고사양 1개로").
- **Auto-routing ships behind a flag, off by default** until the
  live round-trip proves it doesn't degrade a plain ask — the
  ask/REPL path is the most-used surface; a silent fan-out
  regression there is high-blast-radius.
