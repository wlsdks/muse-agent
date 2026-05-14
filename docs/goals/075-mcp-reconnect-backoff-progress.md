# 075 — MCP reconnect backoff progress reporting

## Why

When McpManager retries an external MCP server with exponential
backoff, surface the next-attempt-at timestamp so muse mcp status shows
'reconnecting in 8s' instead of just 'disconnected'.

## Scope

- McpReconnectPolicy already exposes nextReconnectAt.
- Verify it's surfaced in McpManager health snapshots.
- CLI display in muse mcp status.

## Verify

- mcp + cli tests.

## Status

open
