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

done — `server-http-plumbing.ts` already strict-allowlists (defaults
`127.0.0.1:5173` + `localhost:5173`; `*` is excluded). Added
env-driven `MUSE_CORS_ALLOWED_ORIGINS` (CSV) in
`api-server-options.ts` so an operator can extend the list without
re-compiling. A literal `*` token is filtered out so a typoed env
cannot silently downgrade to wildcard mode. autoconfigure +3
tests (CSV parsed; bare `*` rejected; `*` filtered out of a CSV
while siblings survive).
