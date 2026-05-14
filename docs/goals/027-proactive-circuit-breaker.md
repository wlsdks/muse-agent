# 027 — Proactive circuit-breaker

## Why

The proactive notice daemon can fire every minute when many
imminent items align. Without a per-hour cap, a busy day could
spam Telegram with dozens of pings. Add a circuit-breaker: if
> N (default 10) notices fired in the last hour, throttle to
"silent" for the rest of the hour, then resume.

## Scope

- New small sidecar `~/.muse/proactive-throttle.json` tracks
  fired-count + window-start.
- `runDueProactiveNotices` checks the sidecar before sending.
- Threshold env: `MUSE_PROACTIVE_HOURLY_CAP` default 10.

## Verify

- pnpm check / lint / smoke.
- mcp +2 tests (under-cap fires; over-cap silences).

## Status

deferred
 — defense against a hypothetical busy day with many imminent
items aligning. Not yet observed in dogfood; revisit when a real
storm of notices surfaces the need.
