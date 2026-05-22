# 785 — feat: home-watch apps/api daemon (proactive home monitoring RUNS)

## Why

784 built home-watch (`homeWatchesFromConfig` → `WebWatch[]` over HA
entity states) but it was inert — nothing on the running server ever
ticked it. This slice is the named 784 follow-on: the env-gated
apps/api daemon that makes proactive home monitoring actually RUN,
mirroring the web-watch daemon (779). Because a home-watch IS a
`WebWatch`, the existing `startWebWatchTick` scheduler runs it
verbatim — only the watch SOURCE (HA states vs HTTP pages) differs.

## Slice

`apps/api`:
- `tick-daemons.ts` — `startHomeWatchDaemonIfConfigured(env, server,
  options)` gates on `MUSE_HOME_WATCH_ENABLED` + provider/destination
  registered in messaging + HA creds (`MUSE_HOMEASSISTANT_URL` +
  `_TOKEN`) + a non-empty `homeWatchesFromConfig(MUSE_HOME_WATCH_CONFIG,
  { baseUrl, token })`; builds the watches and reuses `startWebWatchTick`
  (default 15-min tick, quiet-hours, `onClose` stop).
- `server.ts` — invoked alongside the other tick daemons.

## Verify

- `apps/api` home-watch-tick.test.ts (new, 2): a user's
  `MUSE_HOME_WATCH_CONFIG` builds HA-state watches (against a
  contract-faithful HA fake) that fire EXACTLY ONCE on the
  locked→unlocked edge through `startWebWatchTick` + a real
  `MessagingProviderRegistry`, none while it stays unlocked; the daemon
  registers an `onClose` hook only when enabled + provider +
  destination + HA creds + a valid config are all present (disabled /
  missing token / empty config → not started).
- **Mutation-proven**: dropping the HA-creds branch (parse the config
  even without `baseUrl`/`token`) → the "missing token → not started"
  case fails; restore → 2/2. Full `pnpm check` EXIT 0, `pnpm lint`
  0/0, `pnpm smoke:broad` 51/0 (server boots with the daemon). No
  model path → no `smoke:live`.

## Decisions

- **Reuse `startWebWatchTick`** — a home-watch is a `WebWatch`, so the
  tick scheduler / quiet-hours / re-entrancy guard are shared; the
  daemon only differs in how it BUILDS the watches (HA creds +
  `homeWatchesFromConfig`). No parallel scheduler.
- **HA creds gate** — without `MUSE_HOMEASSISTANT_URL` + `_TOKEN` no
  watches are built (the read can't authenticate), so the daemon
  stays off; mutation-proven load-bearing.
- No bullet flip — completes the P20 perception + P19 (783 HA read)
  composition; this is the production wiring (CAPABILITIES line).
