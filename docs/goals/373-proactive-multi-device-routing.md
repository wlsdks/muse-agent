# 373 — Proactive multi-device routing

Category: epic / feature

## Why

`docs/design/proactive-surfacing.md` ships Phases A–D. The named
remaining work: a proactive notice currently always fires through
the messaging registry, even when the user is actively at the
REPL/CLI on this machine. JARVIS-class behaviour is to surface the
notice *through the surface the user is currently looking at* — the
terminal session when present, messaging only as the fallback.

## Scope

Generalise delivery routing on top of the existing in-memory
presence tracker (Phase D). No new infra, no schema bump.

## Slices

1. **Presence-aware sink selection** — extend the proactive
   firing path so an active local presence routes the notice to a
   terminal sink instead of the messaging registry. Messaging
   remains the fallback when no local presence is recorded.
2. **Terminal notice sink** — a sink that renders a queued
   proactive notice into the active REPL without corrupting the
   prompt line (reuse the existing control-byte-safe writer).
3. **Stale-presence expiry + fallback** — presence older than a
   bounded window is treated as absent so a backgrounded terminal
   doesn't black-hole notices; falls back to messaging.

## Verify

- Per slice: `pnpm check`, `pnpm lint` (0/0), `pnpm smoke:broad`.
- `pnpm smoke:live` for the firing-path slice.
- Unit test per slice (presence → sink decision is pure logic;
  assert the sink actually chosen, no fall-back assertion).

## Status

slice 1 done — presence-aware sink selection wired into the
proactive firing path. Pure `selectProactiveSink(activitySource,
hasTerminalSink)` + a minimal `ProactiveNoticeSink` seam +
`terminalSink?` option; when a sink is wired AND the activity
source reports recorded local presence the notice routes to the
terminal sink, otherwise messaging (the fallback). History audit
records `providerId: "terminal"` for terminal deliveries. Unit
tests assert the pure decision and that the chosen sink actually
receives the notice (no fall-back assertion) + the no-presence
messaging fallback.

Remaining: slice 2 (concrete REPL terminal sink renderer), slice 3
(stale-presence expiry → treat a backgrounded terminal as absent).

Verification note: `pnpm smoke:live` auto-skips because
`scripts/smoke-live-llm.mjs` `pickProvider()` only probes cloud API
keys (its `OLLAMA … if reachable` header comment is unimplemented);
under the Qwen-only / cost-zero constraint no cloud key may be set.
Slice 1 changes post-synthesis delivery routing only — the
LLM request/response path is untouched — so the deterministic unit
test (per this goal's Verify) plus `pnpm smoke:broad` (51/0) is the
rigorous verification here.
