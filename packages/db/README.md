# @muse/db

The shared PostgreSQL schema and migration set for Muse's server-side state, accessed through
Kysely. This package owns the `MuseDatabase` table typings and the ordered SQL migration list —
it does not own connection lifecycle or query logic for any one domain.

## Public surface

- `.` (`src/index.ts`, re-exporting `migrations.js` and `schema.js`) — the `migrations` array and
  `migrationNames()`, plus the `MuseDatabase` Kysely schema interface and its per-table types
  (`AgentRunTable`, `ConversationMessageTable`, `CheckpointTable`, `HookTraceTable`,
  `RuntimeSettingTable`, `ScheduledJobTable`, `TraceEventTable`, `UserMemoryTable`, `UserTable`,
  and the rest of the tables listed on `MuseDatabase`).

## Depends on

- `@muse/shared` — `JsonValue` and `RunStatus` are reused in the column typings.

## Rules that bind this package

- Kysely with explicit SQL migrations, per `../../.claude/rules/engineering/architecture.md` — prefer an
  explicit migration in `migrations.ts` over ORM-managed schema mutation.
- PostgreSQL is optional: every consuming store (checkpoints, run history, runtime settings,
  observability sinks, auth) ships an in-memory fallback, so this package's absence at runtime
  does not stop Muse from running.
- Run, message, tool-call, approval, checkpoint, and trace tables stay queryable — don't hide
  critical agent state in an opaque blob unless it's an append-only event payload, per
  `../../.claude/rules/engineering/architecture.md`.

## Tests

`pnpm --filter @muse/db test`, plus `pnpm --filter @muse/db test:postgres`
(`MUSE_DB_POSTGRES_TEST=1`) for the Testcontainers-backed real-PostgreSQL run.
