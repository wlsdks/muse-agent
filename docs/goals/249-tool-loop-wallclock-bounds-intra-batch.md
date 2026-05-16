# 249 — wall-clock deadline didn't bound a single multi-tool batch

## Why

CLAUDE.md non-negotiable: "Tool loops have explicit limits and
timeouts." `model-loop.ts` enforces `maxRunWallclockMs` by
checking `Date.now() > deadlineMs` **only at the top of the
`while` loop**, between model turns. Inside one turn the per-tool
`for (const toolCall of calls)` loop ran every call sequentially
with `await runner.executeToolCall(...)` and **no** deadline
check.

A reasoning-off model (qwen3) routinely emits a *batch* of tool
calls in one response. If each hits a slow or hung MCP server
(web fetch, remote API), N calls run back-to-back — the run
blows past `maxRunWallclockMs` by `N × slow` before the next
between-turn check ever happens. The wall-clock cap was a
between-turn boundary, not a real execution bound.

The naive fix (block any call once `Date.now() > deadlineMs`)
broke the established contract — verified by the existing
"maxRunWallclockMs disables further tool calls" test: when the
deadline passes *during a slow model call*, the calls that turn
already emitted must still run; the deadline only disables tools
for the *next* turn. The correct semantics: honour a batch that
was emitted before the deadline, but stop executing it once the
deadline is crossed **while running the batch itself**.

## Scope

`packages/agent-core/src/model-loop.ts` — both `executeModelLoop`
and `executeStreamingModelLoop`:

- Snapshot `batchStartedPastDeadline = deadlineMs && Date.now() >
  deadlineMs` once, immediately before the per-call `for` loop.
- Per call, `crossedDeadlineMidBatch = !batchStartedPastDeadline
  && deadlineMs && Date.now() > deadlineMs` — true only when the
  deadline is crossed *during* this batch's sequential execution.
- When set, the call is **not executed**; it gets a
  `blockedToolResult(..., "Error: run wall-clock deadline
  reached")` — the same mechanism the count-limit path uses, so
  every `tool_call_id` still receives a paired tool message and
  the final synthesis turn is well-formed.
- `toolCallCount` only increments for calls that actually ran
  (`canRun`), preserving prior counting for the non-deadline and
  duplicate paths.

No public API or option change; `maxRunWallclockMs` now bounds
tool execution, not just the between-turn boundary.

## Verify

- `pnpm --filter @muse/agent-core test` — 533 pass (was 532; +1).
  New test: turn 1 emits two calls in one response, the tool
  sleeps 60ms, `maxRunWallclockMs: 20`, `maxToolCalls: 10` —
  asserts the tool executed exactly once (call 2 blocked
  mid-batch, count limit not the gate) and the run still completed
  cleanly ("Done."). The pre-existing
  "maxRunWallclockMs disables further tool calls once the deadline
  passes" test stays green — proves a batch emitted after a slow
  model call is still honoured (the `batchStartedPastDeadline`
  guard).
- `pnpm check` — every workspace green (agent-core 533, apps/cli
  555, apps/api 155, all packages). `pnpm lint` — exit 0.
- Real-LLM round-trip (tool-loop orchestration touched): `muse ask
  --with-tools` on Ollama `qwen3:8b`, reasoning off
  (`OLLAMA_BASE_URL=127.0.0.1:11434 MUSE_MODEL=ollama/qwen3:8b
  GEMINI_API_KEY=""`, isolated HOME so the real `~/.muse` is
  untouched) — the agent executed `muse.tasks.add` (task written
  to disk) and returned a clean one-line confirmation, confirming
  the happy path (no deadline pressure) is not regressed by the
  `batchStartedPastDeadline` / `crossedDeadlineMidBatch`
  restructure. The mid-batch-block failure path is covered
  deterministically by the unit test (forcing a real hung-tool
  timeout in a live run would be flaky — correct split: failure =
  deterministic unit test, happy = live round-trip
  non-regression).

## Status

done — a single model turn that fans out a batch of slow tool
calls can no longer run unbounded past `maxRunWallclockMs`. The
remaining calls are skipped (with paired blocked results, so
message pairing and the final synthesis stay well-formed) the
moment the deadline is crossed mid-batch, while a batch emitted
before the deadline is still honoured. The wall-clock cap is now a
real execution bound on both the blocking and streaming loops.
