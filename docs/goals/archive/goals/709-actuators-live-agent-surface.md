# 709 — P17: the gated actuators reach a LIVE agent surface — `muse ask --with-tools --actuators` exposes email_send / web_action / home_action to the model, each carrying a clack confirm as its fail-closed gate

## Why

706/707/708 made the three state-changing actuators agent tools and
proved each fail-closed through a real `createAgentRuntime` run — but
no live surface registered them, so a real `muse ask` conversation
still couldn't trigger them. That gap WAS the genuine end-user payoff
called out in each of those goals' "Remaining risks". This wires them
into the live `muse ask --with-tools` runtime, off by default, behind
`--actuators`, with a real CLI confirm.

## Slice

- `apps/cli/src/actuator-tools.ts` (new): `buildActuatorTools({env, io,
  userId, confirmAction?, fetchImpl?})` returns the env-configured
  actuator `MuseTool`s — `web_action` always; `email_send` iff
  `MUSE_GMAIL_TOKEN`; `home_action` iff `MUSE_HOMEASSISTANT_URL` +
  `MUSE_HOMEASSISTANT_TOKEN`. Each is built with a clack `confirm` gate
  (shows the exact draft) wrapping the proven `*WithApproval`
  orchestration. `confirmAction` is injectable so the gate threading is
  testable without a TTY.
- `packages/autoconfigure` `createMuseRuntimeAssembly` gained
  `ApiServerAssemblyOptions.extraTools` — caller-supplied tools merged
  into the `DynamicToolRegistry`. The CLI uses this to inject tools that
  carry an INTERACTIVE gate, which must not live in the shared, headless
  assembly.
- `apps/cli/src/commands-ask.ts`: `--actuators` option (only meaningful
  with `--with-tools`); when set, build the actuator tools and pass them
  as `extraTools`, and set `metadata.localMode: true` for that run so
  the `execute`-risk tools are exposed. `localMode` is set ONLY under
  `--actuators`, so no other `execute`-risk surface (e.g. an opt-in
  runner) is newly exposed by this flag.

## Verify

- `@muse/cli` actuator-tools.test.ts 6/6 — env→toolset selection (web
  only / +email / +home only with both HA vars); every actuator is
  `execute`-risk; **a REAL `createAgentRuntime` run** where the model
  emits a `web_action` tool-call → CONFIRM fires one recorded request /
  DENY ⇒ 0.
- **Clean-mutation-proven**: replacing the web gate with a hardcoded
  `{ approved: true }` (ignoring `confirmAction`) makes the DENY test
  fire. Restored; green.
- `@muse/autoconfigure` autoconfigure.test.ts — `extraTools` merged
  into `toolRegistry` (present with, absent without).
- `pnpm check`: EXIT=0 (all workspaces; api 291, cli 1215).
  `pnpm lint`: 0/0. `pnpm check:capabilities`: ✓ (52 lines).
- No LLM request/response path touched — the agent run uses a
  deterministic sequence provider; the request is HTTP-faked. The clack
  default confirm is thin glue over the gate seam already proven by
  706/707/708.

## Status

P17 "the gated actuators are reachable from a LIVE agent surface"
bullet FLIPPED. A real `muse ask --with-tools --actuators "email Bob
the summary"` turn can now reach `email_send` / `web_action` /
`home_action`, each gated by a CLI confirm — the conversational
actuation north-star, end to end and opt-in.

## Decisions

- **`extraTools` injection, not actuators-in-the-shared-assembly** —
  the runtime gate is fail-OPEN when absent (`agent-runtime.ts`: `if
  (approvalGate)`), and the headless assembly wires none. Putting
  auto-approve actuators there would create an ungated send on the API
  surface. Instead the CLI builds the tools WITH a real clack gate and
  injects them only into its own run. The gate lives where the human is.
- **`localMode` only under `--actuators`** — `createRunnerTools`
  returns `[]` unless `MUSE_RUNNER_ENABLED` (default off) and skills are
  gated too, so the default registry has no other `execute`-risk tools;
  scoping `localMode` to the flag keeps the exposure to exactly the
  actuators the user opted into.
- **Reuse the existing CLI confirm + env resolution** — same
  `confirm`/`isCancel` pattern and `resolveActionLogFile` /
  `resolveContactsFile` / `GmailEmailProvider` wiring as `muse email
  send` / `muse home call`, so the agent path inherits the identical
  outbound-safety behaviour the direct commands already prove.

## Remaining risks

- **No remote/server surface yet** — this wires the CLI (`muse ask`).
  The API/chat-stream surface would need its own channel-approval gate
  (the `toolApprovalGate` seam exists); that's a separate follow-up,
  not blocked by this.
- **Clack confirm itself is not auto-tested** — it is thin glue over
  the injectable `confirmAction`; the gate semantics are proven via the
  injected deny/approve path here and in 706/707/708.
