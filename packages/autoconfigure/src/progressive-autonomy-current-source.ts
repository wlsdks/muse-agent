import { readAttunementState } from "@muse/attunement";
import { readTaskByIdStrict } from "@muse/stores";
import type { ProgressiveAutonomyRuntimeOpportunityReceipt } from "@muse/stores/host-progressive-autonomy-opportunities";

export type ProgressiveAutonomyCurrentSource =
  | { readonly state: "exact" }
  | { readonly reason: string; readonly state: "stale" | "unavailable" };

export async function resolveProgressiveAutonomyCurrentSource(
  opportunity: ProgressiveAutonomyRuntimeOpportunityReceipt,
  options: {
    readonly attunementFile: string;
    readonly ownerUserId: string;
    readonly tasksFile: string;
  }
): Promise<ProgressiveAutonomyCurrentSource> {
  if (opportunity.envelope.userId !== options.ownerUserId) {
    return { reason: "recorded opportunity belongs to a different user", state: "stale" };
  }
  let state: Awaited<ReturnType<typeof readAttunementState>>;
  let task: Awaited<ReturnType<typeof readTaskByIdStrict>>;
  try {
    [state, task] = await Promise.all([
      readAttunementState(options.attunementFile),
      readTaskByIdStrict(options.tasksFile, opportunity.envelope.link.taskId)
    ]);
  } catch {
    return { reason: "recorded source stores cannot be read or validated", state: "unavailable" };
  }
  const thread = state.threads.find((entry) => entry.id === opportunity.envelope.threadId);
  if (!thread) return { reason: "recorded thread is missing", state: "stale" };
  const link = thread.links.find((entry) => entry.artifactType === "task"
    && entry.artifactId === opportunity.envelope.link.taskId
    && entry.providerId === "local"
    && entry.role === "next-step"
    && entry.linkedBy === "user"
    && entry.linkedAt === opportunity.envelope.link.linkedAt);
  if (!link) return { reason: "exact user-authored local next-step link is stale", state: "stale" };
  if (!task) return { reason: "recorded task is missing", state: "stale" };
  if (task.status !== "open") return { reason: "recorded task is no longer open", state: "stale" };
  return { state: "exact" };
}
