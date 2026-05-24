/**
 * Db-or-in-memory store factory helpers.
 *
 * Lifted out of `packages/autoconfigure/src/index.ts` (after
 * splitting out the personal-domain providers) so the
 * cluster of `db ? new KyselyXStore(db) : new InMemoryXStore(env)`
 * factories — 14 stores + the tracing pipeline — lives in its own
 * focused module. Each helper does the same thing structurally:
 * pick the persistent backend when a DB is configured, fall back
 * to a process-local in-memory store otherwise.
 *
 * The factories take `MuseEnvironment` for the helpers that need
 * tunables (max-entries / retention / scheduler owner id). The
 * `parseInteger` env-parsing helper is imported back from
 * `./index.js`.
 */

import type { MuseDatabase } from "@muse/db";
import type { Kysely } from "kysely";

import {
  InMemoryConversationSummaryStore,
  InMemoryTaskMemoryStore,
  FileUserMemoryStore,
  InMemoryUserMemoryStore,
  KyselyConversationSummaryStore,
  KyselyTaskMemoryStore,
  KyselyUserMemoryStore,
  type ConversationSummaryStore,
  type UserMemoryStore
} from "@muse/memory";
import {
  InMemoryMcpSecurityPolicyStore,
  InMemoryMcpServerStore,
  KyselyMcpSecurityPolicyStore,
  KyselyMcpServerStore,
  type McpSecurityPolicyInput,
  type McpSecurityPolicyStore,
  type McpServerStore
} from "@muse/mcp";
import {
  InMemoryLatencyQuery,
  InMemoryMuseTracer,
  InMemoryTokenCostQuery,
  InMemoryTokenUsageSink,
  InMemoryTraceEventSink,
  KyselyLatencyQuery,
  KyselyTokenCostQuery,
  KyselyTokenUsageSink,
  KyselyTraceEventSink,
  PersistedMuseTracer,
  type LatencyQuery,
  type MuseTracer,
  type QueryableTraceEventSink,
  type TokenCostQuery,
  type TokenUsageSink
} from "@muse/observability";
import {
  InMemoryRuntimeSettingsStore,
  KyselyRuntimeSettingsStore,
  type RuntimeSettingsStore
} from "@muse/runtime-settings";
import {
  InMemoryAgentRunHistoryStore,
  InMemoryDebugReplayCaptureStore,
  InMemoryHookTraceStore,
  InMemorySessionTagStore,
  KyselyAgentRunHistoryStore,
  KyselyDebugReplayCaptureStore,
  KyselyHookTraceStore,
  KyselySessionTagStore,
  type AgentRunHistoryStore,
  type DebugReplayCaptureStore,
  type HookTraceStore,
  type SessionTagStore
} from "@muse/runtime-state";
import {
  InMemoryDistributedSchedulerLock,
  InMemoryScheduledJobExecutionStore,
  InMemoryScheduledJobStore,
  KyselyDistributedSchedulerLock,
  KyselyScheduledJobExecutionStore,
  KyselyScheduledJobStore,
  type DistributedSchedulerLock,
  type ScheduledJobExecutionStore,
  type ScheduledJobStore
} from "@muse/scheduler";

import { parseInteger, type MuseEnvironment } from "./index.js";

export function createHistoryStore(db: Kysely<MuseDatabase> | undefined): AgentRunHistoryStore {
  return db ? new KyselyAgentRunHistoryStore(db) : new InMemoryAgentRunHistoryStore();
}

export function createTracer(db: Kysely<MuseDatabase> | undefined): MuseTracer {
  return db ? new PersistedMuseTracer(new KyselyTraceEventSink(db)) : new InMemoryMuseTracer();
}

export function createTracingPipeline(db: Kysely<MuseDatabase> | undefined): {
  readonly tracer: MuseTracer;
  readonly latencyQuery: LatencyQuery;
  readonly tokenUsageSink: TokenUsageSink;
  readonly tokenCostQuery: TokenCostQuery;
  readonly traceSink?: QueryableTraceEventSink;
} {
  if (db) {
    const tokenUsageSink = new KyselyTokenUsageSink(db);
    return {
      latencyQuery: new KyselyLatencyQuery(db),
      tokenCostQuery: new KyselyTokenCostQuery(db),
      tokenUsageSink,
      tracer: new PersistedMuseTracer(new KyselyTraceEventSink(db))
    };
  }

  const traceSink: QueryableTraceEventSink = new InMemoryTraceEventSink();
  const tokenSink = new InMemoryTokenUsageSink();
  return {
    latencyQuery: new InMemoryLatencyQuery(traceSink),
    tokenCostQuery: new InMemoryTokenCostQuery(tokenSink),
    tokenUsageSink: tokenSink,
    traceSink,
    tracer: new PersistedMuseTracer(traceSink)
  };
}

export function createHookTraceStore(db: Kysely<MuseDatabase> | undefined, env: MuseEnvironment): HookTraceStore {
  return db
    ? new KyselyHookTraceStore(db)
    : new InMemoryHookTraceStore({ maxTraces: parseInteger(env.MUSE_HOOK_TRACE_MAX_ENTRIES, 10_000) });
}

export function createDebugReplayCaptureStore(db: Kysely<MuseDatabase> | undefined): DebugReplayCaptureStore {
  return db ? new KyselyDebugReplayCaptureStore(db) : new InMemoryDebugReplayCaptureStore();
}

export function createRuntimeSettingsStore(db: Kysely<MuseDatabase> | undefined): RuntimeSettingsStore {
  return db ? new KyselyRuntimeSettingsStore(db) : new InMemoryRuntimeSettingsStore();
}

export function createTaskMemoryStore(db: Kysely<MuseDatabase> | undefined, env: MuseEnvironment): InMemoryTaskMemoryStore | KyselyTaskMemoryStore {
  const retentionMs = parseInteger(env.MUSE_TASK_MEMORY_RETENTION_MS, 30 * 24 * 60 * 60 * 1_000);
  return db
    ? new KyselyTaskMemoryStore(db, { retentionMs })
    : new InMemoryTaskMemoryStore({
      maxTasks: parseInteger(env.MUSE_TASK_MEMORY_MAX_TASKS, 10_000),
      retentionMs
    });
}

export function createConversationSummaryStore(db: Kysely<MuseDatabase> | undefined): ConversationSummaryStore {
  return db ? new KyselyConversationSummaryStore(db) : new InMemoryConversationSummaryStore();
}

export function createUserMemoryStore(
  db: Kysely<MuseDatabase> | undefined,
  env?: MuseEnvironment
): UserMemoryStore {
  if (db) return new KyselyUserMemoryStore(db);
  // Default for the DB-less daily-driver path: a JSON file at
  // ~/.muse/user-memory.json. Persistence is what makes Muse
  // "knows you" across CLI sessions (the JARVIS core). Override
  // path via MUSE_USER_MEMORY_FILE; opt out and fall back to a
  // pure in-memory store via MUSE_USER_MEMORY_PERSIST=false (rare —
  // tests that want a clean slate per run).
  const persist = env?.MUSE_USER_MEMORY_PERSIST !== "false";
  if (!persist) {
    return new InMemoryUserMemoryStore();
  }
  const file = env?.MUSE_USER_MEMORY_FILE?.trim();
  return new FileUserMemoryStore(file && file.length > 0 ? { file } : {});
}

export function createSessionTagStore(db: Kysely<MuseDatabase> | undefined): SessionTagStore {
  return db ? new KyselySessionTagStore(db) : new InMemorySessionTagStore();
}

export function createMcpServerStore(db: Kysely<MuseDatabase> | undefined, env: MuseEnvironment): McpServerStore {
  return db
    ? new KyselyMcpServerStore(db)
    : new InMemoryMcpServerStore({ maxServers: parseInteger(env.MUSE_MCP_MAX_SERVERS, 1_000) });
}

export function createMcpSecurityPolicyStore(
  db: Kysely<MuseDatabase> | undefined,
  initial: McpSecurityPolicyInput
): McpSecurityPolicyStore {
  return db ? new KyselyMcpSecurityPolicyStore(db) : new InMemoryMcpSecurityPolicyStore({ initial });
}

export function createSchedulerStore(db: Kysely<MuseDatabase> | undefined, env: MuseEnvironment): ScheduledJobStore {
  return db
    ? new KyselyScheduledJobStore(db)
    : new InMemoryScheduledJobStore({ maxJobs: parseInteger(env.MUSE_SCHEDULER_MAX_JOBS, 1_000) });
}

export function createSchedulerExecutionStore(
  db: Kysely<MuseDatabase> | undefined,
  env: MuseEnvironment
): ScheduledJobExecutionStore {
  return db
    ? new KyselyScheduledJobExecutionStore(db)
    : new InMemoryScheduledJobExecutionStore({
      maxEntries: parseInteger(env.MUSE_SCHEDULER_MAX_EXECUTIONS, 200)
    });
}

export function createSchedulerLock(db: Kysely<MuseDatabase> | undefined, env: MuseEnvironment): DistributedSchedulerLock {
  const ownerId = env.MUSE_SCHEDULER_OWNER_ID;
  return db
    ? new KyselyDistributedSchedulerLock(db, { ownerId })
    : new InMemoryDistributedSchedulerLock({ ownerId });
}
