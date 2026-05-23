## 823 — fix: Chrome DevTools tools gated to a `web` domain (no prompt flood)

## Why

P18 attaches Chrome DevTools MCP, which projects ~30 tools
(`chrome-devtools.*`). MCP-projected tools have no `domain`, and
`inferDomain` has no `chrome-devtools.` prefix mapping → the filter
treats them as ALWAYS-ON. So enabling Chrome floods EVERY prompt's
catalog with ~30 browser tools, blowing the ≤5–7 budget and wrecking
one-shot tool selection on the local model (`tool-calling.md` rule 1) —
the human's #1 concern, at its worst when P18 is on.

## Slice

- `@muse/mcp` chrome-devtools-mcp.ts — `withChromeDevToolsRisk` now also
  stamps `domain: "web"` on every `chrome-devtools.*` tool (alongside
  the existing fail-close risk re-stamp).
- `@muse/agent-core` tool-filter.ts — add a `web` entry to
  `DEFAULT_DOMAIN_KEYWORDS` (browser/chrome/tab(s)/webpage/website/page/
  url/navigate/click/scroll/screenshot/브라우저/페이지/탭/웹).

## Verify

- `@muse/mcp` chrome-devtools-mcp.test.ts (+1, 10 total):
  `withChromeDevToolsRisk` stamps `domain "web"` on a chrome tool and
  leaves non-chrome tools' domain undefined (+ existing risk stamps).
- `@muse/autoconfigure` chrome-tool-relevance.test.ts (new, 2): the REAL
  chrome tools through the REAL `DefaultToolFilter` — a browser prompt
  ("what's on the page in my browser?" / "summarize this web page")
  surfaces them; an unrelated prompt ("what is 2+2?") surfaces NONE.
- **Mutation-proven**: dropping the `domain: "web"` stamp → chrome
  tools flood the unrelated prompt → the no-flood test fails; restore →
  pass. Full `pnpm check` EXIT 0, `pnpm lint` 0/0. Exposed catalog
  rides the model request → live SELECTION wants `smoke:live`; Ollama
  down → deferred.

## Decisions

- **Domain-gate at the stamp, not per-tool** — `withChromeDevToolsRisk`
  is the one seam every projected chrome tool already passes through, so
  one `domain: "web"` there covers all ~30 uniformly (and future chrome
  tools). The same architecture as the home/calendar/etc. domains.
- No bullet flip — P18 tool-calling reliability (Chrome no longer floods
  the catalog). CAPABILITIES line under P18 / tool-calling.
