# 777 — feat: web-watch polling runner (P21 FLIP)

## Why

776 shipped `detectWatchTrigger` (the edge condition). This adds the
runner that polls a page each tick and delivers a proactive notice
when the watch fires — the "monitor this page and ping me when X"
capability, end-to-end through a real `ProactiveNoticeSink`.

## Slice

`@muse/mcp` `createWebWatchRunner({ watches, sink })` — stateful:
- `WebWatch { id, title, message, rule, snapshot }` — `snapshot()`
  fetches the current page text (in production a Chrome DevTools MCP
  `take_snapshot` call; a contract-faithful fake in tests).
- `tick()` snapshots each watch, runs `detectWatchTrigger` against
  that watch's PREVIOUS snapshot (per-watch baseline held in the
  runner → edge-triggered across ticks), delivers a notice on a
  trigger, and updates the baseline. A failed snapshot is skipped
  WITHOUT losing the last good baseline. Read-only — a watch never
  acts.

## Verify

- `@muse/mcp` web-watch-runner.test.ts (new, 2): a snapshot sequence
  `processing → shipped → shipped(…)` with `rule: { appears:
  "shipped" }` delivers EXACTLY ONE notice on the rising edge (with
  `appeared: shipped` reason) through a real `ProactiveNoticeSink`,
  and none while it steadies; a failed (`undefined`) snapshot is
  skipped and does NOT lose the baseline (no spurious re-fire after
  recovery).
- **Mutation-proven**: removing the per-watch baseline persistence
  (`previous.set`) makes the steady condition re-fire every tick →
  both tests fail; restore → 2/2.
- Full `pnpm check` EXIT 0 (mcp 716, every workspace green); `pnpm
  lint` 0/0. Contract-faithful snapshot fn + real sink — no model
  path → no `smoke:live`.

## Status

P21 FLIPPED. A watch tick over a contract-faithful page-snapshot
sequence delivers exactly one proactive notice on the edge and none
while steady — exactly the bullet's check. The `snapshot()` seam is
where the live Chrome DevTools MCP `take_snapshot` plugs in; building
the production daemon (snapshot fns from the MCP tool + watch config +
scheduling, env-gated) is the follow-on wiring (mirrors the ambient
runner → file-source → daemon path). Read-only watch, never acts
(outbound-safety).
