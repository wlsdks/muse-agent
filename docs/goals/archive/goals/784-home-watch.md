# 784 — feat: home-watch (proactive home monitoring) — compose 783 + the watch machinery

## Why

783 gave Muse the ability to READ a Home Assistant entity's state, but
only on demand ("is the door locked?" when asked). The daily-driver
version is PROACTIVE: "ping me if the front door is left unlocked" /
"if the freezer rises above -15°C" — perceive continuously and notice
without an invoke. The web-watch runner/detector/threshold (776–782)
already do exactly this for web pages; a home-watch is the same thing
with a Home Assistant entity's `state` as the snapshot — so it reuses
all of that proven machinery instead of a parallel implementation.

## Slice

- `@muse/mcp` web-watch.ts — extract `parseWatchRule(raw)` (the shared
  rule parser: conditions `appears`/`disappears`/`onAnyChange`/numeric
  `below`/`above`, modifiers `extract`/`caseInsensitive`; `undefined`
  when no firing condition) and reuse it in `webWatchesFromConfig` so
  web- and home-watches can't drift.
- smart-home.ts — `createHomeStateSnapshot(query)` adapts an HA entity
  into the web-watch snapshot contract (`() => Promise<string |
  undefined>` returning the entity `state`; `undefined` on read
  failure → runner skips, keeps baseline).
- home-watch.ts — `homeWatchesFromConfig(raw, { baseUrl, token,
  fetchImpl?, retryOptions? })` parses `[{ id, entityId, title,
  message, rule }]` into `WebWatch[]` over HA states; HA creds come
  from the connection, not per-entry. Read-only — a watch NEVER
  actuates (outbound-safety).

## Verify

- `@muse/mcp` home-watch.test.ts (new, 4), driven by a contract-faithful
  HA fake (`GET /api/states/<id>` → the HA body shape): a door-unlocked
  watch (`appears:"unlocked"`) fires ONCE on the locked→unlocked edge
  through `createWebWatchRunner` + a real `ProactiveNoticeSink`, none
  while it stays unlocked; a `above:-15` freezer watch fires when the
  sensor crosses (-18→-16→-12); invalid entries / non-array / malformed
  JSON dropped; a transient 503 read → snapshot `undefined` → tick
  skipped WITHOUT a false fire or lost baseline.
- **Mutation-proven**: making `createHomeStateSnapshot` return a
  constant (ignore the live read) → 3/4 fail; restore → 4/4. Full
  web-watch + home-watch + smart-home-state suites 34/34 (the
  `parseWatchRule` extraction did NOT regress web-watch), `pnpm check`
  EXIT 0, `pnpm lint` 0/0. Config-path only, no model path → no
  `smoke:live`.

## Decisions

- **A home-watch IS a `WebWatch`** — same detector / numeric threshold
  / runner / sink, only the snapshot source differs (HA state vs HTTP
  page). Reuse over a parallel "home-watch runner".
- **Shared `parseWatchRule`** — extracted so the two config parsers
  share identical rule semantics; a new condition added once reaches
  both.
- No bullet flip — composes P20 (continuous perception → proactive
  notice) + P19 (the 783 hardened HA read). The apps/api daemon
  (`MUSE_HOME_WATCH_CONFIG` → watches → tick → messaging, mirroring the
  web-watch daemon) is the production-wiring follow-on.
