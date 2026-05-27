# 796 — feat: web-watch can monitor an authenticated page via request headers

## Why

Web-watch could only fetch PUBLIC pages (`createHttpSnapshot` sent no
headers), so the common "watch my logged-in order page / dashboard"
need was unmet — the same gap the deferred Chrome-DevTools-MCP
authenticated snapshot was meant to fill, but solvable cleanly and
verifiably with a copied Cookie / Bearer header (non-intrusive, no
browser-tab hijack, no unverifiable MCP-sequence contract).

## Slice

`@muse/mcp` web-watch.ts:
- `createHttpSnapshot(url, { ..., headers? })` merges optional request
  headers into the fetch init (preserving any existing `retryOptions.init`).
- `webWatchesFromConfig` parses a per-watch `headers` object
  (`parseHeaders`: object of string values; non-object / non-string
  values ignored — the watch is still built unauthenticated).

## Verify

- `@muse/mcp` web-watch-auth-headers.test.ts (new, 4, recording fetch
  asserting the sent `init.headers`): `createHttpSnapshot` sends the
  configured Cookie + Authorization on the snapshot fetch; no headers →
  a plain GET (no auth leaked); `webWatchesFromConfig` builds a watch
  whose snapshot carries the configured `cookie`; a non-object headers
  field is ignored (still a valid watch).
- **Mutation-proven**: making `createHttpSnapshot` ignore
  `options.headers` → the header-present assertions fail (2/4); restore
  → 4/4. Full web-watch suite 28/28 (no regression — `headers` is
  optional, the public-page path unchanged), `pnpm check` EXIT 0,
  `pnpm lint` 0/0. Config-path only, no model path → no `smoke:live`.

## Decisions

- **Request headers, not a browser** — a copied session Cookie / Bearer
  monitors an authenticated page without hijacking the user's active
  tab or modelling an unverifiable Chrome-MCP multi-step sequence;
  fully testable (the fake fetch asserts the header is sent).
- **Fail-open parse** — a malformed `headers` field is dropped and the
  watch still runs (unauthenticated), consistent with the rest of
  `webWatchesFromConfig`.
- No bullet flip — extends P21 web-watch to authenticated targets
  (the deferred-snapshot need, met another way). CAPABILITIES line
  under P21.
