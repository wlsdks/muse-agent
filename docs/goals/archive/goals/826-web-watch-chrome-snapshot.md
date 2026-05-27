## 826 — feat: web-watch can monitor a page behind the user's login (Chrome snapshot)

## Why

P21 web-watch ("monitor this page, ping me when X") shipped with the
edge-triggered runner/detector (776/777) and a production daemon, but
its ONLY snapshot source was `createHttpSnapshot` — a plain HTTP GET.
That can't see a page behind the user's session (an order-status page,
a private dashboard, a logged-in ticket): the GET returns the login
wall, not the content. `WebWatch.snapshot`'s own doc already named the
fix — "in production a Chrome DevTools MCP `take_snapshot` call" — but
no such source existed. This composes the delivered P18 Chrome
perception with P21 watching, so a watch can monitor authenticated
pages.

## Slice

`@muse/mcp` web-watch.ts:
- `createChromeSnapshot(connection, url)` — a snapshot source that
  reads through the user's REAL logged-in Chrome via the Chrome
  DevTools MCP connection seam: `navigate_page` the attached tab to
  `url`, then `take_snapshot` its text. Read-only (navigate + snapshot,
  never a state-changing action). Returns the page text, or `undefined`
  on any failure (the runner then skips the watch without losing its
  baseline). Minimal `ChromeSnapshotConnection` (`callTool`) seam so it
  stays testable without a real browser.
- `webWatchesFromConfig` gained an optional `chromeConnection`: a config
  entry with `"source": "chrome"` builds a Chrome-backed watch; absent a
  connection it is SKIPPED (never silently downgraded to HTTP, which
  can't see the authenticated page the user asked to watch). Default /
  `"source": "http"` entries stay HTTP exactly as before.

## Verify

`@muse/mcp` web-watch-chrome.test.ts (new, 5), contract-faithful fake
of the Chrome DevTools MCP connection (the `callTool` seam — the real
`take_snapshot` returns the live page text, `navigate_page` points the
tab):
- `createChromeSnapshot` navigates to the url THEN snapshots, returning
  the live text (call order asserted); a thrown connection → undefined;
  an empty snapshot → undefined.
- `webWatchesFromConfig` builds a chrome watch only with a connection
  (none → skipped, length 0).
- **End-to-end**: a `source:"chrome"` config → `webWatchesFromConfig` →
  the REAL `createWebWatchRunner` over a processing→SHIPPED→SHIPPED
  snapshot sequence delivers exactly ONE notice on the rising edge,
  none while steady.
- **Mutation-proven**: dropping the `navigate_page` call → the
  navigate-order test fails; forcing the chrome branch off (downgrade
  to HTTP) → the connection-required + end-to-end tests fail. Full
  `pnpm check` EXIT 0, `pnpm lint` 0/0. No model-facing tool added (a
  perception primitive + config) → no smoke:live applicable.

## Decisions

- **Skip, never downgrade, a chrome watch without a connection** — a
  user who wrote `source:"chrome"` wants the authenticated page; quietly
  watching the public HTTP version would monitor the wrong content (the
  login wall) and fire misleading notices.
- **Minimal `ChromeSnapshotConnection` seam** (`callTool` only) rather
  than importing the McpManager connection type — keeps web-watch
  decoupled and the path exercisable against a contract-faithful fake.
- Advances P21's named "snapshot via the live MCP tool + watch config"
  follow-on. The daemon CONNECTING Chrome at startup + threading the
  connection into `webWatchesFromConfig` is the remaining wiring (needs
  a live Chrome lifecycle in apps/api). CAPABILITIES line under P18/P21
  composition; no bullet flip (P21 bullet already `[x]`).
