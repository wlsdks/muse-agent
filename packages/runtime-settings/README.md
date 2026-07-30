# @muse/runtime-settings

Admin-configurable runtime knobs stored as typed key/value settings, with a caching layer in
front of the store. Distinct from `@muse/runtime-state`, which owns execution-lifecycle state
(checkpoints, run history), not configuration.

## Public surface

- `.` (`src/index.ts`) — `RuntimeSettingsStore` and its implementations
  (`InMemoryRuntimeSettingsStore`, `KyselyRuntimeSettingsStore`), the `RuntimeSettings` cached
  reader/writer (`getString`/`getBoolean`/`getNumber`/`getInteger`/`getJson`/`set`/`delete`/
  `refreshCache`), and `parseBooleanSetting` for callers wiring their own boolean-shaped setting.

## Depends on

- `@muse/db` — `KyselyRuntimeSettingsStore` reads and writes through the shared schema's
  `runtime_settings` table.
- `@muse/shared` — `isJsonValue`, `parseBooleanTriStateFromEnv`, `parseJson`.

## Rules that bind this package

- `KyselyRuntimeSettingsStore` has an in-memory counterpart (`InMemoryRuntimeSettingsStore`) so a
  caller without PostgreSQL still runs, per `../../.claude/rules/engineering/architecture.md`'s database
  rules.
- `RuntimeSettings`'s cache invalidation is generation-and-epoch-guarded so a write from a
  sibling process can't leave a stale in-flight read cached past the write — see the constructor
  comment on `cacheTtlMs` before changing the TTL default.

## Tests

`pnpm --filter @muse/runtime-settings test`
