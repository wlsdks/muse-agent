# 002 — Verify error-body cap on non-HTML responses (audit)

## Why

Iter 1e1af3f added `formatApiErrorResponse` that caps non-HTML bodies
at 240 chars + special-cases HTML. Sweep the rest of the codebase
to make sure no other path still does `.text()` → `throw new Error(...)`
unchecked. Specifically the SSE error-frame handler, the multi-
agent orchestration client, and any tool that calls an external HTTP
backend.

## Scope

- grep `Muse API.*\${response.status}\|response.text().*throw` across
  apps/cli + apps/api + packages/mcp.
- Route every remaining site through `formatApiErrorResponse` (export
  it more widely if needed) OR add a local equivalent.
- Add a test asserting the SSE error-frame path also truncates.

## Verify

- No grep hit for un-capped `${response.status}: ${body}` patterns.
- All gates green. cli tests +1 for the SSE error-frame coverage.

## Status

open
