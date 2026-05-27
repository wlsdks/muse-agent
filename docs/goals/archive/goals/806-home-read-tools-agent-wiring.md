# 806 — feat: smart-home read tools reachable from the agent runtime

## Why

783/805 built the smart-home READ tools (`home_state`, `home_entities`)
but they lived only on the CLI (`muse home state` / `muse home
entities`) — `createHomeStateTool` / `createHomeEntitiesTool` were never
wired into the agent runtime, so a `muse ask` conversation could NOT
answer "is my front door locked?" / "what lights do I have?". This is
the 805 follow-on: expose them to the agent.

## Slice

`@muse/autoconfigure` index.ts — a `homeReadTools` block, gated on
Home Assistant creds (`MUSE_HOMEASSISTANT_URL` + `_TOKEN`), builds
`home_state` + `home_entities` and registers them in the
`DynamicToolRegistry`. Read-only perception → NOT in the execute-risk
actuator set; the relevance filter still surfaces them by domain only
when the prompt is home-related (consistent with `tool-calling.md`).

## Verify

- `@muse/autoconfigure` home-read-wiring.test.ts (new, 2): the REAL
  `createMuseRuntimeAssembly({ env })` exposes `home_state` +
  `home_entities` (both `risk:read`) in `toolRegistry` when HA creds
  are set; with no creds / URL-without-token they are absent (opt-in).
- **Mutation-proven**: removing the `!haUrl || !haToken` gate → the
  read tools leak into an unconfigured assembly → the opt-in test
  fails; restore → 2/2. Full `pnpm check` EXIT 0, `pnpm lint` 0/0.
- The exposed tool catalog rides the model request, so live SELECTION
  wants a `smoke:live` round-trip; Ollama was down → deferred. The
  deterministic reachability gate is the verified claim.

## Decisions

- **Read tools, ungated, gated on creds** — perception (read), so no
  approval gate (unlike `home_action`); only assembled when the user
  configured HA, and surfaced to the model by the existing relevance
  filter rather than always-on.
- No bullet flip — completes the smart-home triad's agent reachability
  (discover/read now usable in `muse ask`, not just the CLI).
  CAPABILITIES line under P20.
