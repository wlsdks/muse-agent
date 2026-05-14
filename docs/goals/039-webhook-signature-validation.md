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

open
