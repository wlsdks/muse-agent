# 765 — feat: ambient-perception daemon runs in the API server (P20 perception, end-to-end)

## Why

The P20 perception pieces existed — `FileAmbientSignalSource` (763),
`parseAmbientNoticeRules` (763), `createAmbientNoticeRunner` (764,
edge-triggered) — but nothing SCHEDULED them, so the server never
actually delivered an ambient-driven notice. This wires the daemon:
the running API server now perceives ambient context and proactively
notifies, with no user invoke.

## Slice

- `apps/api/src/ambient-tick.ts` `startAmbientTick(options)` — a
  setInterval rider (mirrors pattern-tick) that builds a
  messaging-backed `ProactiveNoticeSink` (`registry.send(providerId,
  {destination, text})`), drives the edge-triggered
  `createAmbientNoticeRunner`, skips quiet hours WITHOUT advancing the
  edge state, fail-soft, `unref`'d.
- `startAmbientDaemonIfConfigured` (tick-daemons.ts) — env gate:
  `MUSE_AMBIENT_ENABLED=true` + provider + destination (registered) +
  `MUSE_AMBIENT_RULES` parsing to ≥1 rule; reads
  `MUSE_AMBIENT_FILE` (default `~/.muse/ambient.json`); registered in
  server.ts alongside the other tick daemons. Off by default.

## Verify

- `@muse/api` ambient-tick.test.ts (new, 4):
  - end-to-end: a REAL `ambient.json` (window "Team Standup") + a rule
    → `startAmbientTick(...).tickOnce()` delivers the notice through a
    REAL `MessagingProviderRegistry` to a capturing provider at
    `destination: "555"`; a second tick with the same signal does NOT
    re-send (edge-triggered); a non-matching signal sends nothing.
  - `startAmbientDaemonIfConfigured` registers an onClose stop hook
    when fully configured; absent env / empty rules ⇒ not started.
- **Mutation-proven**: removing the `rules.length === 0` gate makes
  the empty-rules daemon start → the "not started" test fails; restore
  → 4/4.
- Full `pnpm check` EXIT 0 (apps/api 312, every workspace green);
  `pnpm lint` 0/0. The daemon adds no HTTP route and no model
  request/response path (messaging send + file read) → no
  `smoke:broad` / `smoke:live`; the real registry→provider.send
  delivery path is exercised against a contract-faithful capturing
  provider.

## Decisions

- **Messaging-backed sink** — reuses the registry the other proactive
  daemons use; the notice is `"<title>: <text>"` to the configured
  provider/destination. Quiet-hours skip happens BEFORE the runner
  tick so a context still active when quiet hours end fires once (a
  rising edge), not silently swallowed.
- No bullet flip — P20 perception is already `[x]` (756, the bullet's
  stated check is a simulated signal → real delivery). This is the
  full production pipeline (real file source → daemon → real messaging
  delivery), recorded as a CAPABILITIES line. The OS helper that
  WRITES `~/.muse/ambient.json` stays a user-owned script (the
  un-dog-food-able OS capture), exactly as designed in 763.
