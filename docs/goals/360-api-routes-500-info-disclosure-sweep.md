# 360 — raw-internal-error-on-500 info-disclosure: sweep the rest of the API

## Why

Goal 359 fixed `/api/voice/*` echoing raw `error.message` on an
unexpected 500 (OWASP info-exposure on a network surface). A
sweep of every `status(500)` site in `apps/api/src` found the
**same class** in three more route shapers:

- `messaging-routes.ts:161` — `POST /api/messaging/poll-all`
  catch: `message = error instanceof Error ? error.message :
  String(error)` sent to the client.
- `mcp-routes-shapers.ts:74` — `sendMcpError` unknown branch:
  `error instanceof Error ? error.message : "MCP operation
  failed"`.
- `multi-agent-routes.ts:192` — orchestration catch:
  `error instanceof Error ? error.message : "Multi-agent
  orchestration failed"`.

Each leaked a raw internal message (provider internals,
`ECONNREFUSED` hosts, filesystem paths, DB connection URIs) to
any HTTP client on an *unexpected* failure.
`scheduler-routes.ts:266` already uses the safe generic-500
pattern; `server-agent-error.ts` is the **deliberately-curated
chat path** (the user's chat UI must see *why* the model failed
— the actionable goals-320/349 hints, unwrapped) and is
correctly **not** in scope (different threat model,
verify-and-rejected). The typed branches
(`McpRegistryError`→409) are curated/client-safe and unchanged.

## Scope

Three source sites, identical to the goal-359 fix shape:

- `messaging-routes.ts`, `multi-agent-routes.ts`: real
  `FastifyReply` — `reply.log.error({ err: error }, …)`
  (server-side detail preserved) + generic body
  (`message: "messaging poll-all failed"` /
  `"multi-agent orchestration failed"`, same code/shape).
- `mcp-routes-shapers.ts`: `sendMcpError` — `ReplyLike` has
  no `.log`, so generic body only
  (`{ code:"MCP_OPERATION_FAILED", message:"MCP operation
  failed" }`); the truly-unexpected MCP error's
  observability is framework-level, and the common case is the
  curated 409. McpRegistryError→409 untouched.

One coherent class-closure (sibling-bundled, as in goals
319/321/340/347).

## Verify

- `apps/api/test/mcp-routes-shapers.test.ts` (new — the
  exported helper had **no** test): McpRegistryError → curated
  409 (unchanged); a raw `Error` and a non-`Error` thrown value
  → 500 generic, serialized payload contains **neither**
  `ECONNREFUSED` **nor** the secret path.
- `server.messaging-poll.test.ts`: the existing
  "dispatcher throws" test **asserted the leak**
  (`message: "disk full"`) — it had inadvertently locked the
  pre-fix leaky behaviour (no security comment/intent, unlike a
  deliberate contract). Per "fix the root cause, never weaken a
  check" it is rewritten to the secure contract: throw a
  secret-bearing error → 500 deep-equals the generic body and
  the response body contains neither `ECONNREFUSED` nor the
  secret path.
- The `multi-agent-routes.ts` fix is the **identical**
  reply.log+generic shape now route-tested for
  voice (359) and messaging here; covered by `pnpm check`
  (no bespoke third harness — disproportionate; noted, not
  silently skipped).
- `pnpm --filter @muse/api test` — 165 pass (+3). `pnpm check`
  — every workspace green (apps/api 165, apps/cli 611, all
  packages). `pnpm lint` — exit 0. The goal-227 enforcement
  test (328) stays green.
- No real-LLM request/response path touched (HTTP error
  serialization). Deterministic route-injection + helper tests
  are the rigorous verification.

## Status

done — the raw-internal-error-on-unexpected-500
info-disclosure class is now closed across the API:
`/api/voice/*` (359), `/api/messaging/poll-all`, the MCP error
shaper, and multi-agent orchestration all return a generic
client message + log the detail server-side, while the
deliberately-curated typed (validation / provider / chat)
errors are unchanged. A test that had encoded the leak now
enforces the secure contract.
