# @muse/scheduler

Owns Muse's scheduled/triggered job model: cron-driven and on-exit-driven jobs that call an MCP
tool or run an agent, plus their execution history, distributed lock, and dynamic add/update/
remove surface. It is a package because scheduling, dispatch, retry, and storage need one
contract regardless of the backing store.

## Public surface

- `ScheduledJob`, `ScheduledJobInput`, `ScheduledJobExecution`, `TriggerInvocation` — the job and
  execution record shapes, including the webhook-trigger fields.
- `ScheduledJobStore`, `ScheduledJobExecutionStore` interfaces plus their `InMemory*`, `Kysely*`,
  and `FileScheduledJobStore` implementations.
- `DynamicScheduler`, `createSchedulerTools`, `NodeCronScheduler`, `ScheduledJobDispatcher`,
  `ScheduledMcpToolInvoker`, `ScheduledAgentExecutor` — reads the store, honors cron/timezone, and
  dispatches one due job to its MCP tool or agent target.
- `KyselyDistributedSchedulerLock`, `InMemoryDistributedSchedulerLock` — cross-process lock so
  only one instance fires a given job.
- `OnExitScheduler`, `OnExitWatcher`, `validateOnExitTrigger` — fire work when a watched process
  exits, bounded by a poll/timeout/kill-grace envelope.
- `ActiveRunTracker`, `TriggerControlFileStore`, `parseCadence`, `summarizeCadence`,
  `buildDuplicateJobInput` — drain tracking, a pause kill-switch, cadence parsing, clone-a-job.

## Depends on

- `@muse/db` — the Kysely database handle for `Kysely*` store implementations.
- `@muse/mcp` — the MCP tool invocation contract `mcp_tool`-type jobs dispatch through.
- `@muse/resilience` — retry/backoff primitives used by the dispatcher.
- `@muse/shared`, `@muse/stores`, `@muse/tools` — common types, durable-store conventions, and
  the tool contract `createSchedulerTools` exposes to the agent.

## Rules that bind this package

An `agent`-type job's `webhookPayload` is untrusted inbound data: `TriggerInvocation` documents
that the executor must neutralize and fence it before the model sees it, and it is never handed to
a tool-type job — an argument-injection fail-close, matching the "tool output is untrusted" rule
in [`../../CLAUDE.md`](../../CLAUDE.md). `DynamicSchedulerOptions.triggerAdmission`/`isPaused` are
the deterministic admission/kill-switch seams a caller wires; this package never sends anything to
a third party itself.

## Tests

```bash
pnpm --filter @muse/scheduler test
```
