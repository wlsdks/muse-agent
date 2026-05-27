## 858 — fix: enabling Chrome DevTools MCP isn't silently denied by an unrelated strict allowlist

## Why

`MUSE_CHROME_DEVTOOLS_ENABLED=true` auto-registers the Chrome DevTools
MCP preset (turnkey P18 — drive the user's real logged-in browser). But
the MCP security allowlist (`MUSE_MCP_ALLOWED_SERVERS`) was read
independently: a **non-empty** allowlist is strict (empty/absent =
allow-all), and both `McpManager.register` and `.connect` enforce
`allowedServerNames.length === 0 || includes(name)`. So a user on a
shared/multi-MCP workstation who pins an allowlist of other servers
(e.g. `filesystem,github`) AND turns Chrome on gets `chrome-devtools`
**silently denied** — their explicit enable does nothing, with no error.
This is exactly the "daemon Chrome wiring blocked" symptom: enabled but
unreachable.

## Slice — honor the explicit enable in the allowlist

`@muse/autoconfigure` mcp-stack.ts: when `MUSE_CHROME_DEVTOOLS_ENABLED`
is true and the configured allowlist is **non-empty** and omits
`chrome-devtools`, add `chrome-devtools` to it. An empty/absent
allowlist is left exactly as-is — appending would flip allow-all into a
one-entry strict list that blocks every other server (the regression
the `length > 0` guard prevents). The user's other allowlisted servers
are untouched.

## Verify

`@muse/autoconfigure` mcp-stack-chrome-devtools.test.ts (+3, drives the
REAL `assembleMcpStack` → `securityPolicyProvider.isServerAllowed`):
- strict allowlist of OTHER servers + Chrome enabled → `chrome-devtools`
  IS allowed, `filesystem` still allowed, a random server still denied;
- EMPTY allowlist + Chrome enabled → stays allow-all (a random server
  still allowed — not flipped to a 1-entry strict list);
- Chrome NOT enabled + strict allowlist → `chrome-devtools` stays denied
  (the user's strict allowlist is respected).
- **Mutation-proven**: removing the allow logic fails the strict-allowlist
  test; dropping the `length > 0` guard fails the allow-all test.
- `pnpm check` EXIT 0, `pnpm lint` 0/0. (No LLM request/response path —
  MCP policy assembly only — so no smoke:live.)

## Decisions

- **Gate on the enable flag, not on auto-registration.** Whether Chrome
  was auto-registered or hand-declared in mcp.json, an explicit
  `MUSE_CHROME_DEVTOOLS_ENABLED` is the user's intent to use it, so the
  allow is keyed on the flag. A user who declares chrome in mcp.json
  WITHOUT the flag and excludes it from a strict allowlist still has it
  denied — that's their explicit allowlist choice, respected.
- **`length > 0` is load-bearing.** `parseCsv` returns
  `readonly string[] | undefined`; undefined/empty means allow-all, so
  the append must never touch it (a spread builds a new array, never
  mutating the readonly result).
- No new dependency.
