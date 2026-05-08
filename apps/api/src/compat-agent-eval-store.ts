/**
 * Reactor-compat agent-eval store CRUD layer extracted from
 * reactor-compat-routes.ts.
 *
 * Each function dispatches to options.agentEvalStore when the runtime is
 * configured with one (Kysely-backed in production), otherwise falls back
 * to the file-private compat state via accessors. Pairs with
 * agent-eval-compat-routes.ts and compat-agent-eval-shape.ts.
 */

import type { JsonObject } from "@muse/shared";
import {
  evalStoreRecordToCompat,
  prepareEvalRecord
} from "./compat-agent-eval-shape.js";
import {
  createRecord,
  findCompatRecord,
  getStateAgentEvalCases,
  getStateAgentEvalResults,
  getStateAgentEvalRunLogs,
  readStringSet,
  type CompatRecord,
  type ReactorCompatibilityRouteOptions
} from "./reactor-compat-routes.js";

export async function saveAgentEvalCase(options: ReactorCompatibilityRouteOptions, record: JsonObject): Promise<CompatRecord> {
  if (options.agentEvalStore) {
    const saved = await options.agentEvalStore.saveCase(prepareEvalRecord(record, "eval_case"));
    return evalStoreRecordToCompat(saved, "eval_case");
  }

  return createRecord(getStateAgentEvalCases(), record, "eval_case");
}

export async function listAgentEvalCases(
  options: ReactorCompatibilityRouteOptions,
  filters: { readonly enabledOnly?: boolean; readonly limit?: number; readonly tags?: readonly string[] } = {}
): Promise<readonly CompatRecord[]> {
  if (options.agentEvalStore) {
    const rows = await options.agentEvalStore.listCases(filters);
    return rows.map((row) => evalStoreRecordToCompat(row, "eval_case"));
  }

  return [...getStateAgentEvalCases().values()]
    .filter((item) => !filters.enabledOnly || item.enabled !== false)
    .filter((item) => !filters.tags || filters.tags.length === 0 || readStringSet(item.tags).some((tag) => filters.tags?.includes(tag)))
    .slice(0, filters.limit ?? 100);
}

export async function getAgentEvalCase(options: ReactorCompatibilityRouteOptions, id: string): Promise<CompatRecord | undefined> {
  if (options.agentEvalStore) {
    const row = await options.agentEvalStore.getCase(id);
    return row ? evalStoreRecordToCompat(row, "eval_case") : undefined;
  }

  return findCompatRecord(getStateAgentEvalCases(), id);
}

export async function saveAgentEvalRunLog(options: ReactorCompatibilityRouteOptions, record: JsonObject): Promise<CompatRecord> {
  if (options.agentEvalStore) {
    const saved = await options.agentEvalStore.saveRunLog(prepareEvalRecord(record, "agent_eval_run_log"));
    return evalStoreRecordToCompat(saved, "agent_eval_run_log");
  }

  return createRecord(getStateAgentEvalRunLogs(), record, "agent_eval_run_log");
}

export async function listAgentEvalRunLogs(options: ReactorCompatibilityRouteOptions, limit: number): Promise<readonly CompatRecord[]> {
  if (options.agentEvalStore) {
    const rows = await options.agentEvalStore.listRunLogs(limit);
    return rows.map((row) => evalStoreRecordToCompat(row, "agent_eval_run_log"));
  }

  return [...getStateAgentEvalRunLogs().values()].slice(0, limit);
}

export async function saveAgentEvalResult(options: ReactorCompatibilityRouteOptions, record: JsonObject): Promise<CompatRecord> {
  if (options.agentEvalStore) {
    const saved = await options.agentEvalStore.saveResult(prepareEvalRecord(record, "agent_eval_result"));
    return evalStoreRecordToCompat(saved, "agent_eval_result");
  }

  return createRecord(getStateAgentEvalResults(), record, "agent_eval_result");
}

export async function listAgentEvalResults(
  options: ReactorCompatibilityRouteOptions,
  filters: { readonly caseId?: string; readonly limit?: number; readonly tier?: string } = {}
): Promise<readonly CompatRecord[]> {
  if (options.agentEvalStore) {
    const rows = await options.agentEvalStore.listResults(filters);
    return rows.map((row) => evalStoreRecordToCompat(row, "agent_eval_result"));
  }

  return [...getStateAgentEvalResults().values()]
    .filter((result) => !filters.caseId || result.caseId === filters.caseId)
    .filter((result) => !filters.tier || result.tier === filters.tier)
    .slice(0, filters.limit ?? 100);
}

export async function saveDebugReplayCapture(options: ReactorCompatibilityRouteOptions, record: JsonObject): Promise<CompatRecord> {
  if (options.agentEvalStore) {
    const saved = await options.agentEvalStore.saveDebugReplayCapture(prepareEvalRecord(record, "debug_replay"));
    return evalStoreRecordToCompat(saved, "debug_replay");
  }

  return evalStoreRecordToCompat(record, "debug_replay");
}

export async function listDebugReplayCaptures(options: ReactorCompatibilityRouteOptions, limit: number): Promise<readonly CompatRecord[]> {
  if (options.agentEvalStore) {
    const rows = await options.agentEvalStore.listDebugReplayCaptures(limit);
    return rows.map((row) => evalStoreRecordToCompat(row, "debug_replay"));
  }

  return [];
}

export async function getDebugReplayCapture(options: ReactorCompatibilityRouteOptions, id: string): Promise<CompatRecord | undefined> {
  if (options.agentEvalStore) {
    const row = await options.agentEvalStore.getDebugReplayCapture(id);
    return row ? evalStoreRecordToCompat(row, "debug_replay") : undefined;
  }

  return undefined;
}
