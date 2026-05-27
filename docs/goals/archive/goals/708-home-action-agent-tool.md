# 708 — P17: the agent invokes the gated smart-home actuator as a tool — `createHomeActionTool` reuses the fail-closed `performHomeActionWithApproval`; confirm → HA service call / deny ⇒ no call. Completes "all actuators are gated agent tools"

## Why

P17's first slices made email send (706) and web action (707) agent
tools. This is the last actuator wrapper: smart-home. With it, all
three state-changing actuators are invokable by the agent
mid-conversation under the same fail-closed gate — flipping the P17
"other actuators are gated agent tools" bullet.

## Slice

- `packages/mcp/src/smart-home-tool.ts` (new): `createHomeActionTool`
  → a `MuseTool` (`home_action`, `risk: "execute"`, inputSchema
  `{service: "<domain>.<service>", entity?, data?}`) whose execute
  parses the service id and delegates to the proven
  `performHomeActionWithApproval` (HA service call, approval gate,
  action-logged). A malformed `service` (not `domain.service`) returns
  an error without firing. Exported from `@muse/mcp`.
- Registered into `createAgentRuntime` via the existing `ToolRegistry`.

## Verify

- `@muse/mcp` smart-home-tool.test.ts 4/4 — definition + execute
  CONFIRM (calls the HA service with `entity_id` body + `performed`
  log) / DENY (no call) / malformed-service (no call).
- **apps/api p17-home-action-tool-agent-seam.test.ts 2/2** — a REAL
  `createAgentRuntime` run with the tool registered + a sequence model
  that emits a `home_action` tool-call → CONFIRM fires one HA service
  POST (`/api/services/light/turn_off`) / DENY ⇒ 0 calls.
- **Clean-mutation-proven**: hardcoding `approved: true` inside the
  tool makes the DENY agent-path test fire. Restored; green.
- `pnpm check`: EXIT=0 (mcp + api + agent-core). `pnpm lint`: 0/0.
  `pnpm check:capabilities`: ✓. Byte-scan: clean.
- No LLM path touched — deterministic sequence provider; the HA call
  is HTTP-faked.

## Status

P17 "the OTHER actuators are gated agent tools" bullet FLIPPED (707
web + 708 home). All three state-changing actuators — email_send,
web_action, home_action — are now gated agent tools the agent can
invoke mid-turn, each reusing its proven fail-closed
`*WithApproval` orchestration. Next P17 step: wire these tools into a
live agent surface (`muse ask`/chat) with a real channel/CLI confirm
gate so a real conversation can trigger them.

## Decisions

- **Reuse `performHomeActionWithApproval`, don't re-gate** — same
  stance as the email/web tools; the agent path inherits the proven
  fail-closed orchestration, the tool is a thin arg-shaping wrapper.
- **Three small wrappers, not a generic factory** — email (resolves a
  contact), web (raw url+method+body), home (domain.service+entity)
  have genuinely different arg shapes, so a generic gated-tool factory
  would be awkward; three thin wrappers over the shared orchestrations
  is the honest amount of code (no premature abstraction).
- **`risk: "execute"`** — surfaced only in local mode; the gate is the
  confirmation point.

## Remaining risks

- **Production gate wiring** — all three tools take a caller-supplied
  approval gate; wiring it to a live channel/CLI confirm in a real
  agent surface (so an actual `muse ask` / chat turn prompts the user)
  is the next P17 step and the genuine end-user payoff.
- **Tools not auto-registered into a live runtime yet** — they're
  integration-proven; the productionisation (assembling them into the
  `muse ask`/chat runtime with the live gate + real providers from env)
  remains.
