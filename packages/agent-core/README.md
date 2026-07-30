# @muse/agent-core

The model-agnostic agent runtime: the tool-calling loop, guard/hook pipeline, grounding and
citation enforcement, and the correction/playbook learning primitives. It owns the seam
between "a model returned some text/tool-calls" and "Muse trusts, records, or acts on that" —
which is why it is a package and not a folder inside a provider adapter.

## Public surface

- `AgentRuntime`, `createAgentRuntime`, `AgentRuntimeOptions` — the run loop: model calls,
  tool dispatch, `ToolApprovalGate`, egress advisories, loop-control receipts.
- `HookRegistry`, `createInjectionInputGuard`, `createPiiInputGuard`,
  `createTopicDriftInputGuard`, `createSystemPromptLeakageOutputGuard` — the input/output
  guard pipeline (fail-close deterministic gates, never a prompt instruction).
- `verifyGrounding`, `verifyGroundingPerClaim`, `enforceAnswerCitations`, `rankKnowledgeChunks`,
  `segmentClaims` — grounding verification and citation enforcement over retrieved chunks.
- `applyPlaybook`, `rankPlaybookStrategies`, `distillStrategyFromCorrection`,
  `classifyCorrectionContradiction` — the correction-to-strategy learning pipeline.
- `orchestrateAnswer`, `produceCouncilReasoning`, `moaFanout` — multi-model council/debate
  and mixture-of-agents fan-out.
- `parsePlan`, `validatePlan`, `executeToolPlan` — multi-step tool-plan validation/execution.
- `createAgentCheckpointState`, `resumeRunInputFromCheckpoint` — run checkpoint/resume.
- `checkActuatorProvenance`, `resolveThirdPartySendRoute`, `OUTBOUND_SEND_TOOL_NAMES`,
  `A2ASafetyError` — provenance/taint tracking for arguments flowing into an outbound send.

## Depends on

- `@muse/model` — the `ModelProvider`/`ModelRequest`/`ModelResponse` contract it drives.
- `@muse/tools` — the `MuseTool` execution contract the run loop dispatches into.
- `@muse/policy` — sanitized tool output, capability profiles, and progressive-autonomy types.
- `@muse/memory` — conversation trimming, compaction, and user-model slot types.
- `@muse/prompts` — system-prompt assembly consumed by the runtime.
- `@muse/shared`, `@muse/runtime-state`, `@muse/resilience`, `@muse/observability`,
  `@muse/cache` — shared types, checkpoint state, retry/timeout, telemetry, and caching.

## Rules that bind this package

- [`../../.claude/rules/engineering/architecture.md`](../../.claude/rules/engineering/architecture.md) — this package is the model-agnostic core: it must
  never import a vendor SDK directly, only `ModelProvider` from `@muse/model`.
- [`../../.claude/rules/safety/outbound-safety.md`](../../.claude/rules/safety/outbound-safety.md) — `actuator-provenance-gate.ts` and `a2a-safety.ts`
  enforce the fail-close gate for any argument or payload reaching a third-party send.
- [`../../.claude/rules/verification/agent-testing.md`](../../.claude/rules/verification/agent-testing.md) — grounding, playbook, and council code here is
  evaluated as agent behavior (`pass^k`, terminal-state grading), not just unit-tested.

## Tests

```bash
pnpm --filter @muse/agent-core test
```
