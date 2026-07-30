---
title: Observability — traces
audience: [developers, AI agents]
purpose: The canonical harness layer that records every step of a run under one correlation ID, enabling replay, audit, and cost accounting
updated: 2026-06-13
---

# Observability

One of the canonical five layers (memory · tools · permissions · hooks · **observability**). The
layer the 2026 consensus consistently names as core — it turns "my agent did something weird" into
a **reproducible bug report** (Boris Cherny), provides the control plane's **auditable records**,
and Anthropic's **replayable traces + cost**.

## What it is

[runner/tracer.mjs](../runner/tracer.mjs) (zero dependencies):

- `createTracer({ runId, now, redact })` — a per-run tracer.
  - `.add(event, data)` — records a structured event. Every event carries the **correlation ID
    (runId)** + a monotonically increasing `seq` + a timestamp `t`.
  - `.summary()` — rollup of per-event counts, **blocked count**, total duration (durationMs), and
    **cost sum (cost)**.
  - `.toJSON()` — serializes `{runId, events, summary}` (for persistence/dashboards).
- `redactSecrets` — replaces `api_key` · `authorization` · `token` · `secret` · `password` ·
  `cookie` keys with `[redacted]` so traces can be **persisted safely** (governance).

## Where it is wired

- The **orchestrator** records every stage (start · plan · gate · build · evaluate · done ·
  blocked · rebuild) through this tracer, and `runCycle` returns `{trace, summary}`. Gate
  verdicts, roles, and retries are tied together under one correlation ID.
- The **PostToolUse hook** ([hooks](hooks.md)) can stream tool-call results into the tracer
  (observability ⊕ hooks composition).
- `run.mjs` leaves `last-trace.json` (`{events, summary}`) after each run and prints the summary
  (with secret redaction applied).

## Verification

[runner/tracer.test.mjs](../runner/tracer.test.mjs) — `node --test "harness/runner/*.test.mjs"`:
correlation ID + seq assignment / summary rollup (counts, blocked, duration, cost) / redaction /
toJSON serialization / orchestrator emits trace+summary / hook→tracer composition. **6/6**
(runner suite cumulative **39/39**).

## Limits / next

For now: **in-memory traces + JSON persistence**. Tokens/cost are summed if the host supplies a
`cost` field (wire it up once the agent CLI exposes cost). (Session persistence and the memory
runtime are also filled in as code later — [architecture §4](architecture.md).)
