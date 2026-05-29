import { describe, expect, it } from "vitest";

import {
  createConversationSummaryStore,
  createDebugReplayCaptureStore,
  createHistoryStore,
  createHookTraceStore,
  createMcpSecurityPolicyStore,
  createMcpServerStore,
  createRuntimeSettingsStore,
  createSchedulerExecutionStore,
  createSchedulerLock,
  createSchedulerStore,
  createSessionTagStore,
  createTaskMemoryStore,
  createTracer,
  createTracingPipeline,
  createUserMemoryStore,
} from "../src/store-factories.js";
import type { MuseEnvironment } from "../src/index.js";

// The Kysely-backed factories only stash the handle (no query at
// construction), so a bare object stands in for the DB connection.
const fakeDb = {} as never;
const env = {} as MuseEnvironment;
const className = (value: unknown) => (value as { constructor: { name: string } }).constructor.name;

describe("store factories toggle on DB presence", () => {
  it("returns the in-memory store with no DB and the Kysely store with a DB", () => {
    const cases: Array<{ inMem: unknown; kysely: unknown; inMemName: string; kyselyName: string }> = [
      { inMem: createHistoryStore(undefined), kysely: createHistoryStore(fakeDb), inMemName: "InMemoryAgentRunHistoryStore", kyselyName: "KyselyAgentRunHistoryStore" },
      { inMem: createHookTraceStore(undefined, env), kysely: createHookTraceStore(fakeDb, env), inMemName: "InMemoryHookTraceStore", kyselyName: "KyselyHookTraceStore" },
      { inMem: createDebugReplayCaptureStore(undefined), kysely: createDebugReplayCaptureStore(fakeDb), inMemName: "InMemoryDebugReplayCaptureStore", kyselyName: "KyselyDebugReplayCaptureStore" },
      { inMem: createRuntimeSettingsStore(undefined), kysely: createRuntimeSettingsStore(fakeDb), inMemName: "InMemoryRuntimeSettingsStore", kyselyName: "KyselyRuntimeSettingsStore" },
      { inMem: createTaskMemoryStore(undefined, env), kysely: createTaskMemoryStore(fakeDb, env), inMemName: "InMemoryTaskMemoryStore", kyselyName: "KyselyTaskMemoryStore" },
      { inMem: createConversationSummaryStore(undefined), kysely: createConversationSummaryStore(fakeDb), inMemName: "InMemoryConversationSummaryStore", kyselyName: "KyselyConversationSummaryStore" },
      { inMem: createSessionTagStore(undefined), kysely: createSessionTagStore(fakeDb), inMemName: "InMemorySessionTagStore", kyselyName: "KyselySessionTagStore" },
      { inMem: createMcpServerStore(undefined, env), kysely: createMcpServerStore(fakeDb, env), inMemName: "InMemoryMcpServerStore", kyselyName: "KyselyMcpServerStore" },
      { inMem: createMcpSecurityPolicyStore(undefined, {}), kysely: createMcpSecurityPolicyStore(fakeDb, {}), inMemName: "InMemoryMcpSecurityPolicyStore", kyselyName: "KyselyMcpSecurityPolicyStore" },
      { inMem: createSchedulerStore(undefined, env), kysely: createSchedulerStore(fakeDb, env), inMemName: "InMemoryScheduledJobStore", kyselyName: "KyselyScheduledJobStore" },
      { inMem: createSchedulerExecutionStore(undefined, env), kysely: createSchedulerExecutionStore(fakeDb, env), inMemName: "InMemoryScheduledJobExecutionStore", kyselyName: "KyselyScheduledJobExecutionStore" },
      { inMem: createSchedulerLock(undefined, env), kysely: createSchedulerLock(fakeDb, env), inMemName: "InMemoryDistributedSchedulerLock", kyselyName: "KyselyDistributedSchedulerLock" },
    ];
    for (const { inMem, kysely, inMemName, kyselyName } of cases) {
      expect(className(inMem)).toBe(inMemName);
      expect(className(kysely)).toBe(kyselyName);
    }
  });

  it("createTracer wraps the Kysely sink in a PersistedMuseTracer but uses the in-memory tracer otherwise", () => {
    expect(className(createTracer(undefined))).toBe("InMemoryMuseTracer");
    expect(className(createTracer(fakeDb))).toBe("PersistedMuseTracer");
  });
});

describe("createTracingPipeline", () => {
  it("assembles Kysely-backed query stores and omits the in-memory trace sink when a DB is present", () => {
    const pipeline = createTracingPipeline(fakeDb);
    expect(className(pipeline.latencyQuery)).toBe("KyselyLatencyQuery");
    expect(className(pipeline.tokenCostQuery)).toBe("KyselyTokenCostQuery");
    expect(pipeline.traceSink).toBeUndefined();
  });

  it("assembles in-memory query stores and exposes the in-memory trace sink with no DB", () => {
    const pipeline = createTracingPipeline(undefined);
    expect(className(pipeline.latencyQuery)).toBe("InMemoryLatencyQuery");
    expect(className(pipeline.tokenCostQuery)).toBe("InMemoryTokenCostQuery");
    expect(pipeline.traceSink).toBeDefined();
  });
});

describe("createUserMemoryStore", () => {
  it("uses the Kysely store when a DB is present", () => {
    expect(className(createUserMemoryStore(fakeDb))).toBe("KyselyUserMemoryStore");
  });

  it("defaults to the persistent file store with no DB", () => {
    expect(className(createUserMemoryStore(undefined, env))).toBe("FileUserMemoryStore");
  });

  it("falls back to the in-memory store when persistence is explicitly disabled", () => {
    expect(className(createUserMemoryStore(undefined, { MUSE_USER_MEMORY_PERSIST: "false" } as MuseEnvironment))).toBe(
      "InMemoryUserMemoryStore",
    );
  });
});
