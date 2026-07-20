/**
 * CLI binding of `@muse/recall`'s flows grounding stage: the scheduled-jobs
 * store path resolves through `@muse/scheduler`'s own env-aware resolver
 * (`defaultScheduledJobsFile` — honours `MUSE_SCHEDULED_JOBS_FILE`), mirroring
 * `ask-personal-store-grounding.ts`'s thin CLI shim. The selection + block
 * formatter (security-critical: the secret whitelist) live in `@muse/recall`.
 */

import { buildFlowsGroundingCore, type FlowsGrounding } from "@muse/recall";
import { defaultScheduledJobsFile } from "@muse/scheduler";

export type { FlowsGrounding } from "@muse/recall";

export async function buildFlowsGrounding(params: {
  readonly query: string;
  readonly flows: boolean;
}): Promise<FlowsGrounding> {
  const env = process.env as Record<string, string | undefined>;
  return buildFlowsGroundingCore({
    ...params,
    flowsFile: defaultScheduledJobsFile(env)
  });
}
