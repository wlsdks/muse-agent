# 752 — feat: state-changing Chrome action is gated draft-first (P18 bullet 2 FLIP)

## Why

P18's second bullet: a state-changing web action under the user's
logged-in Chrome must be approval-gated + draft-first, and a denied /
failing gate must produce NO external effect. The gap: external MCP
tools default to risk `"read"` (`riskFromMcpAnnotations` → read when
unannotated), and we must NOT trust a third-party browser-control
server's annotations for the user's real session. So a `fill_form` /
`click` / `submit` would reach the browser ungated.

## Slice

`@muse/mcp`:
- `chromeDevToolsToolRisk(toolName)` — deterministic, fail-close risk
  classifier: pure-observation tools (`take_snapshot`, `list_*`,
  `get_*`, `wait_for`, …) → `read`; arbitrary-code / file / dialog
  (`evaluate_script`, `upload_file`, `handle_dialog`) → `execute`;
  everything else INCLUDING UNKNOWN tool names → `write`. The browser
  drives the user's logged-in session, so unknown ⇒ risky is the safe
  default.
- `withChromeDevToolsRisk(tools)` — re-stamps the risk of
  `chrome-devtools.*` tools projected by `McpManager.toMuseTools()`
  using the classifier, so the AgentRuntime `toolApprovalGate` fires
  on a state-changing action. Non-Chrome tools pass through.

## Verify

- `@muse/mcp` chrome-devtools-mcp.test.ts (+4): classifier read/write/
  execute/unknown→write; `withChromeDevToolsRisk` elevates `fill_form`,
  leaves `take_snapshot` read, passes non-Chrome tools through.
- `@muse/autoconfigure` chrome-devtools-gated-action.test.ts (new, 3),
  end-to-end through `McpManager.toMuseTools()` →
  `withChromeDevToolsRisk` → `ToolRegistry` → `AgentRuntime.run()` with
  a fail-close `toolApprovalGate` and a contract-faithful fake
  `McpConnection` whose `callTool` is a spy:
  - DENIED gate → `fill_form` never reaches the browser (`callTool`
    NOT called) AND the gate was consulted with risk `write` + the
    exact action args (draft-first).
  - FAILING gate (throws — timeout / undeliverable approval) →
    fail-close, `callTool` NOT called.
  - `take_snapshot` (read) is NOT gated — runs without approval (read
    perception isn't over-gated).
- **Mutation-proven**: flipping the classifier's fail-close default
  `write`→`read` (+ rebuild `@muse/mcp`) makes `fill_form` ungated →
  the deny test fails; restore + rebuild → green.
- Full `pnpm check` EXIT 0 (mcp 674, autoconfigure 166, every
  workspace green); `pnpm lint` 0/0. Fake provider + fake gate, no
  real LLM round-trip → no `smoke:live`.

## Decisions

- **Fail-close by tool name, not by trusting MCP annotations.** The
  external server drives the real logged-in browser; unknown ⇒ `write`
  guarantees a new/unrecognised state-changing tool still clears the
  gate.
- **Expose write tools, gate at execution** (the test uses an
  `allowWriteWithoutMutationIntent` exposure policy). When the user
  asks Muse to act on the page, the model SHOULD be able to propose
  the action; the approval gate — not silent hiding — is the
  draft-first guard. Banking / payments stay out of scope.
- "Ambiguous-target" isn't applicable to a same-page form action (no
  recipient resolution); deny + failing-gate cover the gate's
  fail-close contract.
