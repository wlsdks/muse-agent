# 698 — P16 COMPLETE (and the P11–P16 actuator map fully delivered): opt-in Home Assistant smart-home control, every service call confirmation-gated — `buildHomeAssistantServiceCall` + `performHomeActionWithApproval` + `muse home call`; absent approval ⇒ no effect

## Why

P16 is the lifestyle-actuator umbrella; the bullet asks for ONE opt-in
provider landing end-to-end with every state-changing action
approval-gated. Home Assistant is the cleanest free, local, no-SDK
choice: a local REST API (`POST /api/services/<domain>/<service>`,
long-lived Bearer token), HTTP so it's contract-faithfully fakeable.
Every service call routes through the already-proven fail-closed
`performWebActionWithApproval` gate (697). Banking / payments are NOT a
lifestyle actuator and stay out of scope.

## Slice

- `packages/mcp/src/smart-home.ts` (new):
  - `buildHomeAssistantServiceCall(call)` — pure builder → the
    `(summary, request)` for a HA service call: `POST
    <baseUrl>/api/services/<domain>/<service>`, `Authorization: Bearer
    <token>`, body = `{ entity_id, ...data }`.
  - `performHomeActionWithApproval(opts)` — builds the call and routes
    it through `performWebActionWithApproval` (fail-closed gate +
    action-log), so a smart-home action is gated identically to every
    other outbound action.
- `apps/cli/src/commands-home.ts` (new): `muse home call
  <domain.service> --entity <id> [--data <json>]` — opt-in via
  `MUSE_HOMEASSISTANT_URL` + `MUSE_HOMEASSISTANT_TOKEN`; default gate
  prints the action + a `@clack/prompts` confirm; deps injectable for
  tests; validates the `domain.service` shape + `--data` JSON.

## Verify

- `@muse/mcp` smart-home.test.ts (4): `buildHomeAssistantServiceCall`
  (URL trim + `entity_id` body + Bearer + data-merge);
  `performHomeActionWithApproval` CONFIRM → exactly one real HA POST
  (Bearer, `entity_id` body) + `performed` log; DENY/absent ⇒ 0 calls.
- `@muse/cli` commands-home.test.ts (3): confirm → done; deny → no
  call, exit 1; malformed service id → no call, exit 1.
- **Clean-mutation-proven**: dropping `entity_id` from the built body
  fails the builder test (and the deny→no-call guard is the
  697-mutation-proven `performWebActionWithApproval`). Restored; green.
- `pnpm check`: EXIT=0 (cross-package: mcp + cli). `pnpm lint`: 0/0.
  `pnpm check:capabilities`: ✓. Byte-scan: clean.
- No LLM path touched — a gated HTTP service call, faked in tests.
  Live use needs a running Home Assistant + a long-lived token.

## Status

**P16 COMPLETE — and with it the entire human-authored P11–P16
actuator-breadth map** (email, weather, contacts, docs, web-actions,
lifestyle) is delivered. Every outbound / state-changing actuator is
behind the fail-closed `outbound-safety.md` gate.

## Decisions

- **Home Assistant over music/health** — HA's local REST + Bearer
  token is free, no SDK, fully local, and contract-faithfully fakeable;
  Spotify/etc. need cloud OAuth. Matches the zero-cost/local constraint.
- **Reuse `performWebActionWithApproval`, don't re-gate** — a
  smart-home service call IS a state-changing web action, so it goes
  through the same fail-closed gate + action-log; `smart-home.ts` only
  adds the HA request builder. (Two gated callers — web-action + this —
  still don't justify extracting a shared core beyond the existing
  `performWebActionWithApproval`.)
- **Pure builder split out** — `buildHomeAssistantServiceCall` is
  testable without HTTP and is the seam other HA actions (lock, climate)
  reuse.
- **Banking/payments out of scope** — stated in the module doc; this
  actuator is for devices, never money.

## Remaining risks

- **No HA entity discovery** — the user names the `domain.service` +
  `entity_id`; a `muse home list-entities` (read-only) helper would
  make it more usable (additive, read-only, no gate).
- **No agent-tool wiring** — `muse home call` is the surface; an agent
  tool ("turn off the lights", gated) is the natural future consumer
  (needs the MCP/tool seam since `@muse/tools` is zero-IO).
- **Music / health actuators not built** — P16 is an umbrella; one
  provider (smart-home) satisfies the bullet, others are additive
  behind the same gate.

## Next

The P11–P16 map is fully `[x]`. Per the iteration-loop procedure
(Step 4), the next iteration should run a P→P target-completion audit —
re-run the actuator-map `CAPABILITIES.md` checks together end-to-end —
or extend `OUTWARD-TARGETS.md` toward the north star.
