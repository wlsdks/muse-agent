# 111 — `MessagingProviderRegistry.send()` scrubs credentials at the dispatch chokepoint

## Why

The proactive-notice loop already calls `redactSecretsInText` on
the synthesised notice before dispatching to a messaging provider.
Every OTHER outbound surface skipped the scrub:

- `pattern-firing-loop.ts` / `followup-firing-loop.ts` — fire
  user-stored task / reminder text straight through.
- `muse.messaging.send` MCP tool — LLM-driven sends.
- `muse messaging send` CLI command.
- `commands-watch-folder.ts` / `commands-webhook.ts` — relay
  external-trigger text to the chat-out provider.
- `POST /api/messaging/send` — REST endpoint.

So a credential in a personal task title (`"rotate sk-proj-…"`),
or a webhook payload, would arrive at Telegram / Discord / Slack /
LINE / the macOS Notification Center banner with the secret
verbatim. Lock-screen exposure for the macOS case, third-party
log retention for the chat platforms.

## Scope

- `packages/messaging/src/registry.ts` `send()`:
  - Run `message.text` through `redactSecretsInText` (the
    goal-086 / 107 helper, already imported through the
    `@muse/shared` workspace dep) before delegating to
    `provider.send`.
  - Build a new `OutboundMessage` (functional, no input
    mutation) so callers can still log the original copy if
    they want to.
- The proactive loop's earlier scrub is now defence-in-depth: the
  redactor is idempotent on already-clean text, so a notice that
  was scrubbed at synthesis time passes through this step
  unchanged.

## Verify

- New `packages/messaging/test/messaging.test.ts` cases:
  - Stub provider records the text it received. Send a message
    with `sk-proj-…` AND `ghp_…`. Assert the provider sees the
    `[redacted-*]` markers, NOT the verbatim secrets, AND
    non-credential context survives.
  - Clean text passes through unchanged (no false-positive
    flagging, no double-scrub artefacts).
- `pnpm --filter @muse/messaging test` — 106 tests pass.
- `pnpm check` exit 0; `pnpm lint` exit 0.
- No real-LLM path touched (registry is provider dispatch, not
  model inference).

## Status

done — every outbound messaging surface now shares the same
credential-hygiene guarantee. Closes the safety-net gap noted
when ext-trigger / pattern / followup paths landed without
explicit redaction.
