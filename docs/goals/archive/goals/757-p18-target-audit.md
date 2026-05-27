# 757 — P18 target-completion audit (the P→P seam check)

## Why

Both P18 bullets are `[x]` and no `P18 audit —` line existed. Per the
iteration-loop contract Step 4, the sole mandate of this iteration is
to re-run the P18 CAPABILITIES checks TOGETHER AND exercise P18 as one
end-to-end user flow against the falsifiable test — does the whole
web-control capability actually work for the user, not just each piece
in isolation?

P18 shipped in two separate slices: read-first perception (750
connector + 751 agent-grounded answer) and gated state-changing action
(752 fail-close risk classifier). The seam never proven before this
audit: do perceive + gated-act COMPOSE in ONE run?

## Verify

- New seam: `@muse/autoconfigure` p18-seam.test.ts 1/1 — drives the
  whole real stack (`createChromeDevToolsMcpServer` →
  `McpManager.toMuseTools()` → `withChromeDevToolsRisk` →
  `ToolRegistry` → `createAgentRuntime` + `toolApprovalGate`) in ONE
  run: the agent calls `take_snapshot` (read → gate allows → the live
  page reaches the browser) THEN `fill_form` (re-stamped write → gate
  denies → `callTool` never fires); both risk classes hit the gate in
  the same run.
- Piece-checks re-run green TOGETHER: @muse/mcp chrome-devtools-mcp.test.ts
  9/9; @muse/autoconfigure chrome-devtools-agent-run + gated-action +
  p18-seam 5/5.
- `pnpm check` EXIT 0 (autoconfigure 172, every workspace green);
  `pnpm lint` 0/0. Test-only audit, no source change; deterministic
  provider + transport-faked connection → no `smoke:live`.

## Status

PASS. P18's two bullets compose: the user can, in one web-control
flow, have the agent PERCEIVE the live logged-in page AND attempt a
state-changing action that is fail-close gated draft-first — the read
reaches the browser, the unapproved submit does not. No drift; no
bullet reopened. Recorded `P18 audit — … — PASS` in the README
Rejected ledger.
