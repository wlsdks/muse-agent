# Goal 912 — `muse.tasks.add` can mark a task urgent (agent CRUD parity)

## Outward change

The agent-facing `muse.tasks.add` loopback MCP tool now accepts an
`urgent: true` parameter, so when the user tells Muse "add an urgent
task to pay rent today," the agent can create it as urgent — the
proactive watcher then fires it even during the user's quiet hours.
Before, the tool had no `urgent` field: the CLI `muse tasks add
--urgent` (875) could set it and every view surfaces it
(`serializeTask` already outputs it, `muse status` marks it ⚠ per 898),
but the agent's only way to CREATE a task couldn't mark one urgent —
so an agent asked for an urgent task silently produced a normal one.

## Why this, now

A create-side CRUD parity gap on the agent surface — the mirror of the
read-side parities this run (objectives 891/892, urgent-in-status
898). The urgent flag is fully plumbed everywhere EXCEPT the one tool
the model uses to add a task. Closing it lets the assistant honor
"this one's urgent" end-to-end instead of dropping the priority on the
floor. One optional field on an existing tool — no new tool, no
homonym, so one-shot selection is unaffected (per `tool-calling.md`).

## How

`createTasksMcpServer`'s `add` tool: read `urgent` (`args["urgent"]
=== true`), include `...(urgent ? { urgent: true } : {})` in the
created `PersistedTask`, add an `urgent` boolean to the `add`
inputSchema with a concrete "use when" description, and name it in the
tool description. The store already persists and serializes `urgent`,
so it round-trips through `list` unchanged. Omitting `urgent` produces
a normal task exactly as before.

## Verification

`packages/mcp` `mcp.test.ts` `muse.tasks loopback server` (`pnpm
--filter @muse/mcp test`, 939 passing): `add({title, urgent:true})` →
the returned + stored task carries `urgent:true`; a plain `add` does
NOT carry the flag; and `list({status:"all"})` round-trips the flag
(present on the urgent task, absent on the normal one). Mutation-proven:
dropping the `urgent` spread in the created task fails the round-trip
assertion; restored green. `pnpm check` green (mcp 939, apps/cli alone
1635, apps/api 323; the 2 parallel-suite failures are the known
voice-playback flake); `pnpm lint` 0/0.

`[UNVERIFIED-LIVE]`: the deterministic handler (sets/persists/serializes
`urgent`) is fully verified, but the field is part of the tool schema
the local model sees, so whether Qwen correctly populates `urgent:true`
from a natural "make it urgent" request is a `smoke:live` tool-call
check that could NOT run — Ollama is unreachable this session. The
moment it's up, `smoke:live` should assert the model fills `urgent`.

## Decisions

- Optional `urgent` (default normal) rather than required — matches the
  CLI `--urgent` flag's opt-in shape, and an unmarked task must stay a
  normal task.
- Did not add an `urgent` toggle to a separate "edit task" tool —
  there is no task-edit tool yet, and the create path is where the
  priority is naturally expressed; a later edit tool is its own slice.
