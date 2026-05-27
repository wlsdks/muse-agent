# 783 — feat: Home Assistant state read (home perception, retry-hardened)

## Why

Stagnation guard tripped — the last six `feat` commits were all
web-watch (P21). This tick redirects to a different outward bullet:
P19 actuator hardening + P20 perception. The smart-home actuator was
WRITE-ONLY (`home_action` / `muse home call` — turn off a light, lock
a door). A daily-driver assistant must also ANSWER "is the front door
locked?" / "what's the living-room temperature?" — a read Muse simply
could not do. A state read is non-state-changing + idempotent, so
(unlike the single-shot write path) it is retry-hardened against the
P19 transient-failure modes.

## Slice

- `@muse/mcp` smart-home.ts — `readHomeAssistantState({ baseUrl,
  token, entityId, fetchImpl?, retryOptions? })` GETs
  `/api/states/<id>` with the Bearer token through `fetchWithRetry`
  (recovers from transient 429/5xx), validates the HA body shape, and
  returns `{ entityId, state, attributes }` or `undefined` — never
  throws — on a permanent failure / malformed body.
- `smart-home-tool.ts` — `createHomeStateTool` projects it as a
  `risk: "read"` (ungated) agent tool `home_state`.
- `apps/cli` commands-home.ts — `muse home state <entity>` prints the
  entity's current state + friendly name.

## Verify

- `@muse/mcp` smart-home-state.test.ts (new, 6): GET URL + Bearer
  header + parsed state; **recovers from a transient 503 by retrying**
  (2 calls, the P19 failure mode); permanent 404 → `undefined`;
  malformed 200 body → `undefined`; the `home_state` tool is
  `risk:read` and reports state / `found:false` on failure.
- `apps/cli` commands-home.test.ts (+2): `muse home state` GETs
  `/api/states/<id>` and prints `lock.front_door (Front Door):
  locked`; a 404 reports no-state + exit 1 without throwing.
- **Mutation-proven**: replacing `fetchWithRetry` with a single
  `fetchImpl` call → the transient-503-recovery test fails; restore →
  6/6. Full `pnpm check` EXIT 0, `pnpm lint` 0/0. No model path → no
  `smoke:live`.

## Decisions

- **Read lives OUTSIDE `buildActuatorTools`** — that set is the gated
  execute-risk actuators and a test asserts every member is
  `execute`-risk; a read-only perception tool would (correctly) break
  that invariant, so the read ships as `muse home state` + the
  `home_state` read tool, not as an "actuator".
- **Reads retry, writes don't** — `readHomeAssistantState` is
  idempotent so it routes through `fetchWithRetry`; the write path
  (`performHomeActionWithApproval`) stays single-shot, since a retried
  POST could double-act (lock/unlock twice).
- No bullet flip — P19's "one actuator" bullet is `[x]` (weather,
  753); this is the explicit "repeat per actuator" follow-on
  (smart-home) + a perception expansion. CAPABILITIES line under P19.
