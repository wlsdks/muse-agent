# 189 — quarantine a corrupt tasks store instead of destroying it

## Why

`readTasks` returned `[]` for a present-but-unparseable
`~/.muse/tasks.json` (partial write after kill -9 / crash /
disk-full). That looks "robust" for the list view, but it is a
**silent data-loss footgun**: the next `muse tasks add` /
`muse.tasks.add` reads `[]`, appends one task, and
`writeTasks` (tmp + rename) **overwrites the corrupt file with
just the new task** — permanently destroying every prior task
the user had, from a single bad byte. A personal-assistant
task list must not self-destruct on corruption.

## Scope

- `packages/mcp/src/personal-tasks-store.ts`:
  - New `quarantineCorruptStore(file)` — best-effort
    `rename(file, \`${file}.corrupt-<ts>\`)`; a rename failure
    never crashes the read path.
  - `readTasks` calls it in the two **present-but-corrupt**
    branches (JSON.parse throws / wrong shape) before returning
    `[]`. The **absent-file** branch (ENOENT) is unchanged — an
    empty/new install is legitimately empty, not quarantined.
  - Net effect: reads still degrade to empty (list works), but
    the original bytes survive at `tasks.json.corrupt-<ts>` and
    the next write starts fresh instead of clobbering
    recoverable data.

## Verify

- `pnpm --filter @muse/mcp test` — 332 pass. The existing
  "treats a missing or corrupt file as empty" case still green
  (still returns []); 1 new case asserts the original bytes are
  preserved in `tasks.json.corrupt-*` and a later write does
  not destroy them.
- `pnpm check` exit 0; `pnpm lint` exit 0.
- No real-LLM path touched (pure fs/store logic; smoke:live
  not required).

## Status

done — a corrupt task store is now quarantined for manual
recovery instead of being silently overwritten on the next
add. Same `read → []` graceful-degradation for callers; the
permanent-loss vector on the write path is closed.
