/**
 * Reactor-compat admin-audit + metric-event store helpers extracted from
 * reactor-compat-routes.ts.
 *
 * Each helper dispatches to the configured admin store
 * (options.admin.auditStore / metricEventStore) when present, otherwise
 * falls back to the file-private compat state via accessors. Pairs with
 * admin-platform-compat-routes (audits route family),
 * admin-analytics-compat-routes (audits export, eval pass-rate),
 * guard-compat-routes (input-guard audit response shape +
 * inputGuardStatsResponse), and metric-ingestion-compat-routes
 * (recordMetricEvent).
 */

import type { FastifyRequest } from "fastify";
import type { JsonObject } from "@muse/shared";
import {
  createRecord,
  epochMillisOrNull,
  getStateAdminAudits,
  getStateMetricEvents,
  jsonObjectField,
  nowIso,
  nullableStringResponse,
  readAuthUserId,
  readNumber,
  readQueryString,
  stringField,
  toJsonObject,
  type CompatRecord,
  type ReactorCompatibilityRouteOptions
} from "./reactor-compat-routes.js";

export async function adminAuditRows(
  request: FastifyRequest,
  options: ReactorCompatibilityRouteOptions,
  maxRows = 1000
): Promise<readonly JsonObject[]> {
  const category = readQueryString(request, "category")?.toLowerCase();
  const action = readQueryString(request, "action")?.toUpperCase();

  return [
    ...(await listAdminAuditRecords(options, maxRows)).map(toAdminAuditResponse),
    ...(await listMetricEventRecords(options, maxRows)).map(toMetricEventAdminAuditResponse)
  ]
    .filter((row) => !category || stringField(row.category, "").toLowerCase() === category)
    .filter((row) => !action || stringField(row.action, "").toUpperCase() === action)
    .sort((left, right) => readNumber(right.createdAt, 0) - readNumber(left.createdAt, 0))
    .slice(0, Math.max(1, maxRows));
}

function toMetricEventAdminAuditResponse(record: JsonObject): JsonObject {
  const kind = stringField(record.kind, "ingest");
  return {
    action: kind.toUpperCase().replace(/-/gu, "_"),
    actor: "admin",
    category: "metric_event",
    createdAt: epochMillisOrNull(record.createdAt) ?? Date.now(),
    detail: JSON.stringify(jsonObjectField(record.payload)),
    id: stringField(record.id, ""),
    resourceId: stringField(record.id, ""),
    resourceType: "metric_event"
  };
}

export async function recordMetricEvent(
  options: ReactorCompatibilityRouteOptions,
  input: { readonly kind: string; readonly payload: JsonObject }
): Promise<CompatRecord> {
  if (options.admin?.metricEventStore) {
    const saved = await options.admin.metricEventStore.record({
      kind: input.kind,
      payload: input.payload
    });
    return metricEventStoreRecordToCompat(saved);
  }

  return createRecord(getStateMetricEvents(), input, "metric_event");
}

async function listMetricEventRecords(
  options: ReactorCompatibilityRouteOptions,
  limit = 1000
): Promise<readonly JsonObject[]> {
  if (options.admin?.metricEventStore) {
    const rows = await options.admin.metricEventStore.listRecent(limit);
    return rows.map(metricEventStoreRecordToCompat);
  }

  return [...getStateMetricEvents().values()].sort(compareCreatedAtDesc).slice(0, Math.max(1, limit));
}

function metricEventStoreRecordToCompat(record: {
  readonly createdAt: Date;
  readonly id: string;
  readonly kind: string;
  readonly payload: JsonObject;
}): CompatRecord {
  return {
    createdAt: record.createdAt.toISOString(),
    id: record.id,
    kind: record.kind,
    payload: record.payload,
    updatedAt: record.createdAt.toISOString()
  };
}

export async function recordAdminAudit(
  request: FastifyRequest,
  options: ReactorCompatibilityRouteOptions,
  input: JsonObject
): Promise<CompatRecord> {
  const audit = {
    action: stringField(input.action, "UPDATE").toUpperCase(),
    actor: readAuthUserId(request) ?? "anonymous",
    category: stringField(input.category, "admin"),
    detail: nullableStringResponse(input.detail),
    resourceId: nullableStringResponse(input.resourceId),
    resourceType: nullableStringResponse(input.resourceType)
  };

  if (options.admin?.auditStore) {
    const saved = await options.admin.auditStore.record(audit);
    return adminAuditStoreRecordToCompat(saved);
  }

  return createRecord(getStateAdminAudits(), audit, "admin_audit");
}

export function toAdminAuditResponse(record: JsonObject): JsonObject {
  return {
    action: stringField(record.action, "UPDATE").toUpperCase(),
    actor: stringField(record.actor, "anonymous"),
    category: stringField(record.category, "admin"),
    createdAt: epochMillisOrNull(record.createdAt) ?? Date.now(),
    detail: nullableStringResponse(record.detail),
    id: stringField(record.id, ""),
    resourceId: nullableStringResponse(record.resourceId),
    resourceType: nullableStringResponse(record.resourceType)
  };
}

export async function listAdminAuditRecords(
  options: ReactorCompatibilityRouteOptions,
  limit = 1000
): Promise<readonly JsonObject[]> {
  if (options.admin?.auditStore) {
    const rows = await options.admin.auditStore.listRecent(limit);
    return rows.map(adminAuditStoreRecordToCompat);
  }

  return [...getStateAdminAudits().values()].sort(compareCreatedAtDesc).slice(0, Math.max(1, limit));
}

export function adminAuditStoreRecordToCompat(record: {
  readonly action: string;
  readonly actor: string;
  readonly category: string;
  readonly createdAt: Date;
  readonly detail?: string | null;
  readonly id: string;
  readonly resourceId?: string | null;
  readonly resourceType?: string | null;
}): CompatRecord {
  return {
    action: record.action,
    actor: record.actor,
    category: record.category,
    createdAt: record.createdAt.toISOString(),
    detail: record.detail ?? null,
    id: record.id,
    resourceId: record.resourceId ?? null,
    resourceType: record.resourceType ?? null,
    updatedAt: record.createdAt.toISOString()
  };
}

export function toInputGuardAuditResponse(record: JsonObject): JsonObject {
  return {
    action: stringField(record.action, "UPDATE").toUpperCase(),
    actor: stringField(record.actor, "anonymous"),
    category: "input_guard",
    detail: nullableStringResponse(record.detail),
    id: stringField(record.id, ""),
    resourceId: nullableStringResponse(record.resourceId),
    resourceType: nullableStringResponse(record.resourceType),
    timestamp: stringField(record.createdAt, nowIso())
  };
}

export function inputGuardStatsResponse(options: ReactorCompatibilityRouteOptions, periodHours: number): JsonObject {
  const events = (options.admin?.observability?.metrics?.recordedEvents() ?? [])
    .map(toJsonObject)
    .filter((event) => event.type === "guard_rejection");
  const byStage = new Map<string, {
    errors: number;
    reasons: Map<string, number>;
    rejected: number;
    stage: string;
  }>();

  for (const event of events) {
    const payload = jsonObjectField(event.payload);
    const stage = stringField(payload.stage, "unknown");
    const reason = stringField(payload.reason, "unknown");
    const stats = byStage.get(stage) ?? {
      errors: 0,
      reasons: new Map<string, number>(),
      rejected: 0,
      stage
    };

    stats.rejected += 1;
    stats.reasons.set(reason, (stats.reasons.get(reason) ?? 0) + 1);
    byStage.set(stage, stats);
  }

  const totalRejected = events.length;

  return {
    blockRate: totalRejected > 0 ? 1 : 0,
    byStage: [...byStage.values()]
      .sort((left, right) => right.rejected - left.rejected || left.stage.localeCompare(right.stage))
      .map((stage) => ({
        allowed: 0,
        errors: stage.errors,
        rejected: stage.rejected,
        stage: stage.stage,
        topReasons: [...stage.reasons.entries()]
          .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
          .slice(0, 5)
          .map(([reason, count]) => ({ count, reason })),
        triggered: stage.rejected + stage.errors
      })),
    periodHours,
    totalAllowed: 0,
    totalErrors: 0,
    totalRejected,
    totalRequests: totalRejected
  };
}

export function compareCreatedAtDesc(left: JsonObject, right: JsonObject): number {
  return (epochMillisOrNull(right.createdAt) ?? 0) - (epochMillisOrNull(left.createdAt) ?? 0);
}
