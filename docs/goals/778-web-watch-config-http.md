# 778 — feat: web-watch config + HTTP snapshot source (P21 production wiring)

## Why

777 flipped P21 with `createWebWatchRunner` over a contract-faithful
snapshot fn. To run for real, watches need (a) config and (b) a
concrete, non-intrusive snapshot source. Driving the user's logged-in
browser would HIJACK their active tab; a plain HTTP GET of a PUBLIC
page (price / status / availability) is non-intrusive and covers the
common watch case. (Authenticated pages via a Chrome-DevTools-MCP
background page are a later source.)

## Slice

`@muse/mcp` web-watch.ts:
- `createHttpSnapshot(url, { fetchImpl, retryOptions })` — a snapshot
  source that HTTP-GETs the page (retry-hardened via `fetchWithRetry`,
  reusing the P19 helper for transient 429/5xx); returns the body
  text, or `undefined` on a permanent failure so the runner skips
  that watch without losing its baseline.
- `webWatchesFromConfig(raw, { fetchImpl, retryOptions })` — parses a
  JSON array of `{ id, url, title, message, rule }` into runnable
  `WebWatch`es with HTTP snapshots. Fail-open: malformed JSON /
  non-array / an entry missing id/url/title/message or with a
  no-condition rule is skipped.

## Verify

- `@muse/mcp` web-watch-config.test.ts (new, 4): builds a watch whose
  snapshot HTTP-fetches the url; drops invalid entries (no url / empty
  rule / empty id) + non-array / malformed JSON; snapshot returns
  `undefined` on a permanent 404; **end-to-end** — a config-built
  watch over an HTTP page transitioning `processing → shipped →
  shipped` fires EXACTLY ONCE on the edge through `createWebWatchRunner`
  + a real `ProactiveNoticeSink`, none while steady.
- **Mutation-proven**: removing the no-condition-rule drop guard lets
  an invalid (`rule: {}`) entry leak → the drop test fails; restore →
  4/4.
- Full `pnpm check` EXIT 0 (mcp 720, every workspace green); `pnpm
  lint` 0/0. Contract-faithful fake fetch — no model path → no
  `smoke:live`.

## Decisions

- **HTTP GET source, not the live browser** — non-intrusive (never
  hijacks the user's tab) and covers public watch targets. The
  retry-hardening reuses `fetchWithRetry`; a permanent failure yields
  `undefined` so the runner preserves the baseline.
- No bullet flip — P21 is already `[x]` (776/777); this is the
  config + concrete snapshot source (CAPABILITIES line). The apps/api
  daemon (parse `MUSE_WEB_WATCH` config → watches → setInterval
  `runner.tick()` → messaging delivery, env-gated) is the remaining
  follow-on, mirroring the ambient daemon.
