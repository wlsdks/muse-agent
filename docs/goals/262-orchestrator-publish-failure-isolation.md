# 262 — a failing bus publish corrupted multi-agent orchestration

## Why

Goal 213 established the rule for race mode: *"a bus publish
failure must NOT prevent resolve"* — `runRace` guards every
`publishWorkerResult` / `publishWorkerFailure` with
`.catch(() => undefined)`. The non-race execution paths
(`runSequential`, `runParallel`) never got that treatment, even
though the message bus's `publish` rejects whenever any subscribed
handler throws (`Promise.all(handlers.map(h => h(message)))` in
`InMemoryAgentMessageBus`) — a buggy subscriber, a transient
history-store write, or a telemetry sink is enough.

Consequences with an unguarded publish:

- **`runParallel`** — a worker that *succeeded* but whose result
  publish threw was caught by the surrounding `catch` and returned
  `{ status: "failed" }`: the worker's real answer was discarded
  from the fan-in. And a throw on the *failure*-path publish
  escaped the `catch`, rejecting the whole `Promise.all` →
  the entire multi-agent run threw.
- **`runSequential`** — worse: the `completed` entry was pushed
  *before* the publish, so a publish throw re-entered the `catch`,
  pushed a *second* (`failed`) entry for the **same worker** (a
  duplicate, double-counted result) and replaced the pipeline
  `currentInput` with a handoff-failure message — corrupting every
  subsequent worker's input as if a successful step had failed.

A subscriber's failure should never decide a worker's
status or kill the orchestration; only `worker.run` does.

## Scope

`packages/multi-agent/src/index.ts` — add `.catch(() =>
undefined)` to all four non-race publish calls (`runSequential`
success + failure, `runParallel` success + failure), exactly
mirroring `runRace`'s guarded sites. One coherent change; no API,
mode, or success/failure semantics change — only "bus publish
failure is best-effort and never alters orchestration state".

## Verify

- `pnpm --filter @muse/multi-agent test` — 45 pass (was 44; +1).
  New test runs both `parallel` and `sequential` modes with a
  message bus whose `publish` always throws and two succeeding
  workers; asserts the run resolves, both workers are reported
  `completed` (not failed, not duplicated), and their outputs are
  intact. The existing parallel/race/history tests stay green
  (they use the non-throwing `InMemoryAgentMessageBus`, unchanged
  behaviour).
- `pnpm check` — every workspace green (multi-agent 45, apps/cli
  560, apps/api 155, all packages). `pnpm lint` — exit 0.
- No real-LLM request/response path touched (orchestration
  control-flow + bus-publish isolation; the synthetic
  `RuleBasedAgentWorker`s make no model call), so the
  deterministic unit test is the rigorous verification.

## Status

done — `runSequential` and `runParallel` now match `runRace`: a
message-bus publish failure is swallowed and never downgrades a
succeeded worker, never double-counts it, never corrupts the
sequential pipeline, and never aborts the whole multi-agent run.
Worker status is decided solely by `worker.run`.
