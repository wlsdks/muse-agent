# 711 — P17 hardening: `muse ask --actuators` shows an armed-state banner with config hints, so the user sees what state-changing powers are live before the turn

## Why

709 wired the gated actuators into `muse ask --with-tools --actuators`,
but the surface was silent about WHICH actuators it armed: with no
`MUSE_GMAIL_TOKEN` the agent simply can't email, and the user got no
signal why or how to fix it. For a state-changing surface that's both a
UX gap and a safety-awareness gap — the user should see exactly which
powers are live before the conversation can use them.

## Slice

- `apps/cli/src/actuator-tools.ts`: `summarizeActuators(env)` →
  `{ armed, unavailable: [{name, hint}] }` (web_action always; email_send
  iff `MUSE_GMAIL_TOKEN`; home_action iff `MUSE_HOMEASSISTANT_URL` +
  `MUSE_HOMEASSISTANT_TOKEN`), plus `formatActuatorBanner(summary)` →
  the stderr banner (armed list + confirm-safety reminder + one hint
  line per unavailable actuator).
- `apps/cli/src/commands-ask.ts`: when `--actuators` is active, emit the
  banner to stderr before building the tools / running the agent.

## Verify

- `@muse/cli` actuator-tools.test.ts (1225 cli tests) — summarizeActuators
  armed/unavailable+hints for no-env / all-env / HA-needs-both; a
  **drift-lock** asserting the armed set always equals the names
  `buildActuatorTools` actually constructs (so the banner can never claim
  a capability the agent lacks); formatActuatorBanner content + trailing
  newline.
- **Dog-fooded**: `node apps/cli/dist/index.js ask --with-tools
  --actuators "test"` printed `(actuators armed: web_action — …fires
  only on your confirm)` + the email_send / home_action hint lines, then
  the agent ran with web_action armed.
- `pnpm check`: EXIT=0. `pnpm lint`: 0/0. `pnpm check:capabilities`: ✓.
- No LLM request/response behavior changed — the banner is emitted
  before the agent run; `smoke:live` is not the relevant gate.

## Decisions

- **Pure `summarizeActuators` separate from `buildActuatorTools`, locked
  by a drift test** — the banner's env→armed logic and the tool-builder's
  env→tool logic must never diverge, so a test pins them equal across
  every env permutation rather than sharing a fragile abstraction.
- **stderr, matching the grounding-banner convention** — diagnostics go
  to stderr so `muse ask … > out.txt` / `| jq` keep a clean stdout.
- **No new OUTWARD-TARGETS bullet** — this hardens the already-complete
  + audited P17 live-actuation surface; it deepens an existing target
  rather than opening a new one.
