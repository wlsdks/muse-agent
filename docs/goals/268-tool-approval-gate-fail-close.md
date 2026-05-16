# 268 — a throwing tool-approval gate crashed the run instead of failing closed

## Why

CLAUDE.md non-negotiable: **"Guards are fail-close."** The
input/output guard pipeline honours this — `evaluateGuards`
wraps `guard.evaluate(...)` in try/catch and converts any throw
into a block. The **tool-approval gate** in `AgentRuntime` (the
deterministic permission gate that enforces `~/.muse/trust.json`:
read tools pass, execute tools need a `trustedTools` entry,
`blockedTools` always rejected) did **not**:

```ts
if (this.toolApprovalGate) {
  const risk = this.resolveToolRisk(toolCall.name);
  const decision = await this.toolApprovalGate({ risk, runId, toolCall, userId });
  if (!decision.allowed) { …blockedToolResult… }
}
```

No try/catch. The gate's data source is a file
(`~/.muse/trust.json`); a corrupt / partially-written /
permission-denied file (or any bug in a gate implementation)
makes the gate **throw**. That exception propagates out of the
per-tool execution, past the model loop (which only catches
count/deadline, not arbitrary throws), and rejects the **entire
agent run** — a confusing crash on every tool-using turn until
the file is hand-repaired, instead of the deterministic
fail-close a permission gate must guarantee.

## Scope

`packages/agent-core/src/agent-runtime.ts`:

- Wrap the `toolApprovalGate(...)` call in try/catch. On throw,
  synthesise `{ allowed: false, reason: "approval gate error:
  <message>" }`, which flows into the existing
  `!decision.allowed` → `blockedToolResult` path. The tool is
  blocked, the model sees the rejection, the run continues and
  history records it — identical handling to an explicit
  `{ allowed: false }`.
- Added the missing `ToolApprovalGateDecision` to the in-scope
  `import type` (it was only re-exported, not imported — caught
  by `tsc` in `pnpm check`, root-cause fixed, no check weakened).

One call wrapped; the allow path, the explicit-deny path, and
every other behaviour are unchanged. Now matches the
`evaluateGuards` fail-close pattern.

## Verify

- `pnpm --filter @muse/agent-core test` — 534 pass (was 533;
  +1). New test wires a `toolApprovalGate` that throws (simulating
  a corrupt trust.json) for an `execute`-risk tool and asserts the
  executor is **never** called and the run completes cleanly with
  the model's post-block message — pre-fix the throw rejected the
  whole `runtime.run(...)`. The existing
  "gate can block" / "gate allows through" tests stay green.
- `pnpm check` — every workspace green (agent-core build+534,
  apps/cli 560, apps/api 155, all packages). `pnpm lint` —
  exit 0. (A first `pnpm check` surfaced a `tsc` error from the
  not-yet-imported decision type; root-caused to the import block
  and fixed — the narrow `vitest` run had transpiled per-file and
  missed it, which is exactly why the authoritative `tsc` gate
  exists.)
- No real-LLM request/response path meaningfully touched
  (security control-flow hardening of the gate; the throw path is
  deterministically unit-tested — a live Qwen run cannot
  reproducibly make the gate throw, so the unit test is the
  rigorous verification, the same stance the guard-pipeline
  fail-close work uses).

## Status

done — the tool-approval gate now fails closed: a corrupt
trust.json (or any throwing gate) blocks the tool and the run
proceeds, instead of crashing the whole agent. The permission
gate is deterministic and fail-close as the architecture mandates,
consistent with the input/output guard pipeline.
