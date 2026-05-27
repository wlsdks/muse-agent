# Goal 900 — `muse.status` MCP tool surfaces the session DND lock

## Outward change

The agent-facing `muse.status` loopback MCP tool's `snapshot` now
returns `session: { dnd, until }` — the same Do-Not-Disturb state
goal 899 added to the human `muse status` CLI. Before, an external
agent (Codex / Claude Desktop over the stdio bridge) reasoning "should
I notify the user / what's their state?" could see tasks, objectives,
reminders, followups — but was **blind to whether proactive notices
were paused**. So an agent could nudge the user mid-focus-block
without knowing the user had explicitly silenced Muse.

## Why this, now

A cross-surface parity seam — the exact symmetric follow-up to 899
(and the same shape 892 used to add objectives to the tool after 891
added them to the CLI). The session lock governs the proactive
daemon, `muse session status` reports it, the human dashboard now
shows it (899) — but the agent-facing snapshot, the one surface an
external AI actually consults before deciding to interrupt, still
omitted it. DND that the human can see but the agent can't is a real
signal loss exactly where it matters most.

## How

`createStatusMcpServer` gains a `sessionLockFile?` option
(defaulting to `~/.muse/session-lock.json`) and reads it via
`readSessionLock(file, now)` — the same helper the proactive loop,
`muse session status`, and `muse status` (899) use, so the tool's
notion of "active" matches exactly what silences the daemon
(including expiry: expired / missing / corrupt → `undefined`, so no
stale "DND on"). The snapshot gains `session: { dnd, until }`
(additive). The tool description now names the DND field so the
local model knows to consult it. Pure file IO — no model call, no
daemon, sub-100ms.

## Verification

`packages/mcp` `mcp.test.ts` `muse.status loopback server`: seeds a
temp `session-lock.json` with a future `until`, passes
`sessionLockFile` to `createStatusMcpServer`, asserts
`snap.session.dnd === true` + the exact `until`. Mutation-proven:
neutralizing the snapshot `session` field (hardcoded `dnd:false`)
fails the assertion; restored green. `pnpm --filter @muse/mcp test`
930 passed; `pnpm check` green (apps/cli 1566, apps/api 323);
`pnpm lint` 0/0. No LLM path → no smoke:live (Ollama down regardless).

## Decisions

- Reused `readSessionLock` rather than re-parsing the lock file
  ad-hoc — so the agent-facing tool, the human CLI, and the daemon
  all agree on "is DND active right now" with identical expiry
  semantics.
- `session.until` is `null` (not omitted) when no lock is active,
  matching the always-present-bool shape 898 chose for `urgent` so
  the tool's snapshot stays field-stable across calls.
