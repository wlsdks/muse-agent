# 770 — feat: apply chrome-devtools fail-close risk in the real assembly (P18 web-control wiring + security gap)

## Why

`withChromeDevToolsRisk` (752) re-stamps chrome-devtools tools so the
approval gate fires on a state-changing action — but it was NEVER
wired into `createMuseRuntimeAssembly`. The assembly projected MCP
tools with a bare `() => mcp.manager.toMuseTools()`. So a real
chrome-devtools server added via `~/.muse/mcp.json` would expose its
`fill` / `submit` tools at the external server's UNTRUSTED default
risk (`read`) — UNGATED state-changing actions in the user's
logged-in browser. A built-but-unwired fail-close classifier is a
security gap, not just dead code.

## Slice

`@muse/autoconfigure`:
- The MCP tool supplier is now
  `() => withChromeDevToolsRisk(mcp.manager.toMuseTools())` — applied
  always; it only re-stamps `chrome-devtools.*` tools (fail-close:
  unknown / fill / click → write; evaluate_script / upload_file →
  execute), passing every other server's tools through untouched.
- `assembleMcpStack` + `createMuseRuntimeAssembly` gain an optional
  `mcpConnector` override (test-only seam) so the wiring is verifiable
  end-to-end against a contract-faithful fake connector.

So a chrome-devtools server connected via `~/.muse/mcp.json` is now
both reachable AND correctly gated.

## Verify

- `@muse/autoconfigure` chrome-devtools-assembly-wiring.test.ts (new,
  1): `createMuseRuntimeAssembly({ mcpConnector: fake })` → register
  `createChromeDevToolsMcpServer()` → connect through the fake (which
  reports BOTH tools as `read`, the untrusted default) →
  `assembly.toolRegistry.get("chrome-devtools.fill_form").risk` is
  `write` (re-stamped), `take_snapshot` stays `read`.
- **Mutation-proven**: reverting the supplier to the bare
  `toMuseTools()` leaves `fill_form` at `read` (ungated) → the test
  fails; restore → 1/1.
- Full `pnpm check` EXIT 0 (autoconfigure 186, every workspace green);
  `pnpm lint` 0/0. Contract-faithful fake connector through the REAL
  assembly registry — no model request/response path → no
  `smoke:live`.

## Decisions

- **Wrap the supplier (always-on), not gate it behind an env flag** —
  the re-stamp is a no-op for non-chrome tools, so applying it
  unconditionally is safe and means ANY chrome-devtools connection
  (mcp.json today, an auto-register preset later) is gated without
  extra configuration. The fail-close posture must not be opt-in.
- **`mcpConnector` is a test-only seam** — production always uses the
  real `DefaultMcpTransportConnector`. No bullet flip — P18 is already
  `[x]` + audited (757); this closes the assembly-wiring security gap
  the classifier needed (CAPABILITIES line). Auto-registering the
  chrome-devtools preset (vs hand-written mcp.json) is a convenience
  follow-on.
