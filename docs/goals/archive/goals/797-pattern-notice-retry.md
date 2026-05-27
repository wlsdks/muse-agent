# 797 — fix: proactive pattern notices retry a transient messaging blip (P19 reach)

## Why

794 routed the web-watch / home-watch / ambient sinks through
`sendWithRetry`, but the pattern-detection firing loop
(`runDuePatternNotices`) still sent single-shot via `registry.send`.
A transient messaging 5xx therefore dropped a learned-pattern
suggestion ("you usually journal Tuesday 21:30 — start now?") and,
because the cooldown is only recorded AFTER a successful send, the
notice waited a WHOLE daemon tick (or longer) to retry. This closes the
last single-shot proactive sender.

## Slice

`@muse/mcp` pattern-firing-loop.ts — the per-match send now goes
through `sendWithRetry(registry, providerId, { destination, text })`
instead of `registry.send`. `recordPatternFired` still runs only after
a successful (possibly retried) delivery, so the cooldown reflects what
actually went out.

## Verify

- `@muse/mcp` pattern-firing-retry.test.ts (new, 1): a REAL fireable
  pattern (built from five prior-Tuesday journal note-edits via mtime
  fixtures, aggregated by the real `aggregateActivitySignals` →
  `selectFireablePatterns` path) whose first send throws a retryable
  `UPSTREAM_FAILED` (503) is still DELIVERED (`delivered === 1`, no
  errors) through a real `MessagingProviderRegistry`.
- **Mutation-proven**: reverting to single-shot `registry.send` → the
  503 is caught as an error, `delivered === 0` → the test fails;
  restore → 1/1. Full `pnpm check` EXIT 0, `pnpm lint` 0/0. Pattern
  notice path (not an LLM request/response path) → no `smoke:live`.

## Decisions

- **Same posture as 794** — `sendWithRetry` retries only a failed send
  (returns after the first success, no double-notice) and
  short-circuits a permanent error; the notice goes to the user's own
  channel (low-risk path). The cooldown record stays after the send so
  a never-delivered pattern isn't marked fired.
- No bullet flip — completes the proactive-reach reliability (all
  proactive senders now retry: briefing, reminders, web/home-watch,
  ambient, and now pattern). CAPABILITIES line under P19.
