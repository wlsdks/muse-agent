# @muse/multi-agent

Owns Muse's sub-agent orchestration: decomposing a request into subtasks, running them
sequentially or in parallel across workers, fan-in synthesis/verification/conflict detection, and
the durable task-board/handoff state that makes a delegation resumable. One worker contract and
one termination discipline is why this is a package, not a folder.

## Public surface

- `MultiAgentOrchestrator`, `SupervisorAgent`, `runLeadWorkerTask`, `detectSubtaskConflicts`,
  `detectSubtaskRedundancies` — confidence-scored handoff routing, and fan-out/fan-in
  orchestration with cross-worker conflict/redundancy detection on the merged result.
- `buildOrchestrationResponse`, `OrchestrationRunOptions`, `decomposeRequest`, `shouldDecompose` —
  the sequential/parallel run surface, fan-in synthesis, a post-synthesis `verifyFinalAnswer`
  check, and the deterministic decomposition trigger.
- `RuntimeAgentWorker`, `createRuntimeAgentWorker`, `createCascadeRuntimeAgentWorker`,
  `planTieredRun`, `runCascade`, `classifyTier` — the worker contract, its implementations, and
  cost-tiered (light/heavy model) planning/cascade execution.
- `addTask`, `expandTaskIntoSubtasks`, `transitionTask`, `FileAgentTaskBoard`,
  `assessDelegationFanout`, `bindDelegationSubtaskScope`, `assessGoalActionBudget`,
  `projectGoalProgress`, `InMemoryAgentMessageBus`, `InMemoryOrchestrationHistoryStore`,
  `SubAgentRunRegistry` — the durable task-board model, bounded fan-out scoping, standing-goal
  tracking, and in-memory messaging/history/run stores.

## Depends on

- `@muse/agent-core` — the agent run loop each worker executes.
- `@muse/memory`, `@muse/model` — goal-progress evidence and model-tier selection for cascade runs.
- `@muse/policy`, `@muse/shared`, `@muse/stores` — policy, primitives, orchestration-history state.

## Rules that bind this package

Multi-agent hand-offs are a first-class evaluation surface under
[`../../.claude/rules/verification/agent-testing.md`](../../.claude/rules/verification/agent-testing.md): schema-validated
hand-offs, bounded/verification-backed termination, and non-overlapping sub-tasks —
`detectSubtaskConflicts`/`detectSubtaskRedundancies` catch the MAST failures it names. `agent-core`
is model-agnostic per [`../../.claude/rules/engineering/architecture.md`](../../.claude/rules/engineering/architecture.md);
worker code here must not hard-wire a provider SDK.

## Tests

```bash
pnpm --filter @muse/multi-agent test
pnpm --filter @muse/multi-agent eval:orchestration
```
