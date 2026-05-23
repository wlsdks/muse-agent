# Goal 898 — `muse status` marks an urgent due-soon task with ⚠

## Outward change

The `muse status` dashboard's "tasks due in 24 h" section now
prepends `⚠ ` to an urgent task and carries an `urgent` flag on each
`due24h` entry in `--json`. Before, an urgent task due soon looked
identical to a normal one in the at-a-glance view — even though
`muse tasks list` (875), `muse today`, and the agent-facing
`muse.status` MCP tool all surface the urgent flag. The dashboard was
the lone surface that dropped it.

## Why this, now

A cross-surface consistency seam: the `urgent` task flag (875) is
honoured on every other view of a task EXCEPT the `muse status`
due-soon list — the very place a user glances to triage "what needs
me now". Urgent-due-soon is the highest-attention task state, so the
dashboard silently flattening it is a real signal loss. Smallest
verifiable fix that brings the dashboard to parity.

## How

`collectStatus` now maps each `due24h` entry with
`urgent: task.urgent === true` (matching the `muse.status` tool's
shape), and the local `PersistedTask` interface gains
`urgent?: boolean`. The text renderer prepends `⚠ ` when
`task.urgent`. Additive `--json` field → no `MUSE_STATUS_SCHEMA_VERSION`
bump.

## Verification

`apps/cli` `program.test.ts`: seeds a temp `MUSE_TASKS_FILE` with an
urgent + a normal task both due within 24 h; `muse status --json`
asserts `due24h` carries `urgent: true` / `false` respectively, and
the text run asserts `⚠ Pay rent` appears while `Water plants` has
the bare bullet (no `⚠`). Mutation-proven: dropping the `⚠` from the
renderer fails the text assertion. The local `PersistedTask` lacked
`urgent` (caught by `pnpm check`, not vitest — added the field). The
2 full-suite failures are the known voice-playback `/tmp` flake;
`pnpm lint` 0/0. No LLM path → no smoke:live (Ollama down regardless).

## Decisions

- `urgent: task.urgent === true` (always-present bool) rather than an
  optional — matches the `muse.status` tool's `due_next_24h` shape so
  the two status surfaces agree field-for-field.
