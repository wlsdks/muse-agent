# 256 — `muse.tasks.list` MCP tool buried imminent deadlines from the agent

## Why

Goal 255 fixed `muse today`, and an earlier change fixed
`muse tasks list` (CLI) — both now order open tasks via
`compareTasksByDueDate` (due-soonest first), the comparator
written specifically because "the previous default (creation-date
desc) buried last week's hard deadline behind today's quick
capture".

The `muse.tasks.list` **loopback MCP tool** — the path the agent
itself calls when a user asks "what should I focus on?" / "what's
urgent?" — was the one open-task list still on the buried
ordering:

```ts
.filter((task) => status === "all" || task.status === status)
.sort((left, right) => (right.createdAt ?? "").localeCompare(left.createdAt ?? ""))
.slice(0, maxListEntries)
```

createdAt-desc, then `slice(maxListEntries)`. So when a local
Qwen agent reasons about priorities it received tasks
newest-created-first, with an imminent deadline created weeks ago
sorted last and — past the slice cap — dropped from the tool
result entirely. The tool description even advertised "List tasks
newest-first", which is the wrong default for a JARVIS that is
supposed to be urgency-aware. The agent's prioritisation is only
as good as the order/content this tool returns.

## Scope

`packages/mcp/src/loopback-tasks.ts`:

- Import `compareTasksByDueDate` from `./personal-tasks-store.js`
  (the comparator `muse tasks list` and `muse today` already
  use).
- The `muse.tasks.list` tool now `.sort(compareTasksByDueDate)`
  before `.slice(maxListEntries)` — due-soonest first, undated
  last (createdAt-desc within the undated bucket), so the slice
  keeps the most due-relevant entries. Tool description and the
  file-header comment updated from "newest-first" to
  "due-soonest first (undated last)" so the contract docs match.
- `muse.tasks.search` is deliberately left newest-first: a
  substring search ranking by recency is a defensible distinct
  contract, and a single coherent change keeps scope tight. Only
  the "what do I have / what's urgent" `list` path is realigned.

## Verify

- `pnpm --filter @muse/mcp test` — 342 pass (was 341; +1). New
  test plants four tasks (imminent-due created long ago,
  recent far-due, new undated, old undated) and asserts
  `muse.tasks.list` returns `["t_soon", "t_far", "t_new_undated",
  "t_old_undated"]`. The existing add→list→complete→search
  lifecycle + error tests stay green (they assert
  total/status/search, unaffected).
- `pnpm check` — every workspace green (mcp 342, apps/cli 557,
  apps/api 155, all packages). `pnpm lint` — exit 0.
- Real-LLM round-trip (agent-facing MCP tool path touched):
  `muse ask --with-tools` on Ollama `qwen3:8b`, reasoning off
  (isolated HOME, mixed-due tasks.json) — the agent called the
  tools, grounded on both tasks, and answered "do the tax filing
  first because it is due today", correctly prioritising the
  imminent-due task that createdAt-desc had buried. Confirms the
  agent path is not regressed and the fix delivers its intended
  effect. (A minor confabulated `[task: …]` citation in the
  reply is a known qwen3:8b artifact, unrelated to this
  deterministic ordering change.)

## Status

done — every open-task list surface (CLI `muse tasks list`, the
`muse today` briefing, and now the agent-facing
`muse.tasks.list` MCP tool) is consistently due-soonest first, so
the agent prioritises real deadlines instead of recent trivia
when answering "what's urgent?".
