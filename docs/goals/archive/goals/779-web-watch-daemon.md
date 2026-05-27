# 779 — feat: web-watch apps/api daemon (P21 runs in production)

## Why

776 built the detector, 777 the runner, 778 the config + HTTP
snapshot source. All of it was inert: nothing on the running server
ever called `runner.tick()`. This slice is the named 778 follow-on —
the env-gated apps/api daemon that makes web-watch actually RUN for
the user, mirroring the ambient daemon.

## Slice

`apps/api`:
- `web-watch-tick.ts` — `startWebWatchTick({ watches, registry,
  providerId, destination, intervalMs?, quietHours?, ... })` builds a
  messaging-backed `ProactiveNoticeSink` over `createWebWatchRunner`
  and schedules `tick()` on an unref'd `setInterval` (default 15 min,
  clamped 1 min–6 h). Re-entrancy guard (`firing`) skips an
  overlapping tick; quiet-hours window skips delivery; errors are
  logged, never thrown.
- `tick-daemons.ts` — `startWebWatchDaemonIfConfigured(env, server,
  options)` gates on `MUSE_WEB_WATCH_ENABLED` + provider/destination
  registered in messaging + a non-empty `webWatchesFromConfig(
  MUSE_WEB_WATCH_CONFIG)`; registers an `onClose` stop hook.
- `server.ts` — invoked alongside the other tick daemons.

## Verify

- `apps/api` web-watch-tick.test.ts (new, 4): `tickOnce` over a
  config-built HTTP watch (`processing → shipped → shipped`) delivers
  EXACTLY ONE message through a real `MessagingProviderRegistry` on
  the rising edge, none while steady; quiet-hours window suppresses
  delivery; the daemon registers an `onClose` hook when fully
  configured and does NOT start when absent / empty-config / disabled.
- **Mutation-proven**: neutralising the quiet-hours skip
  (`if (false) return`) lets the quiet-hours tick deliver → that test
  fails; restore → 4/4.
- Full `pnpm check` EXIT 0 (every workspace green); `pnpm lint` 0/0;
  `pnpm smoke:broad` 51/0 (server boots with the daemon registered).
  No model path → no `smoke:live`.

## Decisions

- **HTTP-poll default 15 min** — public watch pages (price/status)
  change slowly; a tighter default would hammer third-party servers.
  Clamped 1 min–6 h; re-entrancy guard prevents a slow poll from
  stacking.
- **No bullet flip** — P21 is already `[x]` (777). This is the
  production wiring (CAPABILITIES line): the runner now ticks on a
  real server. The authenticated-page (Chrome-DevTools-MCP background
  page) snapshot source remains the open follow-on for watches behind
  a login.
