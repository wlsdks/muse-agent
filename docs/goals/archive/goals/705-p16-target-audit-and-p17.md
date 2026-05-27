# 705 — P16 target-completion audit (the P→P seam check) + extend OUTWARD-TARGETS with P17

## Why

P16 (lifestyle/smart-home) was the LAST `[x]`-but-unaudited target of
the human-authored P11–P16 actuator map. Per the iteration-loop
PROCEDURE Step 4, this iteration's mandate is the P16 audit. With it,
the whole P11–P16 map (and P0–P16) is delivered + audited, so the loop
also extends OUTWARD-TARGETS toward the north star (the loop "extends
this map itself when all are delivered").

## P16 audit — verify (re-run green TOGETHER)

- `@muse/mcp` smart-home.test.ts 4/4 — `buildHomeAssistantServiceCall`
  (URL trim + `entity_id` body + Bearer + data-merge) +
  `performHomeActionWithApproval` (CONFIRM → one real HA service POST +
  `performed` log; DENY → 0 calls).
- `@muse/cli` commands-home.test.ts 3/3 — `muse home call` confirm →
  done; deny → no call, exit 1; malformed `domain.service` → no call.
- `pnpm check:capabilities` ✓; lint clean (no source change).

The HA request builder → the shared fail-closed
`performWebActionWithApproval` gate → the `muse home call` surface chain
composes. No live external HA call (real device + safety, local-only —
the contract-faithful recording-fetch IS the named check). No drift; no
bullet reopened.

## Status

**P16 audit: PASS.** And with it: **P0–P16 are ALL delivered +
audited.** The human-authored P11–P16 actuator-breadth map (email,
weather, contacts, docs, web-actions, lifestyle) is fully delivered,
every outbound/state-changing actuator behind the fail-closed
`outbound-safety.md` gate, and every target seam-audited.

## P17 — the next target (loop-authored)

The P11–P16 actuators are CLI surfaces + gated primitives, but the
AGENT can't yet invoke them mid-conversation — "email Bob the Q3
summary" / "turn off the lights" don't reach `sendEmailWithApproval` /
`performWebActionWithApproval` / `performHomeActionWithApproval` from a
chat/ask turn. That is precisely the north-star gap: **a companion that
ACTS when addressed**, not a set of commands the user types.

P17's first bullet: the agent invokes ONE gated actuator (email send)
as a tool inside an agent run — recipient resolved via `resolveContact`,
the fail-closed approval gate fires, confirm → (HTTP-faked) send /
deny/timeout/ambiguous ⇒ no send. `@muse/tools` is zero-IO, so this is
a runtime-registered / MCP-bridged tool whose approval routes through
the existing `toolApprovalGate` / channel-approval seam.

## Decisions

- **Extend toward conversational actuation, not more actuator breadth**
  — adding a 7th actuator (music/health) is more of the same; the
  higher-leverage north-star move is making the agent USE the actuators
  it already has, gated, when the user asks. That closes the
  "command-parser → companion that acts" gap.
- **Reuse the existing gate seam** — P17 must not invent a new approval
  path; the `toolApprovalGate` (agent runtime) + the actuators'
  fail-closed `*WithApproval` orchestrations already exist, so P17 wires
  them together rather than re-gating.
- **Audit is steering upkeep** — `docs(loop)`, not a counted iteration;
  the P17 extension is a direction refinement, not a feature (its first
  slice is the next building iteration).

## Next

Resume building: P17 first slice — an email-send agent tool, gated,
integration-proven (deny/timeout/ambiguous ⇒ no send).
