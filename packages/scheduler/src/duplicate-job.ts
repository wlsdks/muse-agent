import type { ScheduledJob, ScheduledJobInput } from "./index.js";

export interface DuplicateJobOptions {
  /** Appended to the source name so the copy is distinguishable, e.g. " (copy)". */
  readonly nameSuffix: string;
}

/**
 * Build a create-input that duplicates a job's CONFIGURATION only. Every
 * schedule/action field is copied so the copy runs identically, but:
 *
 * - no `id` is carried, so `service.create` mints a fresh one (a duplicate is
 *   a new job, never an alias of the source);
 * - the copy is created `enabled: false` — a duplicated schedule must never
 *   silently start firing behind the user's back; they review and enable it
 *   (draft-first);
 * - none of the source's execution lifecycle (`lastRunAt` / `lastStatus` /
 *   `lastResult`) or timestamps come along — the copy has its own history.
 *
 * The name gets `nameSuffix` appended so the copy is distinguishable in the
 * list without a rename step.
 */
export function buildDuplicateJobInput(job: ScheduledJob, options: DuplicateJobOptions): ScheduledJobInput {
  return {
    agentMaxToolCalls: job.agentMaxToolCalls ?? null,
    agentModel: job.agentModel ?? null,
    agentPrompt: job.agentPrompt ?? null,
    agentSystemPrompt: job.agentSystemPrompt ?? null,
    cronExpression: job.cronExpression,
    description: job.description ?? null,
    enabled: false,
    executionTimeoutMs: job.executionTimeoutMs ?? null,
    jobType: job.jobType,
    maxRetryCount: job.maxRetryCount,
    mcpServerName: job.mcpServerName ?? null,
    name: `${job.name}${options.nameSuffix}`,
    notificationChannelId: job.notificationChannelId ?? null,
    personaId: job.personaId ?? null,
    retryOnFailure: job.retryOnFailure,
    tags: [...job.tags],
    timezone: job.timezone,
    toolArguments: job.toolArguments,
    toolName: job.toolName ?? null,
    webhookUrl: job.webhookUrl ?? null
  };
}
