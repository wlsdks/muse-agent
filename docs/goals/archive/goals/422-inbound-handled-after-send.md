# 422 — Inbound reply marked handled only after the send succeeds

## Why

Correctness fix on the **core JARVIS conversational loop**
(`respondToInbound` in `@muse/messaging` — how Muse answers when
the user messages it on Telegram / Discord / Slack / LINE; a
fresh axis and a different code kind — orchestration flow, not a
pure parser, deliberately varying from the recent bug-sweep).

`respondToInbound` did `handled.push(key)` **before**
`registry.send(...)`. The function's own docstring promises "a
transient … error is retried on the next pass rather than [lost]"
and the agent-error path honours that (the push is after
`runner.run`, so an agent throw → not handled → retried). But the
**send** path was asymmetric: if `registry.send` threw on a
transient channel failure (Telegram 429 rate limit, a network
blip, a 5xx), the `catch` recorded the error while the key was
**already in `handled`**. The caller persists handled keys and
never retries them — so the user asked Muse something, Muse spent
LLM tokens computing a good answer, the send hiccupped, and the
reply is **never delivered and never retried, forever**. Telegram
429s are routine, so this silently drops real answers in normal
operation.

## Slice

- `packages/messaging/src/inbound-responder.ts` — move
  `handled.push(key)` so it runs (a) in the empty-reply branch
  (agent consumed it and chose silence — must not reprocess), and
  (b) **after** a successful `registry.send`. A send failure now
  falls through to the existing `catch` with the key NOT handled,
  so it is retried next pass — symmetric with the agent-failure
  path and matching the documented contract. Behaviour changes
  only for the transient-send-failure case.
- `packages/messaging/test/inbound-responder.test.ts` —
  regression: a provider that throws on one destination → that
  message is NOT in `handled`, its error is recorded, `replied`
  excludes it, and the sibling still gets its reply. Fails on the
  pre-fix code (the failed-send key was in `handled`).

## Verify

- `@muse/messaging` inbound-responder.test.ts 4/4 (3 existing
  preserved — empty-reply→handled, agent-failure→not-handled,
  normal→handled+replied — + 1 new); full `@muse/messaging`
  suite green (11 files / 145); tsc strict (messaging) clean.
- `pnpm check` EXIT=0, every workspace green (messaging ok, api
  194, cli 731, …); `pnpm lint` 0/0; `pnpm guard:core` clean;
  byte-scan clean.
- Control-flow change verified with a duck-typed fake runner +
  fake provider; the agent run is mocked, so no real model
  round-trip is involved — `smoke:live` (Ollama-only model
  adapter path) does not apply.

## Status

Done. A transient channel send failure no longer consumes the
inbound message — Muse's computed reply is retried on the next
pass instead of being silently lost, fulfilling the loop's stated
retry contract. The send-failure and agent-failure paths are now
symmetric.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]`; this is a correctness fix to an existing core
flow, recorded honestly as a `fix(messaging):` change with this
backlog row — not a false metric.

## Decisions

- Retry the whole message (re-run the agent next pass) rather
  than cache-and-resend-only: that is exactly the contract the
  docstring states and the agent-failure path already follows;
  the inbound message is the source of truth, and a
  reply-cache/resend layer would be unreviewed scope creep for no
  added correctness.
- Kept the empty-reply → handled semantic (the existing test
  pins it): an intentionally-silent agent response is "done", not
  a transient failure, and must not be reprocessed forever.
