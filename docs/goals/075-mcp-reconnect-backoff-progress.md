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

done — `McpHealthSnapshot` already carries
`reconnectAttempts` + `nextReconnectAt` (populated by
`McpManager.scheduleReconnect` via `nextReconnectAt(attempts)`
with exponential backoff). The missing piece was the CLI
surface. New `muse mcp status [--json]` subcommand calls
`GET /api/mcp/servers` and then per-server
`GET /api/mcp/servers/:name/health`, rendering each row as
`<name>\t<STATUS> [(reconnecting in Ns, attempt N)] [— error]`.

Healthy rows omit the reconnect clause entirely so the table
stays scannable; unhealthy rows show the seconds-until-next-
attempt + the attempt counter so an operator can see exactly
where the backoff ladder is.

cli +1 test wires a stub fetch for both the list + health
endpoints, asserts alpha (unhealthy) renders the "reconnecting
in Ns, attempt 2" clause + the error, and that beta (healthy)
omits the reconnect clause.
