import type { AgentRunInput, AgentRunResult } from "@muse/agent-core";
import { attenuateToolExposureAuthority } from "@muse/policy";

import { claimDelegatedWorkerStart, type AgentWorker } from "./workers.js";

/** Thrown when a run stops before a delegated worker starts. */
export class OrchestrationCancelledError extends Error {
  constructor(runId: string) {
    super(`orchestration ${runId} cancelled by user`);
    this.name = "OrchestrationCancelledError";
  }
}

/**
 * The single worker-start gate shared by supervisor and orchestrator paths.
 * Cancellation, one-shot lease consumption, and authority attenuation happen
 * synchronously; there is deliberately no await/yield before `worker.run`.
 */
export function dispatchDelegatedWorker(
  worker: AgentWorker,
  input: AgentRunInput,
  isCancelled: () => boolean
): Promise<AgentRunResult> {
  if (isCancelled()) {
    return Promise.reject(new OrchestrationCancelledError(input.runId ?? "unknown"));
  }

  let leaseScope;
  try {
    leaseScope = claimDelegatedWorkerStart(worker);
  } catch (cause) {
    return Promise.reject(cause);
  }
  const hasIncompleteScope = leaseScope === undefined
    && (worker.writablePaths === undefined) !== (worker.scopeExpiresAt === undefined);
  const leaseToolNames = leaseScope
    ? worker.toolNames === undefined
      ? leaseScope.allowedToolNames
      : worker.toolNames.filter((name) => leaseScope.allowedToolNames.includes(name))
    : worker.toolNames;
  const delegatedScope = leaseScope
    ?? (worker.writablePaths !== undefined && worker.scopeExpiresAt !== undefined
      ? { expiresAt: worker.scopeExpiresAt, writablePaths: worker.writablePaths }
      : undefined);
  const authority = attenuateToolExposureAuthority(
    input.toolExposureAuthority,
    hasIncompleteScope ? [] : leaseToolNames,
    delegatedScope
  );
  const delegatedInput = authority === undefined && input.toolExposureAuthority === undefined
    ? input
    : { ...input, toolExposureAuthority: authority };

  return worker.run(delegatedInput);
}
