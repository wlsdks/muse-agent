# Actuator modes — off / ask / auto

## The problem

`buildActuatorTools` (apps/cli/src/actuator-tools.ts, 609 lines) assembles the
tools that let Muse act on the world — `email_send` / `email_reply` /
`email_forward`, `web_action`, `home_action`, and the `mac_*` family.

The gap is narrower than "it is all dead", and the distinction decides the
design. Two halves:

- **Execution works.** `muse approvals approve <id>` calls
  `buildActuatorTools` (commands-approvals.ts:116), finds the tool named in the
  staged draft, and runs it. Claim/replay-guard, action log, and the deny path
  are all live.
- **Almost nothing feeds it.** Two producers of pending approvals exist.
  `actuator-tools.ts:344` stages when its own gate is non-interactive — but
  nothing hands those tools to a model, so it never runs. `muse mcp serve`
  (mcp-serve-tools.ts:142) genuinely stages, but its exposed set is
  `muse_recall` / `knowledge_search` / `calendar_read` / `tasks_read` /
  `user_model_read` / `propose_action` — read-only plus a generic proposal, and
  zero `OUTBOUND_SEND_TOOL_NAMES` members. So an external agent can propose,
  but Muse's own model can never call `email_send`.

  The entry point that once exposed these tools to Muse's model was
  `muse ask --with-tools --actuators`, which 612ed744c closed when `muse ask`
  became non-coding personal-read only.

So this is not "restore a dead subsystem". It is **one missing link: exposing
the tools to a model under a mode.** Everything downstream of the model
proposing a call already exists and is tested.

That also explains the empty action log measured on this machine: not a broken
path, and not merely an unconfigured channel — nothing can reach the stage
where a draft gets created.

## What already exists (do not rebuild)

| Piece | Where | What it gives us |
|---|---|---|
| Execution of a staged draft | `apps/cli/commands-approvals.ts:116` | `muse approvals approve` already builds the tools and runs the named one, with claim/replay-guard |
| Staging a draft | `actuator-tools.ts:344` (`recordPendingApproval`) | The non-interactive path already stages instead of failing |
| `ToolApprovalGate` | `agent-core/agent-runtime-types.ts:340` | The single seam every gated tool call passes through. `(input) => { allowed, reason? }` |
| Risk branch | `agent-core/agent-runtime-tool-call.ts:228` | `risk !== "read" && !approvalGate` already fail-closes |
| `OUTBOUND_SEND_TOOL_NAMES` | `agent-core/actuator-provenance-gate.ts:30` | **The third-party classification already exists** — `email_send`, `web_action`, `muse.messaging.send`, `objective.act` |
| Standing grants | `packages/policy/progressive-autonomy.ts` | `action` scope + `maxUses` + `expiresAt` + veto/undo |
| `performConsentedAction` | `packages/proactivity/consented-action.ts` | Fail-closed: no recorded consent ⇒ no HTTP call, ever |
| Provenance gate | `actuatorProvenanceWarning` | Flags sink args derived from untrusted tool output |
| Action log | `stores/personal-action-log-store.ts` | Hash-chained, append-only, records refusals too |

The mode work is **wiring**, not new safety machinery.

## The classification that drives everything

Not all actuators carry the same risk. The split is not `read/write/execute` —
it is **"can a mistake be taken back?"**

**Recoverable — no third party involved**
`home_action`, `mac_say`, `mac_clipboard_set`, `mac_screenshot`,
`mac_spotlight_search`, `mac_contacts_write`
A wrong call turns a light on, or writes a local record. You undo it.

**Irrecoverable — content lands in someone else's system**
`email_send`, `email_reply`, `email_forward`, `mac_message_send`,
submitting `web_action`
A wrong call puts a message the user did not write into another person's
inbox. There is no undo.

`OUTBOUND_SEND_TOOL_NAMES` already encodes most of this. This design extends
that list rather than inventing a parallel one — one classification, one place.

## The three modes

| Mode | Recoverable actuators | Third-party sends |
|---|---|---|
| `off` (default) | not exposed | not exposed |
| `ask` | confirm each call | confirm each call |
| `auto` | execute directly | **still confirm** — unless a standing grant covers it |

The last cell is the whole design. `auto` does not mean "send anything to
anyone". It means *"stop asking me about things I can undo"*, plus *"honour the
standing grants I already issued"*.

That keeps `outbound-safety.md`'s rule intact:

> Draft-first, never auto-send. The agent produces the exact content and the
> user explicitly confirms **that content** before it leaves.

A standing grant IS an explicit confirmation — bounded by action scope, use
count, and expiry, issued by the user in advance. What stays forbidden is an
unbounded auto-send on the agent's own judgement.

## Mode resolution

Precedence, highest first:

1. `MUSE_ACTUATOR_MODE` env (`off` | `ask` | `auto`) — per-invocation override
2. `actuators.mode` in `~/.config/muse/config.json` — the durable setting
3. `off`

`off` as the default is deliberate: a fresh checkout, or a config the user has
not touched, exposes no actuators. Opt-in, never opt-out.

**`MUSE_LOCAL_ONLY=true` forces third-party sends off regardless of mode.** The
local-only posture already refuses cloud egress; a send is egress.

## Gate behaviour

One gate function, `buildActuatorModeGate`, returns a `ToolApprovalGate`:

```
mode=off    -> allowed:false, "actuators are off (muse config actuators.mode)"

mode=ask    -> recoverable:  confirm prompt
               third-party:  draft-first confirm (exact content shown)

mode=auto   -> recoverable:  allowed:true
               third-party:  check standing grant for (action, recipient)
                             - grant covers it, uses remain, not expired
                                 -> allowed:true, consume one use
                             - otherwise -> draft-first confirm
```

Fail-close conditions, all of which deny:
- non-interactive session with no pending-approval stager
- confirm prompt cannot be delivered, is declined, or times out
- recipient does not resolve unambiguously (Rule 3, outbound-safety.md)
- provenance warning present AND mode=auto AND no explicit grant
  — a send whose recipient/body traces to untrusted tool output never
  auto-fires, in any mode

Every outcome — sent, refused, staged — appends to the action log with the
exact content, as today.

## Entry point

`muse ask` stays personal-read only; 612ed744c was a deliberate narrowing and
this design does not reopen it.

The actuators get exposed on the **agent-run surfaces** instead — the
CLI's agent path and `/api/chat` — through the existing
`CHANNEL_APPROVAL_EXPOSURE_ALLOWLIST` seam, which today lists only local
`muse.notes.*` / `muse.tasks.*` / `muse.calendar.*` / `muse.reminders.*`.
The allowlist gains the actuator names **only when mode !== off**, so the
exposed tool set is a function of the mode, not a static list.

This matters for tool-calling reliability (`tool-calling.md`: keep the exposed
set to ~5-7): in `off` the model never sees them, so nothing regresses for a
user who does not opt in.

## Build order

Each step lands green on its own.

1. **Mode setting** — resolver + precedence + `muse config` read/write.
   No behaviour change yet; `off` everywhere.
2. **Expose the tools to the model** behind `mode !== "off"`, gate hardcoded to
   `ask`. This is the missing link and it alone restores the capability: the
   model can propose a call, the gate confirms or stages it, and
   `muse approvals approve` already executes it.
3. **Risk-class split** — extend `OUTBOUND_SEND_TOOL_NAMES` to cover
   `email_reply` / `email_forward` / `mac_message_send`; gate branches on it.
4. **`auto` for recoverable** — mode=auto skips the confirm for the recoverable
   class only.
5. **Standing-grant path** — mode=auto consults `evaluateProgressiveAutonomy`
   for third-party sends; `muse autonomy grant` issues the scoped grant.

Steps 1-2 restore the feature. 3-5 add the auto half.

## Acceptance

Per `outbound-safety.md`, a send capability ships only when the test proves
the gate, not the happy path. Each step's acceptance:

- **deny / timeout / non-interactive / ambiguous-recipient produces NO external
  effect** — asserted against a contract-faithful HTTP fake, never a fake
  registry
- `mode=off` exposes zero actuator tools (assert the tool list, not the gate)
- `mode=auto` + third-party + no grant ⇒ still confirms
- `mode=auto` + expired/exhausted/scope-mismatched grant ⇒ still confirms
- provenance-warned send never auto-fires in any mode
- action log records the refusal path, hash chain intact
- `MUSE_LOCAL_ONLY=true` + `mode=auto` ⇒ third-party sends refused

Mutation check on the mode gate: forcing `allowed:true` must redden the
deny-path tests. A gate whose tests only cover the confirmed path is not
delivered.

## Open questions for the owner

1. **Grant granularity.** Per action class (`email_send` broadly), or per
   action+recipient (`email_send` to `kim@example.com`)? Narrower is safer and
   more annoying. Recommend action+recipient for sends, action-only for
   recoverable.
2. **`mac_contacts_write`** — classified recoverable here (writes a local
   record, undoable). Confirm that reading is right.
3. **Default for a fresh install** — `off` is proposed. If the owner wants
   `ask` out of the box, that is a one-line change but it means a fresh
   checkout can prompt to send email.
