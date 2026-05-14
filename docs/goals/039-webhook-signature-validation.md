# 039 — Validate webhook signatures for inbound LINE / Slack

## Why

The webhook handlers accept payloads without verifying X-Line-Signature
/ X-Slack-Signature. A spoofed payload could inject an inbound message
that the agent then processes as user input.

## Scope

- Read line-webhook + slack-webhook route handlers.
- Verify HMAC-SHA256 signature using the channel secret env var.
- Reject 401 on mismatch.

## Verify

- api +2 tests per provider (valid signature accepted; invalid
  rejected with 401).

## Status

done (verify only) — LINE webhook
`POST /api/messaging/webhooks/line` already validates
`X-Line-Signature` via HMAC-SHA256(channelSecret, rawBody) +
`timingSafeEqual`. Existing tests in
`apps/api/test/messaging-webhooks.test.ts` cover valid-signature
accept + bad-secret 401 + missing-signature 401. Slack: no
webhook handler exists in the codebase — Slack inbound is
poll-mode via `fetchInbound`, not push. No code change needed.
