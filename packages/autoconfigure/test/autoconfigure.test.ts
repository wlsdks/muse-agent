import { describe, expect, it } from "vitest";
import type { MuseDatabase } from "@muse/db";
import { KyselyAgentSpecRegistry } from "@muse/agent-specs";
import { AsyncAuthService } from "@muse/auth";
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
    expect(assembly.authService).toBeInstanceOf(AsyncAuthService);
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
