# Goal 919 — `muse.tasks.update`: the agent can reschedule / edit a task

## Outward change

The agent-facing `muse.tasks` loopback MCP tool gains an `update` verb:
given a task `id`, it can reschedule (`dueAt`, ISO or relative phrase,
`'none'` clears), rename (`title`), mark/clear `urgent`, or change
`notes`. So an agent asked "move the dentist task to Friday 9am" or
"rename that task / make it urgent" can now do it. Before, the tool had
only add / list / complete / search — no way to CHANGE an existing
task — even though the CLI `muse tasks edit` has supported exactly this
all along. The agent could create or finish a task but never reschedule
one, the single most common task edit.

## Why this, now

Agent↔CLI CRUD parity, the slice explicitly deferred in 912's notes
("a task-edit tool is its own slice"). Rescheduling is bread-and-butter
task management — a meeting moves, a deadline slips — and the user can
do it from the CLI but the agent (the JARVIS surface they actually
talk to) couldn't. This closes the last task-CRUD gap on the agent
side: create (add) / read (list, search) / **update** / complete.

## How

New `update` tool in `createTasksMcpServer`, mirroring `muse tasks
edit`'s field set and clear-out semantics: resolve the task by exact
`id` (error if not found), require at least one field beyond `id`,
then patch a mutable copy — `title` (non-empty), `urgent`
(true sets / false deletes), `notes` (empty clears), `dueAt`
(`parseTaskDueAt`; `'none'`/empty clears) — and `writeTasks`. Reuses
the store's existing `parseTaskDueAt` / `readTasks` / `writeTasks` /
`serializeTask` (no new store primitive, no drift). Tool description
carries a "use when … ; do NOT use to create (add) or complete" line
per `tool-calling.md`; schema fields each have a concrete example.
`risk: "write"`.

## Verification

`packages/mcp` `mcp.test.ts` `muse.tasks loopback server` (`pnpm
--filter @muse/mcp test`, 940 passing): add a task, then `update`
reschedules + renames + clears urgent in one call (asserts the new
title/dueAt and that urgent is gone), `dueAt:"none"` clears the due
date and the change persists through `list`, and the guards fire
(unknown id → "not found"; no fields → "at least one"). Mutation-proven:
dropping the `dueAt` update branch fails the reschedule assertion;
restored green. `pnpm check` green (mcp 940, apps/cli 1671, apps/api
323); `pnpm lint` 0/0; no projected-tool-COUNT assertion broke.

`[UNVERIFIED-LIVE]`: the deterministic handler is fully verified, but
`update` is a new tool in the schema the local model sees — whether
Qwen SELECTS it (and fills `id`/`dueAt`) for a natural "reschedule …"
request is a `smoke:live` tool-call check that could NOT run (Ollama
unreachable this session). The moment it's up, `smoke:live` should
assert the model picks `update` over `add`.

## Decisions

- One `update` tool covering dueAt/title/urgent/notes rather than a
  separate `reschedule` tool — fewer tools on the turn (tool-calling.md
  budget), and "edit a task" is one coherent intent the description's
  examples disambiguate. Omitted `tags` (rare for an agent to set;
  keeps the schema tight).
- Mirrored the CLI `edit` clear-out semantics (`'none'`/empty/`false`)
  so the two surfaces behave identically — a user who learns one
  doesn't get surprised by the other.
