# Core Contract Audit - 2026-07-15

## Scope

This audit traced the production agent paths for cancellation, fallback, tool
loops, approval, MCP boundary handling, run history, and tracing. It focused
on evidence-backed P0/P1 defects rather than broad test fan-out.

## Verified contracts

- Model fallback and circuit breaking rethrow cancellation-like errors rather
  than retrying or falling back after a cancelled turn.
- Tool output is sanitized by `ToolExecutor` and neutralized/capped again
  before re-entering model context.
- Agent tool loops enforce wall-clock, call-count, output-size, post-compaction,
  ping-pong, and batch-write conflict bounds.
- Approval receipts bind user, session, run, operation, arguments, target,
  risk, expiry, nonce, and trace identity; the in-memory store consumes them
  atomically once.
- Direct API chat is read-only by default. When write chat is enabled, write
  and execute calls are captured as drafts and denied until a user approval
  action is persisted.
- External MCP registration rejects reserved `muse.` names, enforces policy and
  static launch audits, validates remote endpoints, and uses bounded requests.

## Fixed P1 defects

1. Tool cancellation was converted into an ordinary failed observation by the
   generic tool executor. It now propagates as a terminal cancellation.
2. MCP tool invocation and plan-tool execution had independent catch-all
   boundaries that could similarly convert cancellation into model-visible
   failures. Both now propagate the shared cancellation classification.
3. Run history supported `cancelled` but recorded every terminal exception as
   `failed`. Cancellation-like errors now record `cancelled`.

## Focused verification

The following package builds passed after the changes:

```text
@muse/resilience
@muse/tools
@muse/mcp
@muse/agent-core
```

## Residual risks

- This was a structural and compile-time audit. No live external MCP server or
  model-provider cancellation scenario was executed, to avoid unbounded or
  provider-dependent test work.
- Administrative MCP routes intentionally invoke the MCP manager directly;
  they are authenticated management operations, not model-selected tool calls.
  They must remain isolated from any future unauthenticated route surface.
