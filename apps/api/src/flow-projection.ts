/**
 * Pure projection: a real `ScheduledJob` → the read-only node/edge shape
 * the "흐름" (Flows) canvas renders. Every field here is copied straight
 * from the job — no synthesized text, no model call, fabrication 0. The
 * scheduler is the only source; this module never mutates it.
 */

import { computeNextRunAt, type ScheduledJob } from "@muse/scheduler";

export type FlowNodeKind =
  | "trigger.schedule"
  | "action.agent"
  | "action.tool"
  | "output.notify"
  | "output.webhook"
  | "output.record";

export interface FlowNode {
  readonly id: string;
  readonly kind: FlowNodeKind;
  readonly label: string;
  readonly meta: Record<string, string | number | boolean | null>;
}

export interface FlowEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly label?: string;
  readonly loop?: boolean;
}

export interface FlowProjection {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly source: "scheduler";
  readonly nextRunAtIso: string | null;
  readonly nodes: readonly FlowNode[];
  readonly edges: readonly FlowEdge[];
}

const PROMPT_PREVIEW_MAX = 200;

/** Projects one scheduler job into a linear trigger → action → output flow. */
export function projectFlow(job: ScheduledJob, now: Date = new Date()): FlowProjection {
  const triggerId = `${job.id}::trigger`;
  const actionId = `${job.id}::action`;
  const outputId = `${job.id}::output`;

  // A disabled flow does NOT fire, so it has no next run — computing one
  // would make the list + trigger node show a "Next run 9:00 AM" for a flow
  // that will never run (a dishonest state). The cron/timezone stay in the
  // meta so the schedule config is still visible while paused.
  const nextRunAtIso = job.enabled ? safeNextRunAtIso(job, now) : null;

  const nodes: FlowNode[] = [
    {
      id: triggerId,
      kind: "trigger.schedule",
      label: "trigger.schedule",
      meta: {
        cronExpression: job.cronExpression,
        nextRunAtIso,
        timezone: job.timezone
      }
    },
    projectActionNode(job, actionId),
    projectOutputNode(job, outputId)
  ];

  const edges: FlowEdge[] = [
    { from: triggerId, id: `${job.id}::edge-trigger-action`, to: actionId },
    { from: actionId, id: `${job.id}::edge-action-output`, to: outputId }
  ];

  if (job.retryOnFailure) {
    edges.push({
      from: actionId,
      id: `${job.id}::edge-retry`,
      label: `실패 시 재시도 ×${job.maxRetryCount}`,
      loop: true,
      to: actionId
    });
  }

  return {
    edges,
    enabled: job.enabled,
    id: job.id,
    name: job.name,
    nextRunAtIso,
    nodes,
    source: "scheduler"
  };
}

/** Projects every job and sorts: enabled first, then soonest next-run. */
export function projectFlows(jobs: readonly ScheduledJob[], now: Date = new Date()): FlowProjection[] {
  return jobs.map((job) => projectFlow(job, now)).sort(compareFlows);
}

function compareFlows(left: FlowProjection, right: FlowProjection): number {
  if (left.enabled !== right.enabled) {
    return left.enabled ? -1 : 1;
  }
  if (left.nextRunAtIso === null && right.nextRunAtIso === null) return 0;
  if (left.nextRunAtIso === null) return 1;
  if (right.nextRunAtIso === null) return -1;
  return left.nextRunAtIso.localeCompare(right.nextRunAtIso);
}

function safeNextRunAtIso(job: ScheduledJob, now: Date): string | null {
  try {
    return computeNextRunAt(job, now).toISOString();
  } catch {
    return null;
  }
}

function projectActionNode(job: ScheduledJob, actionId: string): FlowNode {
  if (job.mcpServerName || job.toolName) {
    return {
      id: actionId,
      kind: "action.tool",
      label: "action.tool",
      meta: {
        server: job.mcpServerName ?? null,
        tool: job.toolName ?? null
      }
    };
  }

  const prompt = job.agentPrompt?.trim() ?? "";
  return {
    id: actionId,
    kind: "action.agent",
    label: "action.agent",
    meta: {
      maxToolCalls: job.agentMaxToolCalls ?? null,
      model: job.agentModel ?? null,
      prompt: truncatePrompt(prompt)
    }
  };
}

function truncatePrompt(prompt: string): string {
  return prompt.length <= PROMPT_PREVIEW_MAX ? prompt : `${prompt.slice(0, PROMPT_PREVIEW_MAX - 1).trimEnd()}…`;
}

function projectOutputNode(job: ScheduledJob, outputId: string): FlowNode {
  if (job.notificationChannelId) {
    return {
      id: outputId,
      kind: "output.notify",
      label: "output.notify",
      meta: { channelId: job.notificationChannelId }
    };
  }

  if (job.webhookUrl) {
    return {
      id: outputId,
      kind: "output.webhook",
      label: "output.webhook",
      meta: { url: webhookHost(job.webhookUrl) }
    };
  }

  return {
    id: outputId,
    kind: "output.record",
    label: "output.record",
    meta: {}
  };
}

/**
 * Never project the full webhook URL — it can carry a secret in its query
 * string. Show only the host (defensively stripping the query string even
 * if `URL` parsing fails on a malformed value).
 */
function webhookHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.split("?")[0] ?? url;
  }
}
