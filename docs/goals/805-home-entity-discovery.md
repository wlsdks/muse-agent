# 805 — feat: Home Assistant entity discovery (`muse home entities`)

## Why

Smart-home was read-one (`home_state` / `muse home state` needs an
EXACT entity id) + write — but nothing let the user or agent DISCOVER
what devices exist or find those ids. "What smart-home devices do I
have?" / "find my lights" was unanswerable, and you had to already know
`lock.front_door` to read it. Home Assistant `GET /api/states` lists
every entity; this exposes it.

## Slice

- `@muse/mcp` smart-home.ts — `listHomeAssistantStates({ baseUrl,
  token, fetchImpl?, retryOptions?, domain? })` GETs `/api/states`
  (Bearer token, retry-hardened like the other reads), parses the
  entity array (skipping malformed elements), and optionally filters to
  a `domain` prefix (`light.`, `lock.`). Returns `[]` — never throws —
  on failure / malformed body.
- smart-home-tool.ts — `createHomeEntitiesTool` projects it as a
  `risk: "read"` agent tool `home_entities` (optional `domain` arg).
- `apps/cli` commands-home.ts — `muse home entities [--domain X]` lists
  the devices.

## Verify

- `@muse/mcp` smart-home-entities.test.ts (new, 5, contract-faithful HA
  fake): GET `/api/states` + Bearer parses the list (skips a malformed
  element); `domain` filter narrows to `light.`; a transient 503
  recovers by retrying (2 calls); a permanent 500 / malformed body →
  `[]`; the `home_entities` tool is `risk:read` and returns the list.
- `apps/cli` commands-home.test.ts (+2): `muse home entities --domain
  lock` GETs `/api/states` and lists only the lock (not the light); an
  unreachable list reports "No entities found".
- **Mutation-proven**: removing the `domain` prefix filter → the
  filter tests fail; restore → green. Full `pnpm check` EXIT 0, `pnpm
  lint` 0/0. HTTP read (not an LLM request/response path) → no
  `smoke:live`.

## Decisions

- **Discovery completes the smart-home triad** — `home_entities`
  (find ids) → `home_state` (read one) → `home_action` (control,
  gated). A daily-driver can now start from "what do I have?" instead
  of needing to memorise entity ids.
- **Read-hardened, CLI surface** — mirrors `muse home state` (783):
  retry on the idempotent read, a dedicated CLI command rather than
  the gated actuator set. No bullet flip — smart-home perception
  EXPAND. CAPABILITIES line under P20.
