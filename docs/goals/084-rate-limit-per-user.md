# 084 — Chat rate limiter keys on authenticated userId when present

## Why

Goal 031's `ChatRateLimiter` token-buckets per request IP. In a
multi-user deployment (or one behind a shared corporate egress
IP) that means a single noisy user starves everyone else. When
an authenticated identity is available on the request, key the
bucket on `userId` instead of IP; fall back to IP otherwise so
public / anonymous flows still get protection.

## Scope

- `clientKeyFromRequest` in `chat-rate-limiter.ts` becomes
  identity-aware: prefer `request.museIdentity?.userId`, fall
  back to `request.ip`.
- The chat-route gate plumbs the authenticated identity (already
  attached by `attachAuthIdentity` in the onRequest hook) into
  the limiter.
- Per-user + per-IP limits stay the same defaults (60/min) but
  the env var splits to
  `MUSE_RATE_LIMIT_CHAT_USER_PER_MINUTE` and
  `MUSE_RATE_LIMIT_CHAT_IP_PER_MINUTE` so an operator can tighten
  one without the other.

## Verify

- api +2 tests: two requests from the same IP but different
  authenticated users get independent buckets; an anonymous IP
  still consumes a bucket.

## Status

open
