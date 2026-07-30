# @muse/runtime-state

Execution-lifecycle state that outlives a single agent turn: checkpoints, hook traces, run
history, resident-daemon status/restart/terminal state, session tags, and delivery-safety
counters. Distinct from `@muse/runtime-settings`, which owns admin-configurable knobs, not
execution state.

## Public surface

- `.` (`src/index.ts`) — `CheckpointStore` and its implementations (`InMemoryCheckpointStore`,
  `KyselyCheckpointStore`, `FileCheckpointStore`, `pruneCheckpointFilesByAge`), `HookTraceStore`
  (`InMemoryHookTraceStore`, `KyselyHookTraceStore`), `readLocalCheckpointEvidenceStrict` and
  `createCheckpointContinuityEvidence` for Continuity evidence binding, resident-daemon
  status/restart/terminal-state helpers, delivery-safety primitives, and run-history
  (`run-history.js`, `run-history-in-memory.js`, `run-history-kysely.js`) and session-tag stores.

## Depends on

- `@muse/db` — the Kysely stores (`KyselyCheckpointStore`, `KyselyHookTraceStore`,
  run-history/session-tags) read and write through the shared schema.
- `@muse/shared` — `createRunId`, `JsonObject`, and other base primitives.

## Rules that bind this package

- Every Kysely-backed store here has an in-memory or file-backed counterpart, per
  `../../.claude/rules/architecture.md`'s database rules — a caller without PostgreSQL still runs.
- Checkpoint/run-history state is queryable agent state, not an opaque blob, per
  `../../.claude/rules/architecture.md`'s database rules.

## Tests

`pnpm --filter @muse/runtime-state test`
