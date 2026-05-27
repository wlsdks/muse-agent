# 751 — test: the agent answers grounded in the live Chrome page (P18 read-first FLIP)

## Why

750 shipped the Chrome DevTools MCP connector and proved the
perception tool reaches the agent tool surface (manager seam). It
deliberately did NOT flip the P18 read-first bullet, whose wording is
"the agent ... answers a question grounded in the LIVE page content."
That end-to-end — the snapshot flowing through the model loop into a
grounded answer — was the missing proof. This slice supplies it.

## Slice

`packages/autoconfigure/test/chrome-devtools-agent-run.test.ts`: an
end-to-end run through the REAL stack —
`McpManager.toMuseTools()` → `ToolRegistry` → `AgentRuntime.run()`.
A fake model provider issues a tool call to
`chrome-devtools.take_snapshot` (turn 1), then GROUNDS its final
answer (turn 2) in the tool-result message it actually received from
the request — not a hard-coded string. The Chrome side is a
contract-faithful fake `McpConnection` returning a live-page snapshot.

Asserts: `result.toolsUsed` contains `chrome-devtools.take_snapshot`,
and `result.response.output` contains the live snapshot's facts
("invoice from Acme due Friday", "standup at 14:00") — i.e. the live
content reached the model input and the answer is grounded in it.

## Verify

- `@muse/autoconfigure` chrome-devtools-agent-run.test.ts (new, 1):
  green end-to-end.
- **Mutation-proven against REAL code**: stubbing `createMcpMuseTool`'s
  `execute` to stop forwarding the connection result (then rebuilding
  `@muse/mcp`) makes the answer ungrounded → test fails; restore +
  rebuild → green. (Cross-package tests import the built `dist`, so
  the mutation only bites after a rebuild — verified both ways.)
- Full `pnpm check` EXIT 0 (autoconfigure 164, mcp 670, every
  workspace green); `pnpm lint` 0/0.
- The model provider is a local fake (no real LLM round-trip changed),
  so no `smoke:live` — the slice exercises the tool-loop wiring, not a
  provider request/response change.

## Decisions

- **Test-only slice that legitimately flips the bullet.** The
  capability (live-page perception via the projected MCP tool) already
  exists; the read-first bullet's flip condition was an end-to-end
  surface check showing the agent answers grounded. That check now
  exists and is green + mutation-proven, so P18 read-first flips.
- **Home = `@muse/autoconfigure`** — the only package that deps on both
  `@muse/mcp` (tool projection) and `@muse/agent-core` (AgentRuntime);
  agent-core stays mcp-free.
- Real attach to a live Chrome on `:9222` remains the operator step;
  the contract-faithful fake at the transport seam is exactly what the
  bullet's check specifies.
