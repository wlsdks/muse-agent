# 812 — feat: tasks + reminders tools describe every parameter (one-shot tool-calling)

## Why

Tool-calling reliability ([`tool-calling.md`](../../.claude/rules/tool-calling.md)).
Tasks (`muse.tasks` + `muse.tasks-multi`) and reminders are top
daily-driver WRITE actuators — the model fills `title` for "add a task
to buy milk", `query` for search, `id` for complete/snooze. Their
parameters were bare `{ type: "string" }` (and the `status` enums
undescribed) — the rule-3 invalid-args failure mode on the actuators
the user reaches for most. 800/801 did calendar/notes; this finishes
tasks + reminders.

## Slice

`@muse/mcp`:
- loopback-tasks.ts — `add` (title/notes/tags), `list`/`search`
  (status enum), `complete` (id), `search` (query) params described.
- loopback-tasks-registry.ts — `list`/`add`/`complete`/`search`
  params (title/providerId/notes/tags/id/query/limit/status) described.
- loopback-reminders.ts — `due`/`search` `status` enum and
  `snooze`/`fire`/`clear` `id` described (the `add`/`snooze` time
  fields were already done).

## Verify

- `@muse/mcp` tasks-reminders-tool-schema.test.ts (new, 3): the REAL
  `createTasksMcpServer` / `createTasksRegistryMcpServer` /
  `createRemindersMcpServer` tools pass `validateToolDefinitions` with
  ZERO `undescribed_parameter` (goal-799 check); tasks `add.title`
  carries an "e.g." example.
- **Mutation-proven**: reverting tasks `add.title` to bare string →
  the check flags it and the test fails; restore → 3/3. Full `pnpm
  check` EXIT 0, `pnpm lint` 0/0.

## Decisions

- **Enums get descriptions too** — a `status` enum still needs a
  one-line "what each value means" so the model picks the right filter.
- No bullet flip — tool-calling reliability hardening of the
  tasks/reminders write actuators. With this, the high-traffic loopback
  surfaces (calendar 800, notes 801, fetch/context 809, tasks/reminders
  812) all pass the goal-799 validator. CAPABILITIES line under P20 /
  tool-calling.
