# @muse/tools

The `MuseTool` contract and the runtime pieces that execute against it: the tool registry,
executor, exposure/filtering policy, and the risky-local-execution bridge into `crates/runner`.
It is a package because every surface (CLI, server, MCP projection) needs the identical
`MuseTool` shape and execution/approval semantics — this is where that shape is defined once.

## Public surface

- `MuseTool`, `MuseToolDefinition`, `MuseToolContext`, `ToolExecutionResult` — the core tool
  contract: name, description, `inputSchema`, `risk`, optional `groundedArgs`/`argumentAliases`.
- `ToolRegistry` — registration, `toModelTools()`, `selectForContext()`/`planForContext()`.
- `ToolExecutor` — the execution loop that turns a `ToolCallRequest` into a
  `ToolExecutionResult`, including idempotency and effect verification.
- `createMuseTools` — the concrete built-in tool factory.
- `DefaultToolExposurePolicy`, `createWorkspaceToolRoutingPlan`, `filterToolsForContext` — the
  context-based tool-set filtering that keeps the exposed set small per turn.
- `createRustRunnerTool`, `invokeRustRunner` — the bridge into `crates/runner` for risky local
  execution.
- `classifyDangerousCommand`, `classifyCommandTopology` — deterministic shell-command risk
  classification.
- `authorizeEgress`, `createEgressAuthority`, `collectUrlsFromValue` — outbound-URL egress
  authorization for tool arguments.
- `validateRequiredToolArguments`, `coerceToolArguments`, `canonicalizeToolArgumentAliases` —
  schema-driven argument validation/repair.

## Depends on

- `@muse/model` — the `ModelTool` shape a `MuseToolDefinition` projects into for a provider.
- `@muse/policy` — `SanitizedToolOutput` and `ToolExposureAuthority` types tools operate under.
- `@muse/resilience` — the `RetryBudget` type threaded through tool-call retries.
- `@muse/shared` — shared JSON types.

## Rules that bind this package

- [`../../.claude/rules/safety/tool-calling.md`](../../.claude/rules/safety/tool-calling.md) — `MuseToolDefinition`'s name/description/schema shape
  and the exposure-policy filtering exist specifically to make the local model's first tool
  call correct in one shot.
- [`../../.claude/rules/safety/outbound-safety.md`](../../.claude/rules/safety/outbound-safety.md) — a tool's `risk` classification (read/write/execute)
  and `authorizeEgress` are the fail-close gate for any state-changing or outbound action.
- [`../../.claude/rules/engineering/architecture.md`](../../.claude/rules/engineering/architecture.md) — risky local execution flows through `crates/runner`
  via `createRustRunnerTool`, never a direct shell call from this package.

## Tests

```bash
pnpm --filter @muse/tools test
```
