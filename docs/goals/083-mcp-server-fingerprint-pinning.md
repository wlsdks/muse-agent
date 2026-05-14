# 083 — Pin sha256 fingerprint per external MCP server binary

## Why

Goal 032 added an allowlist of MCP server names but the binary
the name resolves to is still implicit (whatever `command` /
`args` say). A package-manager swap, a typosquatted binary on
PATH, or a stale local build can change what the agent actually
calls without changing the registered name. Add an optional
sha256 fingerprint per server; on connect we hash the resolved
binary + first argv element and refuse on mismatch.

## Scope

- Extend `McpExternalServerInput` with optional
  `fingerprintSha256`. When set, `McpManager.connect` hashes the
  command file (or the stdin bytes for `node`-style invocations
  by hashing the entrypoint script) and refuses on mismatch.
- `muse mcp pin <name>` records the current hash so an operator
  can lock the registration after manual review.
- Mismatch flips the server to `disabled` + writes a
  diagnostic entry like the allowlist denial does.

## Verify

- mcp +2 tests: matching fingerprint connects; mismatch is
  refused without exception; missing fingerprint behaves as
  today (no enforcement).

## Status

open
