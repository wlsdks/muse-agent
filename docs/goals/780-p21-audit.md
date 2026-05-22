# 780 — test: P21 completion audit (web-watch composes end-to-end)

## Why

Step 4 (target-completion audit): P21's single bullet is `[x]` and no
`P21 audit —` line existed. P21 was delivered across four slices —
776 (`detectWatchTrigger`), 777 (`createWebWatchRunner`), 778
(`webWatchesFromConfig` + `createHttpSnapshot`), 779 (the apps/api
daemon). Each passed its own check; the audit proves the PIECES
COMPOSE into the user-facing promise — "monitor this page and ping me
when X" — not just that each piece works alone.

## Slice

`apps/api/test/p21-seam.test.ts` (new, 2): one end-to-end flow from a
user's literal `MUSE_WEB_WATCH_CONFIG` string through the full chain
(`webWatchesFromConfig` parse → `createHttpSnapshot` HTTP-GET →
`detectWatchTrigger` → `createWebWatchRunner` baseline →
`startWebWatchTick` daemon sink → a real `MessagingProviderRegistry`)
over a contract-faithful page transitioning `processing → shipped →
shipped`: the user is pinged EXACTLY ONCE on the rising edge with
their configured title+message, none while steady. The SAME env, fully
configured, registers the production daemon; disabled / empty-config
does not.

## Verify

- `apps/api` p21-seam.test.ts 2/2.
- **Composition mutation-proven**: breaking the daemon sink's
  `${notice.title}: ${notice.text}` render to a literal → the seam's
  text assertions fail; restore → 2/2.
- Piece-checks re-run green TOGETHER: @muse/mcp web-watch +
  web-watch-runner + web-watch-config 13/13, apps/api web-watch-tick
  4/4. Full `pnpm check` EXIT 0; `pnpm lint` 0/0. No model path → no
  `smoke:live`.

## Decisions

- **No bullet flip, no CAPABILITIES line** — this is the audit
  (verification), not a new capability; it appends a `P21 audit — PASS`
  line to the README Rejected ledger per Step 4.
- **PASS, no reopen** — the chain composes faithfully; the user's
  config string produces a real ping on the real edge. The
  authenticated-page snapshot source (Chrome-DevTools-MCP background
  page) for login-gated pages remains a follow-on, not reopened scope.
