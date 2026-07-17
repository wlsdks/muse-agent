import {
  FileProgressiveAutonomyOpportunityStore,
  type ProgressiveAutonomyRuntimeDecisionInput,
  type ProgressiveAutonomyRuntimeDecisionRecordResult
} from "@muse/stores/host-progressive-autonomy-opportunities";

import { resolveProgressiveAutonomyCurrentSource } from "./progressive-autonomy-current-source.js";

export type ProgressiveAutonomyRuntimeDecisionRecorder = (
  input: ProgressiveAutonomyRuntimeDecisionInput
) => Promise<ProgressiveAutonomyRuntimeDecisionRecordResult | undefined>;

export function createProgressiveAutonomyRuntimeDecisionRecorder(
  options: {
    readonly attunementFile: string;
    readonly opportunitiesFile: string;
    readonly ownerUserId: string;
    readonly tasksFile: string;
  }
): ProgressiveAutonomyRuntimeDecisionRecorder {
  const store = new FileProgressiveAutonomyOpportunityStore({ file: options.opportunitiesFile });
  return async (input) => {
    try {
      if (input.ownerUserId !== options.ownerUserId) return { kind: "not-correlated" };
      const opportunity = (await store.list()).find((entry) => entry.evidenceClass === "organic"
        && entry.runId === input.runId
        && entry.toolCallId === input.toolCallId
        && entry.envelope.userId === input.ownerUserId);
      if (!opportunity) return { kind: "not-correlated" };
      const source = await resolveProgressiveAutonomyCurrentSource(opportunity, options);
      if (source.state !== "exact") return { kind: "not-correlated" };
      return await store.recordRuntimeDecision(input);
    } catch {
      // Fail-soft evidence only: recording must never change the tool decision.
      return undefined;
    }
  };
}
