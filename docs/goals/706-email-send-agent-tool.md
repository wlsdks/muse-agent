# 706 — P17 first slice: the agent invokes the gated email-send actuator as a tool inside an agent run — `createEmailSendTool` reuses the fail-closed `sendEmailWithApproval`; confirm → real Gmail send / deny / ambiguous ⇒ NO send

## Why

P11–P16 shipped the actuators as CLI surfaces + gated primitives, but
the AGENT couldn't invoke them mid-conversation. P17 (conversational
actuation) closes that — the north-star "companion that ACTS when
addressed". First slice: email send as an agent tool, inheriting the
SAME outbound-safety guarantees as `muse email send`.

## Slice

- `packages/mcp/src/email-tool.ts` (new): `createEmailSendTool(deps)`
  → a `MuseTool`:
  - definition `email_send`, `risk: "execute"` (so the runtime only
    exposes it in local mode), inputSchema `{to, subject, body}`;
  - execute resolves nothing itself — it delegates to the proven
    `sendEmailWithApproval` (recipient resolved via `resolveContact`,
    draft-first fail-closed approval gate, real `EmailSender.send`,
    action-logged), returning `{sent:true,to}` or `{sent:false,
    reason, detail, candidates?}`.
  - Exported from `@muse/mcp`.
- The tool is registered into `createAgentRuntime` via the existing
  `ToolRegistry` — no new runtime mechanism.

## Verify

- `@muse/mcp` email-tool.test.ts 4/4 — tool definition (name/risk/
  schema) + execute CONFIRM (resolves + sends + `performed` log) /
  DENY (no send) / AMBIGUOUS (no send, returns candidate names).
- **apps/api p17-email-tool-agent-seam.test.ts 3/3** — the P17 check:
  a REAL `createAgentRuntime` run with the tool registered + a
  sequence model that emits an `email_send` tool-call →
  - CONFIRM → exactly one real `GmailEmailProvider.send` POST
    (Bearer, `/messages/send`, HTTP faked & recorded);
  - DENY → 0 sends (the fail-closed gate blocks it through the agent
    path);
  - AMBIGUOUS recipient (two "Bob"s) → 0 sends even with an approving
    gate (never-guess holds via the agent path).
- **Clean-mutation-proven**: hardcoding `approved: true` inside the
  tool (ignoring the caller's gate) makes the DENY agent-path test
  send — so the tool genuinely threads the gate. Restored; green.
- `pnpm check`: EXIT=0 (cross-package: mcp + api + agent-core).
  `pnpm lint`: 0/0. `pnpm check:capabilities`: ✓. Byte-scan: clean.
- No LLM path touched — the agent run uses a deterministic sequence
  provider; the send is HTTP-faked. (Live use needs a real Gmail OAuth
  token + the production gate wired to a channel/CLI confirm.)

## Status

P17 first slice delivered: the agent can act on email mid-run, gated.
The bullet flips. Follow-ups (future P17 bullets): wire the approval
gate to a live channel/CLI confirm in production (so a real agent run
prompts the user), and expose the web-action / smart-home actuators as
gated agent tools too.

## Decisions

- **Reuse `sendEmailWithApproval`, don't re-gate** — the tool's execute
  delegates to the proven, mutation-tested orchestration, so the agent
  path inherits draft-first + fail-closed + resolve-or-clarify +
  action-log for free. No new gate logic.
- **`risk: "execute"`** — surfaced only in local mode, consistent with
  other state-changing tools; the approval gate (inside
  `sendEmailWithApproval`) is the confirmation point.
- **Tool in @muse/mcp** — it already depends on `@muse/tools` (for the
  `MuseTool` type) and owns the actuator; the agent-run integration
  test lives in apps/api (the layer that depends on both agent-core +
  mcp), like the prior P-seam tests.
- **Gate injected for the test** — the seam injects approve/deny;
  production wiring of the gate to a real channel confirm is a separate
  follow-up (the bullet's check is the integration with an injected
  gate).

## Remaining risks

- **Production gate not yet wired to a live confirm** — `email_send`'s
  approval gate is supplied by the caller; an agent run in production
  needs that gate routed to a real in-chat / CLI confirmation. Until
  then the tool is integration-proven but not auto-registered into a
  live agent surface.
- **Only email_send is a tool** — web-action / smart-home as gated
  agent tools are future P17 bullets.
