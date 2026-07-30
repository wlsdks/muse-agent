# @muse/mcp

The Model Context Protocol layer: the transport connector and connection manager for external
MCP servers, OAuth 2.1 support, Muse's own loopback MCP servers, and Muse-as-an-MCP-server. It
is a package because MCP transport, security policy (allowlist, OSV malware check), and the
`MuseTool` projection all need to live behind one seam that both directions (Muse-as-client and
Muse-as-server) share.

## Public surface

- `McpManager` — the runtime registry: register/connect/list tools against configured servers,
  applying `McpSecurityPolicy` at both register and connect time.
- `DefaultMcpTransportConnector`, `createRemoteRequestInit` — the stdio/SSE/streamable/HTTP
  transport connector.
- `MuseMcpOAuthProvider`, `runMcpOAuthLogin`, `startOAuthCallbackServer` — OAuth 2.1 client
  support for remote MCP servers.
- `createMcpMuseTool` — projects an `McpRemoteTool` into a `MuseTool`.
- `createLoopbackMcpConnection`, `createLoopbackMcpMuseTools` — Muse's own in-process loopback
  MCP servers (no external process).
- `createMuseToolsMcpServer`, `runStdioMcpServer` — Muse acting AS an MCP server over stdio.
- `createGitHubMcpServer`, `createNotionMcpServer`, `createLinearMcpServer`,
  `createSentryMcpServer`, `createAtlassianMcpServer`, `createChromeDevToolsMcpServer` — the
  official third-party MCP presets.
- `auditMcpServerConfig`, `checkPackageForMalwareAdvisory` — static config audit and live OSV
  malware-advisory preflight for a candidate MCP server.
- `validateMcpServer`, `isPrivateOrReservedHost` — SSRF-guarding server/URL validation.

## Depends on

- `@modelcontextprotocol/sdk` — the vendor-neutral MCP client/server SDK this package wraps.
- `@muse/tools` — the `MuseTool`/`ToolRisk` contract an MCP tool is projected into.
- `@muse/stores` — persistence for OAuth tokens and MCP server/security-policy rows.
- `@muse/db`, `kysely` — the `Kysely*Store` implementations for server/security-policy state.
- `@muse/mcp-shared`, `@muse/resilience`, `@muse/shared` — shared retry helpers and types.

## Rules that bind this package

- [`../../.claude/rules/architecture.md`](../../.claude/rules/architecture.md) — `McpSecurityPolicy.allowedServerNames` is the
  allowlist gate this package enforces at both register and connect time (goal 032).
- [`../../.claude/rules/outbound-safety.md`](../../.claude/rules/outbound-safety.md) — a loopback tool that sends/acts toward a third
  party still goes through the same draft-first, approval-gated contract as any other tool.

## Tests

```bash
pnpm --filter @muse/mcp test
```
