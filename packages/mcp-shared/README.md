# @muse/mcp-shared

A small grab-bag of deterministic helpers shared between the MCP layer, messaging, and other
packages that need them without depending on the full `@muse/mcp` transport stack: relative
time formatting, retry policy, and calendar-availability math. It is a package rather than
living inside `@muse/mcp` because `@muse/stores`, `@muse/tools`, and `@muse/recall` all need
these helpers without pulling in the MCP SDK.

## Public surface

- `loopback-relative-time.js` — relative-time formatting for loopback tool descriptions.
- `local-due-format.js` — local-timezone due-date formatting.
- `median-gap.js` — median-gap computation over a series of timestamps.
- `messaging-retry.js` — retry policy for messaging-provider calls.
- `http-retry.js` — generic HTTP retry helper.
- `calendar-availability.js` — free/busy availability computation over calendar events.

## Depends on

- `@muse/messaging` — messaging-provider types the retry helper operates over.
- `@muse/resilience` — the retry/backoff primitives `messaging-retry.js` and `http-retry.js`
  build on.
- `@muse/shared` — shared types and utilities.

## Tests

```bash
pnpm --filter @muse/mcp-shared test
```
