import {
  createModelDroppedContextSummarizer,
  type AgentRuntimeOptions
} from "@muse/agent-core";
import type { ModelProvider } from "@muse/model";

import {
  admitAuxiliaryModel,
  type AuxiliaryModelAdmission
} from "./autoconfigure-model-provider.js";
import type { MuseEnvironment } from "./index.js";

export interface CompactionAuxiliary {
  readonly admission: AuxiliaryModelAdmission;
  readonly summarizer?: NonNullable<AgentRuntimeOptions["contextSummarizer"]>;
}

export function createCompactionAuxiliary(
  provider: ModelProvider,
  sessionModel: string,
  env: MuseEnvironment
): CompactionAuxiliary {
  const admission = admitAuxiliaryModel({
    env,
    isPersonalContext: true,
    sessionModel,
    task: "compaction"
  });
  return Object.freeze({
    admission,
    ...(admission.available
      ? { summarizer: createModelDroppedContextSummarizer(provider, admission.model) }
      : {})
  });
}
