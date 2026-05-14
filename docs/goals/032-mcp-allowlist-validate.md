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

done — verified: the allowlist gate IS enforced at both
register-time (existing test) AND connect-time (`McpManager.connect`
calls `securityPolicyProvider.isServerAllowed` before connector
invocation). Lock-in test added for the connect path: pre-seeds a
server name absent from the allowlist via direct store.save,
then asserts `connect()` returns false + status flips to
`"disabled"`. Empty-allowlist-means-all-allowed convention also
locked. Architecture rule doc updated with the two-layered
enforcement note. mcp +1 test.
