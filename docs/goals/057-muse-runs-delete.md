# 057 — muse runs delete <run-id> — admin cleanup

## Why

AgentRunHistoryStore has no public delete path through the CLI. Add it
for operator cleanup.

## Scope

- New subcommand under muse runs.
- API + Kysely delete path.
- --before <iso> for bulk.

## Verify

- cli + api tests.

## Status

open
