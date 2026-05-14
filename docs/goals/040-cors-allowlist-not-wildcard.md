# 040 — Replace wildcard CORS with explicit allowlist

## Why

server.ts probably allows * on Access-Control-Allow-Origin. For a
personal-JARVIS that's mostly fine since the API is localhost-only,
but tighten it to an env-configurable allowlist (default: same-origin +
http://localhost:3000).

## Scope

- Read CORS config.
- Replace wildcard with allowlist from MUSE_CORS_ALLOWED_ORIGINS (CSV).
- Test: foreign origin in dev mode gets 403; allowed origin passes.

## Verify

- api +1-2 tests.

## Status

open
