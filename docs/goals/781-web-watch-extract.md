# 781 — feat: web-watch `extract` region narrowing (P21 daily-driver hardening)

## Why

P21 web-watch is complete + audited, but on REAL pages it's barely
usable: a price/order/status page is full of noise (rotating ads,
timestamps, session ids), so `onAnyChange` fires every poll and
`appears`/`disappears` match anywhere on the page (e.g. the word
"shipped" in a "free shipping" banner). A daily-driver watch must
target the value the user cares about, not the whole noisy document.

## Slice

`@muse/mcp` web-watch.ts:
- `WatchRule.extract?: string` — a regex applied to BOTH snapshots
  before matching; capture group 1 if present, else the whole match.
  No match → empty region; an invalid regex fails open to the whole
  text (degrade, never crash). `applyExtract` is pure.
- `detectWatchTrigger` runs `appears`/`disappears`/`onAnyChange`
  against the EXTRACTED region, so noise outside it can't fire.
- `webWatchesFromConfig` parses `extract` (added to `RULE_FIELDS`); it
  is a modifier, not a firing condition, so an `extract`-only rule
  with no `appears`/`disappears`/`onAnyChange` is still dropped.

## Verify

- `@muse/mcp` web-watch-extract.test.ts (new, 4): `onAnyChange` over
  `Status: (\w+)` ignores a noise-only change and fires when the
  status word itself changes; `appears: shipped` matches inside the
  status region, NOT the "free shipping" banner; an invalid regex
  fails open to the whole text; **end-to-end** — a config-built watch
  over an HTTP page (`Price: (\$\d+)` + `onAnyChange`) through
  `createWebWatchRunner` + a real `ProactiveNoticeSink` fires ONCE
  when the price changes, never when only the banner/footer noise
  changes.
- **Mutation-proven**: neutralising `applyExtract` (return the whole
  text, never narrow) → 3/4 fail (noise-only change fires); restore →
  4/4. Full web-watch suite 17/17, `pnpm check` EXIT 0, `pnpm lint`
  0/0. Config-path only, no model path → no `smoke:live`.

## Decisions

- **No bullet flip** — P21's bullet is already `[x]` + audited; this
  is the hardening that makes it daily-dependable (CAPABILITIES line
  under P21). `extract` is a rule MODIFIER, not a new firing
  condition, so the no-condition drop guard is unchanged.
- **Capture-group-1-else-whole-match** — lets `Status: (\w+)` watch
  just the value while a bare `Price: \$\d+` (no group) watches the
  whole matched span. Invalid regex fails open (the watch still works
  on the full page) rather than silently disabling the watch.
