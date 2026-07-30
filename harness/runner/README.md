---
title: Harness Runner (code — gate enforcement)
audience: [developers, AI agents]
purpose: The minimal runner that enforces the harness gates as "code", not "instructions"
updated: 2026-05-31
---

# Harness Runner (code)

Enforces the state machine and fail-closed gates defined by
[`../reference/runner-spec.md`](../reference/runner-spec.md) **as real code**. Documents (instructions) are
something the model "chooses to follow", but this runner has **code refuse disallowed
transitions** — even if the model tries to skip a stage or pass with empty criteria, the runner
blocks it.

> **What is the harness and what is not (2026 consensus):** the harness is the control plane that
> *executes* — it runs the loop and enforces the gates (not just rules).
> - `harness-runner.mjs` = the gates (allow/refuse verdicts on transitions) — the part that
>   enforces the rules as code. **Harness.**
> - `orchestrator.mjs` = the control plane that **actually drives** the plan→build→evaluate loop.
>   **The harness proper.**
> - `run.mjs` = the **replaceable adapter** that connects that loop to a specific agent CLI
>   (`claude -p`). Only which agent is used differs per host; the harness proper — loop, gates,
>   verification — stays the same.
> - What is *not* the harness = the **domain work** the agent produces (a backoff function, etc.)
>   = workload.

> 2026 evidence: "Kubernetes was fail-closed, but agent systems are fail-open" (the control-plane
> problem) — so gates must be **deterministic code** (OpenAI Harness Engineering · Faramesh
> non-bypassable), and trust-critical logic must be **proven by unit tests down to the refusal
> paths** (Martin Fowler).

## What's inside

- **`harness-runner.mjs`** — zero dependencies (Node built-ins only). A set of pure functions:
  - `advance(state, event, ctx)` — state transition. If not allowed, `BLOCKED` + reason
    (fail-closed default).
  - `planGate(acceptanceSlice)` — refuses if any of WHAT, WHY, PASS, out-of-scope, verification
    commands, evidence accounting, or rollback is missing/blank (blocking claim-only plans from
    guessing their way through).
  - `permissionGate(action)` — banking = permanent refusal; outbound = resolved recipient + human
    confirmation required; write/execute = trust required; unknown = refuse.
  - `createRun()` — re-applying the same transition id takes effect only once (resume idempotency).
- **`conformance.test.mjs`** — tests proving the **refusal paths** of the
  [runner-spec §7 matrix](../reference/runner-spec.md).
- **`orchestrator.mjs`** — execution integration. `runCycle(task, {callAgent})` **actually
  drives** plan→build→evaluate→complete while gating every transition through the gates above and
  leaving a **trace**. `callAgent` is injected (tests use a fake agent, production a real LLM), so
  it is portable and testable.
- **`orchestrator.test.mjs`** — proves the driving flow + gate firing with a fake agent (no LLM
  needed).
- **`run.mjs`** — CLI entrypoint: `node harness/runner/run.mjs "<task>"` — calls each role via a
  real `claude -p` (a fresh context per role = maker ≠ judge) and leaves `last-trace.json`. The
  agent binary is swappable via `CLAUDE_BIN` (porting to another agent CLI).
- **`redteam.test.mjs`** — adversarial verification that gate **bypass attempts** (stage jumping,
  completion forgery, self-grading, privilege escalation, banking disguise, retry-cap bypass) are
  all blocked.
- **`hooks.mjs`** — the PreToolUse/PostToolUse **hook** layer. A tool wrapped by `dispatchTool`
  does not run if a pre-hook blocks it (non-bypassable, fail-closed). The permission gate is the
  default hook (`permissionHook`). → [hooks.md](../reference/hooks.md)
- **`hooks.test.mjs`** — verifies the 6 hook cases (deny = execution blocked · exception = blocked
  · first-deny-wins across multiple hooks · permission hook · observation).
- **`tracer.mjs`** — the observability (trace) layer. Correlation IDs, structured events,
  summaries (counts · blocked · duration · cost), sensitive-data redaction. The orchestrator
  records through it. → [observability.md](../reference/observability.md)
- **`tracer.test.mjs`** — the 6 tracer cases (correlation ID · summary rollup · redaction ·
  toJSON · orchestrator integration · hook composition).
- **`session.mjs`** — session persistence (checkpoint · resume). Per-stage snapshots + memory/file
  stores. On resume, completed stages (re-plan, re-build) are skipped.
  → [session-persistence.md](../reference/session-persistence.md)
- **`session.test.mjs`** — the 6 session cases (snapshot round-trip · memory/file stores · 4-stage
  checkpointing · resume-from-PLANNED skips the planner · resume with a build in hand skips the
  worker).
- **`memory.mjs`** — the memory runtime. write (drop one-offs) / read (relevance) / consolidate
  (merge duplicates) / decay (inference half-life) / promote (promote to core), as deterministic
  code. → [memory-layers.md](../reference/memory-layers.md)
- **`memory.test.mjs`** — the 5 memory cases (write · relevance read · duplicate merge · decay ·
  promotion).
- **`tools.mjs`** — the tool registry. Registration (verb_noun) · schema validation · allow/deny
  (denylist wins) · few-exposed (maxExposed) · risk tier → permission gate.
  → [tool-design.md](../reference/tool-design.md)
- **`tools.test.mjs`** — the 6 tool cases (registration refusal · denylist wins · validateArgs ·
  expose cap · permission composition).
- **`project.mjs`** — **multi-stage orchestration**. Decomposes a large task into subtasks →
  drives each through runCycle → synthesizes. The project gate is fail-closed (halt on empty
  decomposition / a blocked subtask). `run-project.mjs` drives it with a real `claude -p`.
- **`project.test.mjs`** — the 8 multi-stage cases (decompose → all DONE · empty decomposition
  blocked · nothing after a mid-run block · resume skipping · correlation ID + **shared context**:
  a later stage receives earlier output · shareContext:false independence · prior restored on
  resume).

## How to run (no dependency install needed)

```
node --test "harness/runner/*.test.mjs"
```

(The directory-argument form `node --test harness/runner/` breaks on Node 24, which treats the
directory as an entry module — the glob form is portable across all Node 21+ versions.)

Last measurement (2026-07-30): **69/69 passing** (conformance 14 + adversarial 9 + multi-stage 8 +
session 8 + orchestrator 7 + hooks 6 + tracer 6 + tools 6 + memory 5). The runner is "delivered" only when
**every refusal path is green**, not just the happy path. CI is enforced per `harness/**` change
by `.github/workflows/harness.yml` (the host repo's CI).

**Real end-to-end (the integrated runner, `run.mjs`):** drove the three tasks `count_vowels`,
`fizzbuzz`, and `is_valid_email` with a real 3-role `claude -p` → **3/3 all
plan→build→evaluate→DONE (PASS)**, gates enforced in code and traces left. That is, the gates
**enforce real execution**, beyond "tested logic".

## State machine

```
REQUESTED --plan(plan gate)--> PLANNED --build--> BUILT --evaluate(maker ≠ judge)--> EVALUATED
   EVALUATED --complete(completion gate: PASS only)--> DONE
   EVALUATED --rebuild(retry cap)--> BUILT
   every other transition --> BLOCKED (fail-closed)
```

(The [LEARN] curator stage is non-blocking learning after DONE — not a gate the state machine
enforces.)

## Limits

This is a minimal runner — the core is the **deterministic enforcement** of the state machine and
gates; the model reasons *inside* each state (Boris Cherny's "thin harness, smart model"). What
sits on top as an orchestration runtime (process spawning, tool-call wiring) is the host's job;
this runner is the gate core that judges "is this transition allowed" underneath it.
