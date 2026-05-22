# 750 — feat: first-class Chrome DevTools MCP connector (P18 web-control, slice 1)

## Why

P18 (human-directed 2026-05-23) is web control of the user's REAL
logged-in Chrome. Muse already has the full MCP machinery — stdio
transport, `McpManager`, security allowlist, command validation,
fingerprint pinning, and a Claude-Desktop-style `~/.muse/mcp.json`
loader. So a user *could* hand-write a chrome-devtools entry. But a
daily-driver assistant should make "connect my Chrome" a one call,
not hand-JSON with the exact package name, `--browser-url`, and port.

## Slice

`createChromeDevToolsMcpServer(options?)` in `@muse/mcp` — a preset
that returns the validated `McpServerInput` for the open-source
**Chrome DevTools MCP** (`ChromeDevTools/chrome-devtools-mcp`,
Apache-2.0): stdio, `npx chrome-devtools-mcp@latest --browser-url
<url>`, defaulting to `http://127.0.0.1:9222` so it ATTACHES to the
user's already-running, logged-in Chrome (launched with
`--remote-debugging-port=9222`) rather than spawning a fresh headless
browser. `autoConnect` defaults `false` (opt-in — it drives the real
browser). Exported from the package index.

`npx` is already in the default `allowedStdioCommands`, so the preset
connects under the standard security policy once `chrome-devtools` is
permitted by `allowedServerNames` (empty = allow all).

## Verify

- `@muse/mcp` chrome-devtools-mcp.test.ts (new, 5):
  - preset builds the expected stdio/npx config + default port; a
    custom `browserUrl` is honoured; the config passes
    `validateMcpServer` under the default policy.
  - **contract-faithful end-to-end at the manager seam**: a fake
    `McpConnection` exposing chrome-devtools-style read tools
    (`navigate_page`, `take_snapshot`) is registered + connected
    through the REAL `McpManager`; `toMuseTools()` projects
    `chrome-devtools.take_snapshot` (risk `read`) to the agent tool
    surface, and executing it returns the grounded LIVE-page snapshot.
  - allowlist-deny path: a policy excluding `chrome-devtools` →
    `register` returns undefined, status `disabled`, zero tools (the
    fail-closed gate, not just the happy path).
- **Mutation-proven**: flipping the default debugging port in the
  factory fails the preset test; restored → 5/5 green.
- `pnpm --filter @muse/mcp build` (tsc) EXIT 0; full `pnpm check`
  EXIT 0 (every workspace green, mcp 670); `pnpm lint` 0/0.
- No request/response (model) path changed, so no `smoke:live`.

## Decisions

- **Attach to the real Chrome by default (`--browser-url`), not a
  fresh browser** — P18's whole point is the logged-in session.
  Read / perceive is the default; any state-changing web action under
  the user's identity stays fail-close + draft-first per
  `outbound-safety.md`, and banking / payments are out of scope.
- **Did NOT flip the P18 read-first bullet.** This slice delivers the
  connector + proves the perception tool reaches the agent tool
  surface returning grounded content (contract-faithful). The bullet
  says "the agent ... answers a question grounded in the LIVE page"
  — flipping it waits for slice 2: an agent-run test (fake provider
  issuing the tool call) showing the snapshot flow into the response,
  and/or a real attach against Chrome on `:9222`. Honest partial
  progress, not a flip.
