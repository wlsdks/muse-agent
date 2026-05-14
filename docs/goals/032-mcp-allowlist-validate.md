# 032 — Validate MCP server names against allowlist before connect

## Why

Currently any name in mcp.json can be connected via McpManager. Although
the validators enforce URL/cmd safety, an allowlist of friendly names
adds defense-in-depth + makes mcp.json drift more visible.

## Scope

- McpSecurityPolicy.allowedServerNames already exists — verify it's
  enforced on every connect call path (not just policy checks).
- Add a unit test: a server name absent from allowedServerNames → connect
  rejects with structured error.
- Document the allowlist in CLAUDE.md or the rules file.

## Verify

- mcp package +2 tests.
- All gates green.

## Status

open
