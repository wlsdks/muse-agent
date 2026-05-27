# 787 — fix: web action reports a server rejection as failed, not a false success (P19)

## Why

P19 actuator hardening, web-action (the remaining named actuator).
`performWebActionWithApproval` reported `performed: true` for ANY HTTP
status — so a booking / form submit that the third party REJECTED with
403 or 500 was reported to the user/agent as "performed (HTTP 500)". A
daily-driver assistant must NOT claim an action succeeded when the
server said it failed: the user would believe the table is booked when
it isn't. This is the "malformed / error response" failure mode the
P19 mandate names — handled by honest outcome classification, NOT
retry (a retried POST can double-act — outbound-safety).

## Slice

`@muse/mcp` web-action.ts — after the (approved) request returns,
branch on `response.ok`: a non-2xx logs `failed` and returns
`{ performed: false, reason: "failed", detail: "server rejected (HTTP
<status>)" }` instead of a false `performed: true`. The 2xx path is
unchanged. This also strengthens the smart-home WRITE actuator
(`performHomeActionWithApproval` reuses this primitive): a Home
Assistant service call that errors 500 no longer reports success.

## Verify

- `@muse/mcp` web-action.test.ts (+2, now 6): a 500 reports
  `{ performed: false, reason: "failed" }` with `HTTP 500` in the
  detail, the request fired exactly ONCE (rejected, never retried),
  logged `failed`; a 403 is likewise not `performed`. The existing
  2xx happy path (201) still reports `performed: true`.
- **Mutation-proven**: removing the `!response.ok` branch → a 500
  reports `{ performed: true, status: 500 }` (the exact false-success
  bug) → both new tests fail; restore → 6/6. Full `pnpm check` EXIT 0
  (no downstream regression in the smart-home / web-action tools that
  reuse this primitive), `pnpm lint` 0/0. Actuator HTTP outcome
  (not an LLM request/response path) → no `smoke:live`.

## Decisions

- **Classify, don't retry** — a non-2xx is reported truthfully but the
  POST is never retried (double-action risk). The detail carries the
  status so the agent can tell the user "the booking was rejected
  (HTTP 403)".
- **`response.ok` is the line** — fetch follows 3xx by default, so the
  final response is 2xx (success) or 4xx/5xx (rejection). No bullet
  flip — P19's "one actuator" bullet is `[x]`; this is the
  per-actuator follow-on (web action) + an outbound-safety honesty
  improvement. CAPABILITIES line under P19.
