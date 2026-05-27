## 863 — fix: curate Chrome DevTools MCP to a daily-driver subset (one-shot selection)

## Why

Chrome DevTools MCP advertises ~26 tools. `withChromeDevToolsRisk`
stamped every one domain `"web"` and passed them ALL through to the
agent catalog, and `DefaultToolFilter` has no count cap — so a single
browser prompt ("what's on the page?") surfaced ~26 Chrome tools at
once. On the cheap local Qwen that wrecks one-shot tool selection
(`tool-calling.md` rule 1: ≤ ~5-7 tools/turn) — the model can't reliably
pick `take_snapshot` out of 26 near-siblings including
`performance_start_trace`, `take_memory_snapshot`, `lighthouse`,
console/network internals, `emulate`, `resize_page`. Those are
web-developer tools, not a daily assistant's surface (P18 is "read /
perceive first" + basic action).

## Slice — curate at projection

`@muse/mcp` chrome-devtools-mcp.ts: a `CHROME_DAILY_DRIVER_TOOLS`
allowlist (take_snapshot, take_screenshot, navigate_page, list_pages,
wait_for, click, fill_form). `withChromeDevToolsRisk` now drops any
projected Chrome tool not in that set (flatMap → []), keeping the
exposed web set ≤ 7 while still risk-stamping (fail-close) + domain-
stamping the survivors. Non-Chrome tools pass through untouched. The
web-developer surface is curated out of the agent catalog.

## Verify

- `@muse/autoconfigure` chrome-tool-relevance.test.ts: feeding a
  realistic 13-tool raw projection (7 daily-driver + 6 web-developer)
  through the REAL `withChromeDevToolsRisk` + REAL `DefaultToolFilter`,
  the result is ≤ 7 tools, contains the perceive/navigate/act essentials
  (take_snapshot / navigate_page / click / fill_form), and does NOT
  contain performance_start_trace / take_memory_snapshot /
  evaluate_script / emulate; a curated state-changing tool (`click`) is
  risk `write` (fail-close, not the server's read default).
- `@muse/mcp` chrome-devtools-mcp.test.ts: updated — a non-curated tool
  (`evaluate_script`) is dropped from the projection; its risk
  classification stays covered by the separate `chromeDevToolsToolRisk`
  test.
- **Mutation-proven**: removing the curation filter (pass all through)
  fails the "drops web-developer tools / ≤7" test.
- `pnpm check` EXIT 0, `pnpm lint` 0/0. (Deterministic projection — no
  LLM request/response path — so no smoke:live.)

## Decisions

- **Curate, don't cap generically.** A per-domain numeric cap in
  `DefaultToolFilter` would truncate arbitrarily (could drop
  `take_snapshot`). A named daily-driver allowlist IS the priority
  signal and is stable + reviewable. The dropped tools are
  developer-debugging surfaces, genuinely outside a JARVIS daily scope;
  this is curation, not capability loss for the user's real needs.
- **The selection win is inherent, not [UNVERIFIED-LIVE].** This is an
  EXPOSURE change (catalog 26 → 7), fully verified deterministically;
  unlike a keyword/description tweak, there's no separate "does the
  model now pick it" round-trip to gate — a smaller, sharper catalog is
  the deliverable.
- No new dependency.
