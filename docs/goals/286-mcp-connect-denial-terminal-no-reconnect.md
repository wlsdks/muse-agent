# 286 — an allowlist-denied MCP server was put on an endless reconnect loop

## Why

The MCP allowlist (`McpSecurityPolicy.allowedServerNames`,
goal 032) is a CLAUDE.md architecture non-negotiable, enforced in
two layers — at register time and again at connect time so policy
drift can't silently activate a now-disallowed server.
`McpManager.connect` collapsed three very different failure
conditions into one branch:

```ts
if (!server || !(await securityPolicyProvider.isServerAllowed(name)) || !this.connector) {
  this.statuses.set(name, server ? "disabled" : "failed");
  this.scheduleReconnect(name, server ? "Server denied or connector unavailable" : "Server not found");
  return false;
}
```

A server **denied by the allowlist** (server exists,
`isServerAllowed` false) was marked `disabled` **and then
`scheduleReconnect`-ed** — an unbounded retry timer for a server
the policy explicitly forbids. The gate still holds (each
reconnect re-checks the allowlist and re-denies, so a denied
server never actually connects — not an auth bypass), but:

- it spins a reconnect timer forever for a policy-forbidden
  server (the timer fires, re-denies, reschedules, …), and
- it is **inconsistent** with the two sibling denial paths that
  correctly treat `disabled` as terminal: register-time denial
  (`register` sets `disabled` + an unhealthy snapshot, no
  reconnect) and the connect-time fingerprint-mismatch branch
  (`disabled` + unhealthy, `return false`, no reconnect).

So the same logical outcome ("policy refuses this server") was
terminal on two paths and a retry loop on the third — a silent
robustness/consistency defect on a security-critical surface.

## Scope

`packages/mcp/src/manager.ts` — `connect`:

- Split the terminal **policy-denial** out and handle it first:
  `disabled` + an unhealthy health snapshot
  (`"Server denied by security policy"`), `return false`, **no
  `scheduleReconnect`** — mirroring register-time denial and the
  fingerprint-mismatch branch. One short WHY comment records the
  gate-don't-retry rationale.
- The remaining `!server` / `!connector` branch keeps its exact
  prior behaviour (`failed` + reconnect "Server not found";
  `disabled` + reconnect "Connector unavailable" — message
  de-conflated now that denial is handled separately).

`isServerAllowed` is still evaluated once (only when the server
exists, same short-circuit as before for the not-found case). The
allow path and every subsequent step are unchanged.

## Verify

- `pnpm --filter @muse/mcp test` — 343 pass. New regression: a
  pre-seeded server absent from `allowedServerNames` →
  `connect()` returns `false`, status `disabled`, **and**
  `getHealth(...).nextReconnectAt` is `undefined`,
  `reconnectAttempts` is `0`, `reconnectDue()` resolves `[]`
  (pre-fix: a reconnect was armed). The existing goal-032
  connect-denial test (`false` + `disabled`), register-time
  denial, and the health-failure reconnect-with-backoff test
  stay green.
- `pnpm check` — every workspace green (mcp 343, apps/cli 561,
  apps/api 160, all packages). `pnpm lint` — exit 0.
- No real-LLM request/response path touched (deterministic MCP
  allowlist control flow). A live Qwen run cannot reproduce a
  policy-denied reconnect loop on demand, so the deterministic
  regression is the rigorous verification — same stance as the
  security goals 032 / 268 / 269 and 261 / 274–285.

## Status

done — an allowlist-denied MCP server is now terminally
`disabled` with no reconnect timer, consistent with the
register-time and fingerprint-mismatch denial paths. The
allowlist gates connections instead of retrying one it forbids;
the not-found / connector-unavailable behaviour is unchanged.
