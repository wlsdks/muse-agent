# 490 — `parseMcpSecurityPolicyInput` caps `allowedStdioCommands` parallel to `allowedServerNames` (sibling-asymmetry)

## Why

`parseMcpSecurityPolicyInput`
(`apps/api/src/mcp-routes-parsers.ts:80`) admits two
admin-supplied allowlists for the MCP security policy:

- `allowedServerNames` — capped at **500 entries** (line 94).
- `allowedStdioCommands` — **no cap**.

Both allowlists arrive through the same `readStringArray` path,
share the identical input shape, and serve the same defensive
purpose (gate which MCP servers / stdio commands the runtime
will spawn). The 500-entry cap on `allowedServerNames` exists
because an admin endpoint must not let a caller smuggle a
huge allowlist past the body parser into the in-memory policy.
But the parallel cap on `allowedStdioCommands` was missed when
the field was added, so a 100k-entry stdio allowlist sails
through. Same shape, same security concern, only the cap was
asymmetric — exactly the sibling-asymmetry pattern goals
432 / 443 / 457 / 461 / 464 / 466 / 478-483 keep surfacing
("fix one, the sibling carrying the identical concrete gap
remains").

`mcp-routes-parsers.ts` had **no direct test file**. The
500-entry contract for `allowedServerNames` was implicit-only
— no test asserted it — so the missing parallel cap on
`allowedStdioCommands` was easy to miss.

## Slice

- `apps/api/src/mcp-routes-parsers.ts` — `parseMcpSecurityPolicyInput`
  now applies the same `> 500` check to `allowedStdioCommands`,
  returning the same `INVALID_MCP_SECURITY_POLICY` code with a
  parallel-shaped message
  (`"allowedStdioCommands must not exceed 500 entries"`).
  Behaviour byte-identical for every previously-valid input
  (≤ 500 entries each); only the asymmetric path is closed.
- `apps/api/test/mcp-routes-parsers.test.ts` — new file, first
  direct test of the parser: both fields at-cap (500) pass;
  `allowedServerNames` > 500 rejects (existing behavior pinned);
  `allowedStdioCommands` > 500 rejects (the new parallel cap);
  non-object body returns the right error code.

## Verify

- New test 4/4 green; full `@muse/api` suite green (208 passed,
  +4, 0 failed); tsc strict (api) EXIT=0.
- **Clean-mutation-proven** (Edit-based): removing the new
  `allowedStdioCommands > 500` block makes the corresponding
  test fail with the precise pre-fix symptom (`expected true
  to be false` — the 501-entry stdio allowlist returns
  `ok: true` instead of being rejected) while the other three
  tests stay green; fix restored, suite back to 4 green.
- `pnpm check` EXIT=0, every workspace green — no regression;
  `pnpm lint` 0/0; `pnpm guard:core` clean (no IMMUTABLE-CORE
  touched); byte-scan clean; `git status` shows only the two
  intended files.
- Pure deterministic parsing — no LLM / model
  request-response wire path; `smoke:live` does not apply
  (per `testing.md` / iteration-loop Step 9).

## Status

Done. The MCP security-policy parser now caps both allowlists
symmetrically — a 100k-entry stdio-commands payload no longer
slips past the input gate into the in-memory policy. First
direct coverage of `mcp-routes-parsers`.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets
are already `[x]` and audited; a sibling-asymmetry safety
`fix:` on the admin/policy input gate, recorded honestly with
this backlog row — not a false metric.

## Decisions

- Mirrored the `allowedServerNames` cap **byte-for-byte** (same
  500 threshold, same `INVALID_MCP_SECURITY_POLICY` code,
  parallel message wording) rather than picking a different
  number: the two fields are equally-shaped allowlists; a
  divergent cap is exactly the drift the parallel-shape design
  prevents.
- Added a new co-located test file (`apps/api/test/
  mcp-routes-parsers.test.ts`) rather than extending the
  existing `server.mcp.test.ts` integration suite: the
  parser's contract is pure-input-output, and a unit-level
  test file places the assertion next to the source it pins
  — same pattern goal 489 used for `compat-parsers.test.ts`.
- Distinct defect class from the recent 488 empty-env / 489
  lenient-parse run (sibling-asymmetry, not env shadowing or
  parse leniency) — Step-8 mix maintained.
