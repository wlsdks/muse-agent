import type { AgentRunInput, AgentRunResult } from "@muse/agent-core";
import { attenuateToolExposureAuthority } from "@muse/policy";

import type { AgentWorker } from "./workers.js";

/** Thrown when a run stops before a delegated worker starts. */
export class OrchestrationCancelledError extends Error {
  constructor(runId: string) {
    super(`orchestration ${runId} cancelled by user`);
    this.name = "OrchestrationCancelledError";
  }
}

/**
 * The single worker-start gate shared by supervisor and orchestrator paths.
 * Authority is attenuated synchronously before the final cancellation check;
 * after that check there is deliberately no await/yield before `worker.run`.
 */
export function dispatchDelegatedWorker(
  worker: AgentWorker,
  input: AgentRunInput,
  isCancelled: () => boolean
): Promise<AgentRunResult> {
  const authority = attenuateToolExposureAuthority(input.toolExposureAuthority, worker.toolNames);
  const delegatedInput = authority === undefined && input.toolExposureAuthority === undefined
    ? input
    : { ...input, toolExposureAuthority: authority };

  if (isCancelled()) {
    return Promise.reject(new OrchestrationCancelledError(input.runId ?? "unknown"));
  }
  return worker.run(delegatedInput);
}
