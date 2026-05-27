# 771 — feat: turnkey chrome-devtools auto-registration (P18 web-control)

## Why

After 770 a chrome-devtools server is correctly gated, but the user
still had to hand-write `~/.muse/mcp.json` with the exact npx package +
`--browser-url` + port. A daily-driver setup should be one env var.

## Slice

`assembleMcpStack`: when `MUSE_CHROME_DEVTOOLS_ENABLED=true`, append
`createChromeDevToolsMcpServer({ autoConnect: true, browserUrl })` to
`externalServerInputs` (browser URL from
`MUSE_CHROME_DEVTOOLS_BROWSER_URL`, default `http://127.0.0.1:9222`).
The existing seed path (`seedExternalMcpServers` + `manager.start()`)
then registers + connects it, and the assembly's
`withChromeDevToolsRisk` wrap (770) gates its state-changing tools. Skipped
if the user already declared `chrome-devtools` in mcp.json (no
duplicate).

## Verify

- `@muse/autoconfigure` mcp-stack-chrome-devtools.test.ts (new, 3):
  with `MUSE_CHROME_DEVTOOLS_ENABLED=true`, `externalServerInputs`
  contains a `chrome-devtools` stdio entry (`npx`, `--browser-url
  http://127.0.0.1:9222`, `autoConnect: true`);
  `MUSE_CHROME_DEVTOOLS_BROWSER_URL` is honoured; absent the flag the
  entry is NOT present (opt-in). (MCP config pointed at a missing file
  so the test ignores the machine's real mcp.json.)
- **Mutation-proven**: flipping the gate default `false → true`
  registers the preset by default → the opt-in test fails; restore →
  3/3.
- Full `pnpm check` EXIT 0 (autoconfigure 189, every workspace green);
  `pnpm lint` 0/0. Pure config assembly (synchronous), no model path →
  no `smoke:live`. The real seed/connect path is exercised by the
  assembly wiring test (770) + the manager's own tests.

## Decisions

- **Append to the seed path, don't bypass it** — reuses the proven
  `seedExternalMcpServers` + `manager.start()` connect flow + the
  fingerprint/allowlist gates; `autoConnect: true` so it connects at
  start like any mcp.json server.
- **Opt-in (`MUSE_CHROME_DEVTOOLS_ENABLED`, default off)** — driving
  the user's real logged-in browser is high-blast-radius; it must be a
  deliberate choice, never on by default. No bullet flip — P18 is
  already `[x]` + audited; this is the turnkey convenience wiring
  (CAPABILITIES line) atop the now-gated connector.
