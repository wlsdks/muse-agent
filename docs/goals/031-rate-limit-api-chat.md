# 031 — Rate-limit POST /api/chat per-IP

## Why

The chat endpoint has no rate limit. A scripted abuser pointed at a
muse-api dev server could burn the user's provider quota in seconds.
Add a per-IP token bucket — basic but real DoS hardening.

## Scope

- Use fastify's rate-limit plugin OR a hand-rolled in-memory bucket.
- Default cap: 60 req/min per IP (configurable via MUSE_RATE_LIMIT_*).
- Apply to /api/chat, /api/chat/stream, /api/chat/multipart.
- 429 response includes Retry-After header.

## Verify

- pnpm check / lint / smoke broad+live.
- new api test: 65 requests in a second from same IP → 60 pass, 5 get 429.

## Status

open
