# 377 — Inbound conversational replies ("the chat IS a Muse session")

Category: epic / outward (P1-b2)

## Why

Falsifiable-outward: **after this epic ships, the user can send a
message to Muse on a wired channel (Telegram / Slack / Discord /
LINE) and Muse runs the full agent loop on it and replies on that
same channel** — exercised by replying to any inbound message and
getting Muse's answer back. Today inbound messaging is
**passive-only**: the poll/webhook daemons `appendInbound` to an
inbox file and `inbox-surface.ts` injects those messages as
*context* into the next agent run — nothing runs the agent *on the
user's message and sends the answer back*. P1's north star is "the
chat IS a Muse session"; that reply loop is the missing piece.

## Slices

1. **Responder core** — `respondToInbound({ messages, runner,
   registry, alreadyHandled })`: per new inbound message run the
   agent on its text and send the reply back to the originating
   `source` via the same provider; skip already-handled / empty
   replies; collect per-message errors; an agent failure does NOT
   mark the message handled (retried next pass, never silently
   dropped). Integration-tested against the real
   `MessagingProviderRegistry` (+ fake provider) — not unit-only.
2. **Env-gated inbound-reply tick** wired into the API server boot
   (mirrors `telegram-poll-tick` / `reminder-tick`): each tick
   reads new inbox entries via a dedicated reply cursor (distinct
   from the context-injection cursor), calls `respondToInbound`
   with the real `AgentRuntime`, persists handled keys. This makes
   the capability user-exercisable end-to-end → flips P1-b2 with a
   smoke/integration check on the live surface + the
   `CAPABILITIES.md` line.
3. **Thread continuity** (P1-b3) — conversation keyed by
   `{providerId, source}` so multi-turn context survives across
   turns and the ~20-min boundary.

## Verify

- Per slice: narrowest touched-package test + `pnpm lint` 0/0.
- Slice 2 (request/response path): the relevant `pnpm smoke:live`
  endpoint runs a real local-Qwen round-trip; CAPABILITIES line +
  P1-b2 flip happen there.

## Status

slice 1 done — `packages/messaging/src/inbound-responder.ts`:
`respondToInbound` + `inboundKey` + `InboundAgentRunner` (structural
duck-type so `@muse/messaging` keeps zero `@muse/agent-core` dep,
same pattern as the proactive loop). Replies route to
`{ providerId, destination: source }` through the real registry
(inheriting its credential-scrub chokepoint). +3 integration tests
(`@muse/messaging` 138 pass): agent-run-then-reply-to-source for a
batch, already-handled + empty-reply skip, per-message failure
collected without dropping siblings or marking handled.

## Decisions

- No `CAPABILITIES.md` line and **P1-b2 NOT flipped** this commit:
  slice 1 is the core algorithm, integration-verified, but not yet
  user-exercisable (no live wiring until slice 2). Flipping the
  bullet now would be thin/gaming per the metric rule; the flip is
  earned at slice 2 with a live-surface check. This is honest epic
  decomposition, not a stall (metric trip-wire is not tripped).
- Agent failure ⇒ message NOT marked handled ⇒ retried next pass:
  a transient model hiccup must not silently drop the user's
  message. A bounded max-attempts guard is deferred to a later
  slice (no observed need yet — Right-sized).
