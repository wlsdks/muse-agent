---
title: Session Persistence — checkpoint & resume
audience: [developers, AI agents]
purpose: Leave run state as checkpoints so a stopped/dead run resumes without re-executing completed stages
updated: 2026-06-13
---

# Session Persistence

One of the core definitions of the canonical harness control plane — "**state maintenance** across
turns", Anthropic effective-harnesses' "**coherent progress** across multiple context windows". It
lets a long task, when interrupted midway, **continue without re-running already-completed stages
(especially expensive agent calls)**. Where the observability trace
([observability](observability.md)) answers "what happened", session persistence answers "resume
from where".

## What it is

[runner/session.mjs](../runner/session.mjs) (zero dependencies — fs is Node built-in):

- **Snapshot** `snapshot({runId, phase, criteria, attempt, build, verdict})` — the minimal state
  needed to resume. It carries the plan stage (criteria), the retry count, and any build already
  produced, so **re-planning and re-building can be skipped**.
- `serializeSession` / `deserializeSession` — JSON serialization + validation (version `v:1`,
  invalid input rejected).
- **Store (injected, portable)** — `createMemoryStore()` (for tests), `createFileStore(dir)`
  (one JSON file per runId). The host may plug in a DB store (interface: `save(s)` · `load(runId)`
  · `list()`).

## How it is wired

- `runCycle(task, { checkpoint })` — calls `checkpoint(snapshot)` at each stage (PLANNED · BUILT ·
  EVALUATED · DONE). The host saves it to a store.
- `runCycle(task, { resume: snapshot })` — resume. **If phase is PLANNED or later, the planner is
  not called again** and the saved criteria are reused; **if a build already exists, the worker is
  skipped** and evaluation runs directly (a `resumed` event is recorded).
- `run.mjs` leaves a checkpoint at `sessions/<runId>.session.json` per run (a gitignored
  artifact). To resume, load that snapshot and pass it as `resume`.

## Verification

[runner/session.test.mjs](../runner/session.test.mjs) — `node --test "harness/runner/*.test.mjs"`:
snapshot round-trip · invalid snapshot rejected / memory store save·load·list / file store disk
persistence / orchestrator checkpoints all 4 stages / **resume at PLANNED does not call the
planner (criteria reused)** / **resume with an existing build does not call the worker**. **6/6**
(runner suite cumulative **45/45**).

## Work that exceeds a context window (structural state — compaction alone is not enough)

Long work spanning multiple context windows is not covered by checkpoint + compaction alone
(Anthropic effective-harnesses: "compaction isn't sufficient"). Keep structural scaffolding
alongside:

- **A feature-list file** — keep the end-to-end feature bundle in a structured file (JSON), but
  **start everything in 'failing' state** — early "done" declarations are blocked structurally
  (isomorphic to the golden-set progress table). Flip to 'passing' only after careful
  verification.
- **The progress file + git log ARE the handoff** — a new session starts by *reading* the git log
  and progress file first. Commit at every working state (recovery points).
- **One feature per session** — a session never opens multiple features (for both context and
  verification).
- **The first session does initialization only** — split off an initializer session that does
  environment setup only (later sessions just work).

Source: Anthropic — [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) (2025-11).

## Limits / next

Snapshots go up to stage-boundary state (not full trace reconstruction — that is the
observability trace's job). Precise resume of cumulative cost and partial-token state is the host
runtime's job. (The memory runtime is also codified later as `memory.mjs` —
[memory-layers §runtime](memory-layers.md).)
