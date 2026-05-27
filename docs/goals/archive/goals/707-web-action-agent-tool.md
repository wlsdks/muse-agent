# 707 — P17: the agent invokes the gated web-action actuator as a tool — `createWebActionTool` reuses the fail-closed `performWebActionWithApproval`; confirm → request fires / deny ⇒ no request

## Why

P17's first slice (706) made email send an agent tool. This extends
conversational actuation to the web-action actuator: the agent can act
on "book a table at 7pm" mid-turn, gated identically. Same pattern,
same fail-closed guarantee.

## Slice

- `packages/mcp/src/web-action-tool.ts` (new): `createWebActionTool`
  → a `MuseTool` (`web_action`, `risk: "execute"`, inputSchema
  `{summary, url, method?, body?}`) whose execute delegates to the
  proven `performWebActionWithApproval` (draft-first approval gate,
  action-logged); returns `{performed,status}` or `{performed:false,
  reason,detail}`. Exported from `@muse/mcp`.
- Registered into `createAgentRuntime` via the existing `ToolRegistry`
  — no new runtime mechanism.

## Verify

- `@muse/mcp` web-action-tool.test.ts 4/4 — definition (name/risk/
  schema) + execute CONFIRM (fires + `performed` log) / DENY (no
  request) / missing-url-or-summary (no request).
- **apps/api p17-web-action-tool-agent-seam.test.ts 2/2** — a REAL
  `createAgentRuntime` run with the tool registered + a sequence model
  that emits a `web_action` tool-call → CONFIRM fires one recorded
  request / DENY ⇒ 0 requests (the fail-closed gate blocks it through
  the agent path).
- **Clean-mutation-proven**: hardcoding `approved: true` inside the
  tool (ignoring the caller's gate) makes the DENY agent-path test
  fire — so the tool threads the gate. Restored; green.
- `pnpm check`: EXIT=0 (mcp + api + agent-core). `pnpm lint`: 0/0.
  `pnpm check:capabilities`: ✓. Byte-scan: clean.
- No LLM path touched — deterministic sequence provider; the request
  is HTTP-faked.

## Status

P17 advanced: email_send (706) + web_action (707) are gated agent
tools. The new P17 bullet ("the OTHER actuators are gated agent
tools") stays `[ ]` pending `createHomeActionTool` (smart-home) — the
final wrapper, next iteration — after which it flips.

## Decisions

- **Reuse `performWebActionWithApproval`, don't re-gate** — same stance
  as the email tool: the agent path inherits the proven fail-closed
  orchestration; the tool is a thin arg-shaping wrapper.
- **`risk: "execute"`** — surfaced only in local mode; the approval
  gate is the confirmation point.
- **One actuator per slice** — kept the slice tight (web only); the
  smart-home tool is the next, completing the bullet.

## Remaining risks

- **Smart-home tool not yet done** — `createHomeActionTool` is the last
  wrapper to flip the new P17 bullet.
- **Production gate wiring** — like 706, the gate is caller-supplied;
  wiring it to a live channel/CLI confirm in a real agent surface is a
  separate follow-up.
- **No agent surface auto-registers these tools yet** — they're
  integration-proven; auto-registering them into `muse ask`/chat with a
  live gate is the productionisation step.
