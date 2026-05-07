import { describe, expect, it } from "vitest";
import type { MuseDatabase } from "@muse/db";
import { KyselyAgentSpecRegistry } from "@muse/agent-specs";
import { AsyncAuth } from "@muse/auth";
import { KyselyAgentEvalStore } from "@muse/eval";
import {
  InMemoryTaskMemoryStore,
  KyselyConversationSummaryStore,
  KyselyTaskMemoryStore,
  KyselyUserMemoryStore
} from "@muse/memory";
import { KyselyMcpSecurityPolicyStore, KyselyMcpServerStore } from "@muse/mcp";
import { PersistedMuseTracer } from "@muse/observability";
import { KyselyGuardRuleStore, KyselyToolPolicyStore } from "@muse/policy";
import { KyselyRagDocumentStore, KyselyRagIngestionCandidateStore, KyselyRagIngestionPolicyStore } from "@muse/rag";
import { KyselyFeedbackStore, KyselyPromptLabCatalogStore, KyselyPromptLabExperimentStore } from "@muse/promptlab";
import { KyselyRuntimeSettingsStore } from "@muse/runtime-settings";
import {
  KyselyAdminOperationsStore,
  KyselyAdminAuditStore,
  KyselyAgentRunHistoryStore,
  KyselyHookTraceStore,
  KyselyMetricAuditEventStore,
  KyselyPendingApprovalStore,
  KyselyPlatformAlertRuleStore,
  KyselyPlatformPricingStore,
  KyselySessionTagStore
} from "@muse/runtime-state";
import {
  KyselyDistributedSchedulerLock,
  KyselyScheduledJobExecutionStore,
  KyselyScheduledJobStore
} from "@muse/scheduler";
import {
  KyselyChannelFaqRegistrationStore,
  KyselySlackBotInstanceStore,
  KyselySlackFeedbackEventStore,
  KyselySlackResponseTrackerStore,
  SlackBotResponseTracker
} from "@muse/integrations";
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
  createLoopbackMcpToolsFromEnv,
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
    expect(assembly.observability.followupSuggestionStore.aggregateStats().totalImpressions).toBe(0);
    expect(assembly.resilience.circuitBreakerRegistry.names()).toEqual([]);
    expect(await assembly.adminOperationsStore.listTenants()).toEqual([]);
    expect(assembly.scheduler.store.list()).toEqual([]);
    expect(assembly.scheduler.service).toBeTruthy();
    expect(assembly.toolRegistry.list().map((tool) => tool.definition.name)).toEqual(expect.arrayContaining([
      "scheduler_list_jobs",
      "scheduler_create_job",
      "scheduler_trigger_job",
      "scheduler_dry_run_job"
    ]));
    expect(assembly.taskMemoryStore).toBeInstanceOf(InMemoryTaskMemoryStore);

    await assembly.taskMemoryStore.save({
      goal: "Keep runtime migration context",
      sessionId: "session-1",
      taskId: "task-1"
    });

    expect(await assembly.taskMemoryStore.findActiveBySession("session-1")).toMatchObject({
      taskId: "task-1"
    });
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
    expect(options.cors).toEqual({ allowCredentials: true });
    expect(options.requireAuth).toBe(true);
    expect(options.mcp.manager).toBeTruthy();
    expect(options.scheduler.store.list()).toEqual([]);
    expect(options.followupSuggestionStore.aggregateStats().totalClicks).toBe(0);
    expect(options.taskMemoryMaintenance.purgeExpired(new Date())).toBe(0);
  });

  it("uses Kysely-backed stores when a database handle is provided", () => {
    const assembly = createMuseRuntimeAssembly({
      db: createPostgresBuilder(),
      env: {
        MUSE_AUTH_JWT_SECRET: "0123456789abcdef0123456789abcdef"
      }
    });

    expect(assembly.agentSpecRegistry).toBeInstanceOf(KyselyAgentSpecRegistry);
    expect(assembly.authService).toBeInstanceOf(AsyncAuth);
    expect(assembly.historyStore).toBeInstanceOf(KyselyAgentRunHistoryStore);
    expect(assembly.hookTraceStore).toBeInstanceOf(KyselyHookTraceStore);
    expect(assembly.adminOperationsStore).toBeInstanceOf(KyselyAdminOperationsStore);
    expect(assembly.adminAuditStore).toBeInstanceOf(KyselyAdminAuditStore);
    expect(assembly.agentEvalStore).toBeInstanceOf(KyselyAgentEvalStore);
    expect(assembly.feedbackStore).toBeInstanceOf(KyselyFeedbackStore);
    expect(assembly.promptLabCatalogStore).toBeInstanceOf(KyselyPromptLabCatalogStore);
    expect(assembly.promptLabExperimentStore).toBeInstanceOf(KyselyPromptLabExperimentStore);
    expect(assembly.metricAuditEventStore).toBeInstanceOf(KyselyMetricAuditEventStore);
    expect(assembly.platformAlertRuleStore).toBeInstanceOf(KyselyPlatformAlertRuleStore);
    expect(assembly.platformPricingStore).toBeInstanceOf(KyselyPlatformPricingStore);
    expect(assembly.observability.tracer).toBeInstanceOf(PersistedMuseTracer);
    expect(assembly.approvalStore).toBeInstanceOf(KyselyPendingApprovalStore);
    expect(assembly.mcp.serverStore).toBeInstanceOf(KyselyMcpServerStore);
    expect(assembly.mcp.securityPolicyStore).toBeInstanceOf(KyselyMcpSecurityPolicyStore);
    expect((assembly.runtimeSettings as unknown as { readonly store: unknown }).store)
      .toBeInstanceOf(KyselyRuntimeSettingsStore);
    expect(assembly.scheduler.store).toBeInstanceOf(KyselyScheduledJobStore);
    expect(assembly.scheduler.executionStore).toBeInstanceOf(KyselyScheduledJobExecutionStore);
    expect((assembly.scheduler.service as unknown as { readonly distributedLock: unknown }).distributedLock)
      .toBeInstanceOf(KyselyDistributedSchedulerLock);
    expect(assembly.conversationSummaryStore).toBeInstanceOf(KyselyConversationSummaryStore);
    expect(assembly.taskMemoryStore).toBeInstanceOf(KyselyTaskMemoryStore);
    expect(assembly.userMemoryStore).toBeInstanceOf(KyselyUserMemoryStore);
    expect(assembly.sessionTagStore).toBeInstanceOf(KyselySessionTagStore);
    expect(assembly.guardRuleStore).toBeInstanceOf(KyselyGuardRuleStore);
    expect(assembly.toolPolicyStore).toBeInstanceOf(KyselyToolPolicyStore);
    expect(assembly.ragIngestion.policyStore).toBeInstanceOf(KyselyRagIngestionPolicyStore);
    expect(assembly.ragIngestion.candidateStore).toBeInstanceOf(KyselyRagIngestionCandidateStore);
    expect(assembly.ragIngestion.documentStore).toBeInstanceOf(KyselyRagDocumentStore);
    expect(assembly.slackPersistence.botStore).toBeInstanceOf(KyselySlackBotInstanceStore);
    expect(assembly.slackPersistence.faqStore).toBeInstanceOf(KyselyChannelFaqRegistrationStore);
    expect(assembly.slackPersistence.feedbackStore).toBeInstanceOf(KyselySlackFeedbackEventStore);
    expect(assembly.slackPersistence.responseTrackerStore).toBeInstanceOf(KyselySlackResponseTrackerStore);
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

  it("assembles AgentRuntime with an explicit diagnostic provider for local smoke tests", async () => {
    const assembly = createMuseRuntimeAssembly({
      env: {
        MUSE_MODEL: "diagnostic/smoke",
        MUSE_MODEL_PROVIDER_ID: "diagnostic"
      }
    });

    expect(assembly.agentRuntime).toBeTruthy();
    expect(assembly.defaultModel).toBe("diagnostic/smoke");
    expect(assembly.modelProvider?.id).toBe("diagnostic");
    await expect(assembly.agentRuntime?.run({
      messages: [{ content: "hello", role: "user" }],
      model: "diagnostic/smoke"
    })).resolves.toMatchObject({
      response: {
        output: "Diagnostic response: hello"
      }
    });
  });

  it("exposes a queryable in-memory traceSink that captures spans from agent runs", async () => {
    const assembly = createMuseRuntimeAssembly({
      env: {
        MUSE_MODEL: "diagnostic/smoke",
        MUSE_MODEL_PROVIDER_ID: "diagnostic"
      }
    });

    expect(assembly.observability.traceSink).toBeTruthy();
    await assembly.agentRuntime?.run({
      messages: [{ content: "trace probe", role: "user" }],
      model: "diagnostic/smoke",
      runId: "run-trace-1"
    });

    const sink = assembly.observability.traceSink as { list(): readonly { readonly name: string; readonly attributes?: Record<string, unknown> }[] };
    const events = sink.list();
    expect(events.length).toBeGreaterThan(0);
    const seen = new Set(events.map((event) => event.name));
    expect(seen.has("muse.model.generate")).toBe(true);
  });

  it("threads token usage from agent runs into the assembled tokenUsageSink", async () => {
    const assembly = createMuseRuntimeAssembly({
      env: {
        MUSE_MODEL: "diagnostic/smoke",
        MUSE_MODEL_PROVIDER_ID: "diagnostic"
      }
    });

    await assembly.agentRuntime?.run({
      messages: [{ content: "first run", role: "user" }],
      model: "diagnostic/smoke",
      runId: "run-token-usage-1"
    });

    const sink = assembly.observability.tokenUsageSink as { list?(): readonly { readonly runId: string; readonly totalTokens: number }[] };
    expect(typeof sink.list).toBe("function");
    const events = sink.list!();
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]).toMatchObject({ runId: "run-token-usage-1" });
    expect(events[0]?.totalTokens).toBeGreaterThan(0);
  });

  it("adds the Rust runner tool only when explicitly enabled", () => {
    const disabled = createMuseRuntimeAssembly({ env: {} });
    const enabled = createMuseRuntimeAssembly({
      env: {
        MUSE_RUNNER_ENABLED: "true"
      }
    });

    expect(disabled.toolRegistry.get("run_command")).toBeUndefined();
    expect(enabled.toolRegistry.get("run_command")?.definition.risk).toBe("execute");
  });

  it("assembles named model providers without forcing an OpenAI-compatible base URL", () => {
    const anthropic = createMuseRuntimeAssembly({
      env: {
        ANTHROPIC_API_KEY: "key",
        MUSE_MODEL: "anthropic/claude-test"
      }
    });
    const gemini = createMuseRuntimeAssembly({
      env: {
        GEMINI_API_KEY: "key",
        MUSE_MODEL: "gemini/gemini-test"
      }
    });
    const ollama = createMuseRuntimeAssembly({
      env: {
        MUSE_MODEL: "ollama/llama3.2"
      }
    });

    expect(anthropic.modelProvider?.id).toBe("anthropic");
    expect(gemini.modelProvider?.id).toBe("gemini");
    expect(ollama.modelProvider?.id).toBe("ollama");
  });

  it("maps Slack API options from environment", () => {
    const options = createApiServerOptions({
      env: {
        MUSE_SLACK_BOT_TOKEN: "xoxb-token",
        MUSE_SLACK_ENABLED: "true",
        MUSE_SLACK_SIGNING_SECRET: "signing-secret"
      }
    });

    expect(options.slack).toMatchObject({
      botToken: "xoxb-token",
      enabled: true,
      signingSecret: "signing-secret"
    });
    expect(options.slack.responseTracker).toBeInstanceOf(SlackBotResponseTracker);
    expect(options.slack.feedbackStore).toBeTruthy();
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

  it("createLoopbackMcpToolsFromEnv ships nothing by default", () => {
    expect(createLoopbackMcpToolsFromEnv({})).toEqual([]);
  });

  it("createLoopbackMcpToolsFromEnv wires the eight default loopback servers when MUSE_LOOPBACK_MCP_ENABLED=true", () => {
    const tools = createLoopbackMcpToolsFromEnv({ MUSE_LOOPBACK_MCP_ENABLED: "true" });
    const names = tools.map((tool) => tool.definition.name).sort();
    // Spot-check three different servers: time, math, regex
    expect(names).toEqual(expect.arrayContaining(["muse.time.now", "muse.math.evaluate", "muse.regex.match"]));
    // muse.fetch and muse.fs must NOT appear without their own opt-ins
    expect(names.some((name) => name.startsWith("muse.fetch."))).toBe(false);
    expect(names.some((name) => name.startsWith("muse.fs."))).toBe(false);
  });

  it("createLoopbackMcpToolsFromEnv adds muse.fetch tools when MUSE_LOOPBACK_FETCH_HOSTS is set", () => {
    const tools = createLoopbackMcpToolsFromEnv({ MUSE_LOOPBACK_FETCH_HOSTS: "api.example.test,backup.example.test" });
    const names = tools.map((tool) => tool.definition.name).sort();
    expect(names).toEqual(["muse.fetch.get", "muse.fetch.head"]);
  });

  it("createLoopbackMcpToolsFromEnv adds muse.fs tools when MUSE_LOOPBACK_FS_ROOTS is set", () => {
    const tools = createLoopbackMcpToolsFromEnv({ MUSE_LOOPBACK_FS_ROOTS: "/tmp/workspace,/tmp/project" });
    const names = tools.map((tool) => tool.definition.name).sort();
    expect(names).toEqual(["muse.fs.list", "muse.fs.read", "muse.fs.stat"]);
  });

  it("createLoopbackMcpToolsFromEnv composes default + opt-in servers when all three flags are set", () => {
    const tools = createLoopbackMcpToolsFromEnv({
      MUSE_LOOPBACK_FETCH_HOSTS: "api.example.test",
      MUSE_LOOPBACK_FS_ROOTS: "/tmp/workspace",
      MUSE_LOOPBACK_MCP_ENABLED: "true"
    });
    const names = tools.map((tool) => tool.definition.name);
    expect(names.length).toBeGreaterThan(15);
    expect(names.some((name) => name === "muse.time.now")).toBe(true);
    expect(names.some((name) => name === "muse.fetch.get")).toBe(true);
    expect(names.some((name) => name === "muse.fs.read")).toBe(true);
  });

  it("createMuseRuntimeAssembly registers env-driven loopback MCP tools in the toolRegistry", () => {
    const assembly = createMuseRuntimeAssembly({
      env: {
        MUSE_LOOPBACK_FS_ROOTS: "/tmp/workspace",
        MUSE_LOOPBACK_MCP_ENABLED: "true"
      }
    });
    const names = assembly.toolRegistry.list().map((tool) => tool.definition.name);
    expect(names).toEqual(expect.arrayContaining(["muse.time.now", "muse.fs.read"]));
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
