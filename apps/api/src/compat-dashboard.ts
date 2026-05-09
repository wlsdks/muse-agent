/**
 * Reactor-compat ops dashboard + platform health summary helpers extracted
 * from reactor-compat-routes.ts.
 *
 * Generates the rich envelope returned by /api/ops/dashboard
 * (employeeValue, MCP status, scheduler stats, response trust events,
 * ops metric snapshots) and the smaller platform-health
 * (/api/admin/platform/health) shape with active alert counts.
 */

import type { McpServer } from "@muse/mcp";
import type { ScheduledJobExecution } from "@muse/scheduler";
import type { JsonObject } from "@muse/shared";
import { countDocuments } from "./compat-document-store.js";
import {
  getStateRagCandidates,
  jsonObjectField,
  nullableStringResponse,
  opsMetricSnapshots,
  readBoolean,
  reactorEnumString,
  stringField,
  toJsonObject,
  type ReactorCompatibilityRouteOptions
} from "./reactor-compat-routes.js";

export async function dashboardSummary(options: ReactorCompatibilityRouteOptions) {
  const [scheduledJobs, pendingApprovals, mcpServers, recentExecutions] = await Promise.all([
    options.scheduler?.store.list() ?? [],
    options.pendingApprovalStore?.countPending() ?? 0,
    options.mcp?.manager.listServers() ?? [],
    options.scheduler?.executionStore?.findRecent(6) ?? []
  ]);
  const metricEvents = recordedMetricEvents(options);
  const documentCount = await countDocuments(options);
  const enabledJobs = scheduledJobs.filter((job) => job.enabled !== false).length;
  const runningJobs = scheduledJobs.filter((job) => job.lastStatus === "running").length;
  const failedJobs = scheduledJobs.filter((job) => job.enabled !== false && job.lastStatus === "failed").length;

  return {
    approvals: {
      pendingCount: pendingApprovals
    },
    employeeValue: employeeValueSummary(metricEvents),
    generatedAt: Date.now(),
    mcp: mcpStatusSummary(options, mcpServers),
    metrics: opsMetricSnapshots(options),
    ragEnabled: documentCount > 0 || getStateRagCandidates().length > 0,
    recentSchedulerExecutions: recentExecutions.map(toOpsSchedulerExecutionSummary),
    recentTrustEvents: recentTrustEvents(metricEvents),
    responseTrust: responseTrustSummary(metricEvents),
    scheduler: {
      agentJobs: scheduledJobs.filter((job) => job.enabled !== false && job.jobType === "agent").length,
      attentionBacklog: runningJobs + failedJobs,
      enabledJobs,
      failedJobs,
      runningJobs,
      totalJobs: scheduledJobs.length
    }
  };
}

export async function platformHealthDashboard(options: ReactorCompatibilityRouteOptions): Promise<JsonObject> {
  const alerts = await (options.admin?.operations?.listAlerts() ?? []);
  return {
    activeAlerts: alerts.filter((alert) => toJsonObject(alert).status === "open").length
  };
}

function recordedMetricEvents(options: ReactorCompatibilityRouteOptions): readonly JsonObject[] {
  return (options.admin?.observability?.metrics?.recordedEvents() ?? []).map(toJsonObject);
}

function mcpStatusSummary(options: ReactorCompatibilityRouteOptions, servers: readonly McpServer[]): JsonObject {
  const statusCounts: Record<string, number> = {};

  for (const server of servers) {
    const status = reactorEnumString(options.mcp?.manager.getStatus(server.name), "PENDING");
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
  }

  return {
    statusCounts,
    total: servers.length
  };
}

function toOpsSchedulerExecutionSummary(execution: ScheduledJobExecution): JsonObject {
  return {
    completedAt: execution.completedAt?.getTime() ?? null,
    dryRun: execution.dryRun,
    durationMs: execution.durationMs,
    failureReason: schedulerFailureReason(execution.result) ?? null,
    id: execution.id,
    jobId: execution.jobId,
    jobName: execution.jobName,
    resultPreview: schedulerResultPreview(execution.result) ?? null,
    startedAt: execution.startedAt.getTime(),
    status: reactorEnumString(execution.status, "UNKNOWN")
  };
}

function responseTrustSummary(events: readonly JsonObject[]): JsonObject {
  const outputGuardActions = events
    .filter((event) => event.type === "output_guard_action")
    .map((event) => jsonObjectField(event.payload));
  const agentRuns = events
    .filter((event) => event.type === "agent_run")
    .map((event) => jsonObjectField(event.payload));

  return {
    boundaryFailures: events.filter((event) => event.type === "guard_rejection").length,
    outputGuardModified: outputGuardActions.filter((payload) => payload.action === "modified").length,
    outputGuardRejected: outputGuardActions.filter((payload) => payload.action === "rejected").length,
    unverifiedResponses: agentRuns.filter((payload) => {
      const metadata = jsonObjectField(payload.metadata);
      return readBoolean(metadata.verified, true) === false || readBoolean(metadata.grounded, true) === false;
    }).length
  };
}

function recentTrustEvents(events: readonly JsonObject[], limit = 8): readonly JsonObject[] {
  return events
    .filter((event) => event.type === "guard_rejection" || event.type === "output_guard_action")
    .slice(-limit)
    .reverse()
    .map((event) => {
      const payload = jsonObjectField(event.payload);
      const metadata = jsonObjectField(payload.metadata);
      const type = stringField(event.type, "trust_event");

      return {
        action: nullableStringResponse(payload.action),
        channel: nullableStringResponse(metadata.channel),
        occurredAt: Date.now(),
        policy: nullableStringResponse(metadata.policy),
        queryCluster: nullableStringResponse(metadata.queryCluster),
        queryLabel: nullableStringResponse(metadata.queryLabel),
        reason: nullableStringResponse(payload.reason),
        severity: type === "guard_rejection" || payload.action === "rejected" ? "warning" : "info",
        stage: nullableStringResponse(payload.stage),
        type,
        violation: nullableStringResponse(metadata.violation)
      };
    });
}

function employeeValueSummary(events: readonly JsonObject[]): JsonObject {
  const agentRuns = events
    .filter((event) => event.type === "agent_run")
    .map((event) => jsonObjectField(event.payload));
  const guardRejections = events.filter((event) => event.type === "guard_rejection");
  const answerModes: Record<string, number> = {};
  const channels: Record<string, number> = {};
  const toolFamilies: Record<string, number> = {};
  const lanes = new Map<string, {
    blockedResponses: number;
    groundedResponses: number;
    observedResponses: number;
  }>();
  let groundedResponses = 0;
  let interactiveResponses = 0;
  let scheduledResponses = 0;

  for (const run of agentRuns) {
    const metadata = jsonObjectField(run.metadata);
    const answerMode = stringField(metadata.answerMode, "unknown");
    const channel = stringField(metadata.channel, "api");
    const toolFamily = stringField(metadata.toolFamily, "");
    const grounded = readBoolean(metadata.grounded, false);
    const lane = lanes.get(answerMode) ?? { blockedResponses: 0, groundedResponses: 0, observedResponses: 0 };

    incrementRecord(answerModes, answerMode);
    incrementRecord(channels, channel);

    if (toolFamily) {
      incrementRecord(toolFamilies, toolFamily);
    }

    lane.observedResponses += 1;

    if (grounded) {
      groundedResponses += 1;
      lane.groundedResponses += 1;
    }

    if (readBoolean(metadata.interactive, false)) {
      interactiveResponses += 1;
    }

    if (readBoolean(metadata.scheduled, false)) {
      scheduledResponses += 1;
    }

    lanes.set(answerMode, lane);
  }

  const observedResponses = agentRuns.length;

  return {
    answerModes,
    blockedResponses: guardRejections.length,
    channels: recordToBuckets(channels),
    groundedRatePercent: observedResponses > 0 ? Math.floor((groundedResponses * 100) / observedResponses) : 0,
    groundedResponses,
    interactiveResponses,
    lanes: [...lanes.entries()].map(([answerMode, lane]) => ({
      answerMode,
      blockedResponses: lane.blockedResponses,
      groundedRatePercent: lane.observedResponses > 0
        ? Math.floor((lane.groundedResponses * 100) / lane.observedResponses)
        : 0,
      groundedResponses: lane.groundedResponses,
      observedResponses: lane.observedResponses
    })),
    observedResponses,
    scheduledResponses,
    toolFamilies: recordToBuckets(toolFamilies),
    topMissingQueries: guardRejections.slice(-5).reverse().map((event) => {
      const payload = jsonObjectField(event.payload);
      const metadata = jsonObjectField(payload.metadata);

      return {
        blockReason: nullableStringResponse(payload.reason),
        count: 1,
        lastOccurredAt: Date.now(),
        queryCluster: stringField(metadata.queryCluster, "unknown"),
        queryLabel: stringField(metadata.queryLabel, stringField(payload.reason, "unknown"))
      };
    })
  };
}

function incrementRecord(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1;
}

function recordToBuckets(record: Record<string, number>): JsonObject[] {
  return Object.entries(record)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([key, count]) => ({ count, key }));
}

function schedulerFailureReason(result: string | undefined): string | undefined {
  const value = result?.trim() ?? "";

  if (!value.toLowerCase().includes("failed:")) {
    return undefined;
  }

  return value.slice(value.toLowerCase().indexOf("failed:") + "failed:".length).trim() || value;
}

function schedulerResultPreview(result: string | undefined, maxLength = 140): string | undefined {
  const value = result?.trim() ?? "";

  if (!value) {
    return undefined;
  }

  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}
