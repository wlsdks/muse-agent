import { describe, expect, it } from "vitest";
import type { MuseDatabase } from "@muse/db";
import { KyselyAgentSpecRegistry } from "@muse/agent-specs";
import { KyselyMcpSecurityPolicyStore, KyselyMcpServerStore } from "@muse/mcp";
import { KyselyRuntimeSettingsStore } from "@muse/runtime-settings";
import {
  KyselyAdminOperationsStore,
  KyselyAgentRunHistoryStore,
  KyselyHookTraceStore
} from "@muse/runtime-state";
import {
  KyselyDistributedSchedulerLock,
  KyselyScheduledJobExecutionStore,
  KyselyScheduledJobStore
} from "@muse/scheduler";
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler
} from "kysely";
import {
  ConfigurationError,
  createApiServerOptions,
  createMuseRuntimeAssembly,
  parseBoolean,
  parseInteger,
  requireEnv
} from "../src/index.js";

describe("autoconfigure", () => {
  it("assembles default runtime without auth when no secret is configured", async () => {
    const assembly = createMuseRuntimeAssembly({ env: {} });

    expect(assembly.authService).toBeUndefined();
    expect(assembly.requireAuth).toBe(false);
    expect(assembly.agentRuntime).toBeUndefined();
    expect(assembly.mcp.manager.getToolCatalog()).toEqual([]);
    expect(assembly.cache.responseCache.size()).toBe(0);
    expect(assembly.observability.metrics.recordedEvents()).toEqual([]);
    expect(assembly.resilience.circuitBreakerRegistry.names()).toEqual([]);
    expect(await assembly.adminOperationsStore.listTenants()).toEqual([]);
    expect(assembly.scheduler.store.list()).toEqual([]);
    expect(assembly.scheduler.service).toBeTruthy();
  });

  it("assembles auth and API options when JWT secret is configured", () => {
    const options = createApiServerOptions({
      env: {
        MUSE_AUTH_JWT_SECRET: "0123456789abcdef0123456789abcdef",
        MUSE_REQUIRE_AUTH: "true"
      }
    });

    expect(options.authService).toBeTruthy();
    expect(options.admin.cache.responseCache.size()).toBe(0);
    expect(options.admin.operations.listAlerts()).toEqual([]);
    expect(options.requireAuth).toBe(true);
    expect(options.mcp.manager).toBeTruthy();
    expect(options.scheduler.store.list()).toEqual([]);
  });

  it("uses Kysely-backed stores when a database handle is provided", () => {
    const assembly = createMuseRuntimeAssembly({ db: createPostgresBuilder(), env: {} });

    expect(assembly.agentSpecRegistry).toBeInstanceOf(KyselyAgentSpecRegistry);
    expect(assembly.historyStore).toBeInstanceOf(KyselyAgentRunHistoryStore);
    expect(assembly.hookTraceStore).toBeInstanceOf(KyselyHookTraceStore);
    expect(assembly.adminOperationsStore).toBeInstanceOf(KyselyAdminOperationsStore);
    expect(assembly.mcp.serverStore).toBeInstanceOf(KyselyMcpServerStore);
    expect(assembly.mcp.securityPolicyStore).toBeInstanceOf(KyselyMcpSecurityPolicyStore);
    expect((assembly.runtimeSettings as unknown as { readonly store: unknown }).store)
      .toBeInstanceOf(KyselyRuntimeSettingsStore);
    expect(assembly.scheduler.store).toBeInstanceOf(KyselyScheduledJobStore);
    expect(assembly.scheduler.executionStore).toBeInstanceOf(KyselyScheduledJobExecutionStore);
    expect((assembly.scheduler.service as unknown as { readonly distributedLock: unknown }).distributedLock)
      .toBeInstanceOf(KyselyDistributedSchedulerLock);
  });

  it("assembles AgentRuntime when an OpenAI-compatible model endpoint is configured", () => {
    const assembly = createMuseRuntimeAssembly({
      env: {
        MUSE_MODEL: "provider/model-a",
        MUSE_MODEL_BASE_URL: "https://llm.example.test/v1"
      }
    });

    expect(assembly.agentRuntime).toBeTruthy();
    expect(assembly.defaultModel).toBe("provider/model-a");
    expect(assembly.modelProvider?.id).toBe("openai-compatible");
  });

  it("maps Slack API options from environment", () => {
    const options = createApiServerOptions({
      env: {
        MUSE_SLACK_ENABLED: "true",
        MUSE_SLACK_SIGNING_SECRET: "signing-secret"
      }
    });

    expect(options.slack).toEqual({
      enabled: true,
      signingSecret: "signing-secret"
    });
  });

  it("parses primitive env values conservatively", () => {
    expect(parseBoolean(undefined, true)).toBe(true);
    expect(parseBoolean("yes", false)).toBe(true);
    expect(parseBoolean("no", true)).toBe(false);
    expect(parseInteger("42", 1)).toBe(42);
    expect(parseInteger("bad", 7)).toBe(7);
  });

  it("fails clearly for required missing variables", () => {
    expect(() => requireEnv({}, "MUSE_REQUIRED")).toThrow(ConfigurationError);
  });
});

function createPostgresBuilder(): Kysely<MuseDatabase> {
  return new Kysely<MuseDatabase>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler()
    }
  });
}
