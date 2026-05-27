# 697 — P15 COMPLETE: confirmation-gated agentic web action — `performWebActionWithApproval` (fail-closed approval gate → injected-transport request → action-log) + `muse web-action`; absent confirmation ⇒ NO external effect, contract-faithful integration

## Why

P15 is the execute-tier: ACTING on the web (submit a form, book),
governed by `outbound-safety.md`. The action must be approval-gated and
never autonomous — its acceptance check must prove that absent
confirmation NO external effect occurs. This reuses the proven
fail-closed shape from `sendEmailWithApproval` (696) /
`performConsentedAction`, applied to a generic state-changing HTTP
request.

## Slice

- `packages/mcp/src/web-action.ts` (new): `performWebActionWithApproval`
  — presents the EXACT action (summary + request) to a fail-closed
  approval gate; deny OR a thrown gate (undeliverable prompt / timeout)
  ⇒ NO HTTP. On confirm, the request fires via the injected `fetchImpl`
  (with a 30s wall-clock cap); every outcome (performed / refused /
  failed / timed-out) appends a rationale-bearing action-log entry.
  A doc note marks banking/payments out of scope.
- `apps/cli/src/commands-web-action.ts` (new): `muse web-action --url
  --summary [--method --body]` — the surface; default gate prints the
  action + a `@clack/prompts` confirm; deps injectable for tests.

## Verify

- `@muse/mcp` web-action.test.ts (4) — the bullet's named check,
  contract-faithful (records the real request shape, never a fake
  flag): CONFIRM → exactly one request carrying the method+body + a
  `performed` log; DENY → 0 HTTP, `refused` logged; gate-throw
  (timeout) → 0 HTTP; never-autonomous (no approval) → 0 HTTP.
- `@muse/cli` commands-web-action.test.ts (2): confirm → done; deny →
  no HTTP, exit 1.
- **Clean-mutation-proven**: removing the `if (!decision.approved)
  return` guard makes a DENIED action fire — the DENY test catches it.
  Restored; green.
- `pnpm check`: EXIT=0 (cross-package: mcp + cli). `pnpm lint`: 0/0.
  `pnpm check:capabilities`: ✓. Byte-scan: clean.
- No LLM path touched — a gated HTTP request, faked in tests.

## Status

**P15 COMPLETE.** The gated web-action primitive exists with its
surface and the fail-closed safety proof. The natural future consumer
is an agent tool ("book X" → the agent constructs the request → this
gate), an additive slice on top of this primitive.

## Decisions

- **Mirror the 696 fail-closed shape, standalone** — `web-action.ts`
  duplicates the small gate→perform→log skeleton rather than
  prematurely extracting a shared core; if a third gated action
  appears, factor `performGatedAction` then (two users isn't yet a
  boundary worth the abstraction).
- **Injected transport, contract-faithful** — the test records the
  actual request (method/body), proving the gate controls a real HTTP
  call, never a "did it" flag.
- **Gate-throw is fail-closed** — a thrown approval gate is
  not-approved; an action never proceeds because confirmation failed.
- **Banking/payments out of scope** — stated in the module doc per
  `outbound-safety.md`; this primitive must not be used for money
  movement.

## Remaining risks

- **No agent-tool wiring yet** — the primitive is invokable via
  `muse web-action` (and directly by code); an agent tool that lets
  Muse decide to act on the web (still gated) is the natural next slice
  (needs the MCP/tool-approval seam since `@muse/tools` is zero-IO).
- **No recorded-consent layer beyond per-action approval** — every
  action is interactively confirmed + logged; a standing scoped
  consent (like `performConsentedAction`) for repeat actions could
  layer on later.
- **Raw request surface** — `muse web-action` takes a URL/method/body;
  a human rarely types these, but it is the gated primitive the agent
  will drive.
