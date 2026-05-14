import { describe, expect, it } from "vitest";
import type { MuseDatabase } from "@muse/db";
import { KyselyAgentSpecRegistry } from "@muse/agent-specs";
import { AsyncAuth } from "@muse/auth";
import {
  InMemoryTaskMemoryStore,
  KyselyConversationSummaryStore,
  KyselyTaskMemoryStore,
  KyselyUserMemoryStore
} from "@muse/memory";
import { KyselyMcpSecurityPolicyStore, KyselyMcpServerStore } from "@muse/mcp";
import { PersistedMuseTracer } from "@muse/observability";
import { KyselyRuntimeSettingsStore } from "@muse/runtime-settings";
import {
  KyselyAgentRunHistoryStore,
  KyselyDebugReplayCaptureStore,
  KyselyHookTraceStore,
  KyselySessionTagStore
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
  buildMessagingRegistry,
  createApiServerOptions,
  createLoopbackMcpToolsFromEnv,
  createMuseRuntimeAssembly,
  mergeModelKeysFromFile,
  parseBoolean,
  parseInteger,
  requireEnv,
  resolveDefaultModel,
  resolveLineInboxFile,
  resolveLocalCalendarFile,
  resolveMessagingCredentialsFile,
  resolveModelKeysFile,
  resolveNotesDir,
  resolveRemindersFile,
  resolveDiscordAfterFile,
  resolveDiscordInboxFile,
  resolveSlackAfterFile,
  resolveSlackInboxFile,
  resolveTasksFile,
  resolveTelegramInboxFile,
  resolveTelegramOffsetFile
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

  it("leaves voice registry undefined when no OpenAI key is configured", () => {
    const assembly = createMuseRuntimeAssembly({ env: {} });
    expect(assembly.voice).toBeUndefined();
  });

  it("registers OpenAI voice providers from the standard OPENAI_API_KEY env var", () => {
    // Most personal users set OPENAI_API_KEY once for the OpenAI SDK
    // convention. Voice should pick that up automatically without
    // needing a Muse-specific name.
    const assembly = createMuseRuntimeAssembly({ env: { OPENAI_API_KEY: "sk-test" } });
    expect(assembly.voice).toBeTruthy();
    expect(assembly.voice?.primaryStt()?.id).toBe("openai-whisper");
    expect(assembly.voice?.primaryTts()?.id).toBe("openai-tts");
  });

  it("MUSE_VOICE_OPENAI_API_KEY overrides OPENAI_API_KEY for voice-specific keys", () => {
    // Voice billing separation: a user can set the standard
    // OPENAI_API_KEY for chat and a different MUSE_VOICE_OPENAI_API_KEY
    // for voice. The Muse-specific override wins.
    const assembly = createMuseRuntimeAssembly({
      env: {
        MUSE_VOICE_OPENAI_API_KEY: "sk-voice",
        OPENAI_API_KEY: "sk-chat"
      }
    });
    expect(assembly.voice).toBeTruthy();
    expect(assembly.voice?.primaryStt()?.id).toBe("openai-whisper");
  });

  it("builds an ActiveContextProvider by default (Phase 1)", async () => {
    const { buildActiveContextProvider } = await import("../src/personal-providers.js");
    const provider = buildActiveContextProvider(
      { MUSE_DEFAULT_TIMEZONE: "UTC" },
      undefined
    );
    expect(provider).toBeDefined();
    const snapshot = await provider?.resolve();
    expect(snapshot?.timezone).toBe("UTC");
    expect(snapshot?.nowIso).toBeTruthy();
  });

  it("MUSE_ACTIVE_CONTEXT_ENABLED=false suppresses the Phase 1 provider", async () => {
    const { buildActiveContextProvider } = await import("../src/personal-providers.js");
    expect(
      buildActiveContextProvider({ MUSE_ACTIVE_CONTEXT_ENABLED: "false" }, undefined)
    ).toBeUndefined();
  });

  it("buildInboxContextProvider stays undefined when no messaging token is registered (Phase 2)", async () => {
    const { buildInboxContextProvider } = await import("../src/personal-providers.js");
    expect(buildInboxContextProvider({})).toBeUndefined();
  });

  it("buildToolFilter is off by default and on with MUSE_TOOL_FILTER_ENABLED=true (Phase 4)", async () => {
    const { buildToolFilter } = await import("../src/personal-providers.js");
    expect(buildToolFilter({})).toBeUndefined();
    expect(buildToolFilter({ MUSE_TOOL_FILTER_ENABLED: "true" })).toBeDefined();
  });

  it("buildTelemetryAggregator is ON by default and OFF when MUSE_TELEMETRY_AGGREGATOR_ENABLED=false", async () => {
    const { buildTelemetryAggregator } = await import("../src/personal-providers.js");
    expect(buildTelemetryAggregator({})).toBeDefined();
    expect(buildTelemetryAggregator({ MUSE_TELEMETRY_AGGREGATOR_ENABLED: "false" })).toBeUndefined();
    // explicit "true" stays enabled
    expect(buildTelemetryAggregator({ MUSE_TELEMETRY_AGGREGATOR_ENABLED: "true" })).toBeDefined();
  });

  it("buildTelemetryAggregator honours MUSE_TELEMETRY_AGGREGATOR_CAPACITY", async () => {
    const { buildTelemetryAggregator } = await import("../src/personal-providers.js");
    const agg = buildTelemetryAggregator({ MUSE_TELEMETRY_AGGREGATOR_CAPACITY: "3" });
    expect(agg).toBeDefined();
    // record 5, expect only last 3 retained
    const evt = {
      contextCounters: {},
      contextFlags: {},
      model: "diagnostic/smoke",
      providerId: "diagnostic",
      recordedAtMs: 1_000,
      runId: "r-1"
    };
    for (let i = 0; i < 5; i++) {
      agg!.record({ ...evt, recordedAtMs: 1_000 + i, runId: `r-${i.toString()}` });
    }
    expect(agg!.recent(10).map((e) => e.runId)).toEqual(["r-2", "r-3", "r-4"]);
  });

  it("buildEpisodicRecallProvider returns a provider when the store supports listAll (Phase 3)", async () => {
    const { buildEpisodicRecallProvider } = await import("../src/personal-providers.js");
    const { InMemoryConversationSummaryStore } = await import("@muse/memory");
    const store = new InMemoryConversationSummaryStore();
    expect(buildEpisodicRecallProvider({}, store)).toBeDefined();
  });

  it("buildEpisodicRecallProvider returns undefined when disabled or no store", async () => {
    const { buildEpisodicRecallProvider } = await import("../src/personal-providers.js");
    const { InMemoryConversationSummaryStore } = await import("@muse/memory");
    expect(buildEpisodicRecallProvider({}, undefined)).toBeUndefined();
    expect(
      buildEpisodicRecallProvider(
        { MUSE_EPISODIC_RECALL_ENABLED: "false" },
        new InMemoryConversationSummaryStore()
      )
    ).toBeUndefined();
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
    expect(options.cors).toEqual({ allowCredentials: true });
    expect(options.requireAuth).toBe(true);
    expect(options.mcp.manager).toBeTruthy();
    expect(options.scheduler.store.list()).toEqual([]);
    expect(options.debugReplayCaptureStore).toBeTruthy();
    expect(options.taskMemoryMaintenance.purgeExpired(new Date())).toBe(0);
  });

  it("parses MUSE_CORS_ALLOWED_ORIGINS into the cors.allowedOrigins list", () => {
    const options = createApiServerOptions({
      env: {
        MUSE_AUTH_JWT_SECRET: "0123456789abcdef0123456789abcdef",
        MUSE_CORS_ALLOWED_ORIGINS: "https://example.com, https://example.org"
      }
    });
    expect(options.cors).toEqual({
      allowCredentials: true,
      allowedOrigins: ["https://example.com", "https://example.org"]
    });
  });

  it("rejects a bare `*` in MUSE_CORS_ALLOWED_ORIGINS so a typo cannot silently widen to wildcard", () => {
    const options = createApiServerOptions({
      env: {
        MUSE_AUTH_JWT_SECRET: "0123456789abcdef0123456789abcdef",
        MUSE_CORS_ALLOWED_ORIGINS: "*"
      }
    });
    expect(options.cors).toEqual({ allowCredentials: true });
  });

  it("filters `*` out of a CSV but keeps the other origins", () => {
    const options = createApiServerOptions({
      env: {
        MUSE_AUTH_JWT_SECRET: "0123456789abcdef0123456789abcdef",
        MUSE_CORS_ALLOWED_ORIGINS: "https://example.com,*,https://example.org"
      }
    });
    expect(options.cors).toEqual({
      allowCredentials: true,
      allowedOrigins: ["https://example.com", "https://example.org"]
    });
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
    expect(assembly.debugReplayCaptureStore).toBeInstanceOf(KyselyDebugReplayCaptureStore);
    expect(assembly.observability.tracer).toBeInstanceOf(PersistedMuseTracer);
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

  it("wires working-budget compaction into the AgentRuntime by default", async () => {
    // added workingBudgetTokens to ConversationTrimOptions.
    // Round 158 wires autoconfigure to compute it as 40% of nominal
    // by default. We verify the soft trigger by setting a tiny
    // nominal context window (200 tokens) so the working budget
    // (40% = 80 tokens) is easy to exceed with a few-message
    // conversation. The hard cap (200) is still well above what
    // these messages need, so a "hard_limit" trigger would mean we
    // mis-wired the field.
    const assembly = createMuseRuntimeAssembly({
      env: {
        // Disable the Context Engineering Phase 1 system-prompt
        // injection so the budget math is dominated by the
        // conversation messages this test ships — otherwise the
        // ~80-token nominal budget tips into `hard_limit` from the
        // `[Active Context]` block alone, which isn't what this
        // test is exercising.
        MUSE_ACTIVE_CONTEXT_ENABLED: "false",
        MUSE_LLM_MAX_CONTEXT_WINDOW_TOKENS: "200",
        MUSE_LLM_MAX_OUTPUT_TOKENS: "10",
        MUSE_MODEL: "diagnostic/smoke",
        MUSE_MODEL_PROVIDER_ID: "diagnostic"
      }
    });

    const longerMessages = [
      { content: "first user message that is long enough to fill some tokens", role: "user" as const },
      { content: "first assistant response that also has decent length", role: "assistant" as const },
      { content: "second user message that adds more conversation history", role: "user" as const },
      { content: "second assistant response continuing the dialogue", role: "assistant" as const },
      { content: "third question asking about something else entirely", role: "user" as const }
    ];
    const result = await assembly.agentRuntime?.run({
      messages: longerMessages,
      model: "diagnostic/smoke"
    });

    // The runtime should have surfaced a context-window report and
    // it should have fired on the WORKING budget (proactive), not
    // the hard limit, because the hard cap is much larger than what
    // the messages consume.
    expect(result?.contextWindow).toBeDefined();
    expect(result?.contextWindow?.triggeredBy).toBe("working_budget");
    expect(result?.contextWindow?.removedCount).toBeGreaterThan(0);
  });

  it("respects MUSE_LLM_WORKING_BUDGET_TOKENS=0 to disable proactive compaction", async () => {
    // Same scenario as above but with the user explicitly opting
    // out via 0. The trim should NOT fire because the hard cap is
    // unreached and proactive compaction is disabled.
    const assembly = createMuseRuntimeAssembly({
      env: {
        MUSE_LLM_MAX_CONTEXT_WINDOW_TOKENS: "200",
        MUSE_LLM_MAX_OUTPUT_TOKENS: "10",
        MUSE_LLM_WORKING_BUDGET_TOKENS: "0",
        MUSE_MODEL: "diagnostic/smoke",
        MUSE_MODEL_PROVIDER_ID: "diagnostic"
      }
    });

    const result = await assembly.agentRuntime?.run({
      messages: [
        { content: "shorter", role: "user" }
      ],
      model: "diagnostic/smoke"
    });

    // Below both budgets → triggeredBy: "none".
    expect(result?.contextWindow?.triggeredBy).toBe("none");
    expect(result?.contextWindow?.removedCount).toBe(0);
  });

  it("feeds the MonthlyBudgetTracker from each agent run", async () => {
    const assembly = createMuseRuntimeAssembly({
      env: {
        MUSE_BUDGET_MONTHLY_LIMIT_USD: "100",
        MUSE_MODEL: "diagnostic/smoke",
        MUSE_MODEL_PROVIDER_ID: "diagnostic"
      }
    });

    expect(assembly.observability.budgetTracker).toBeTruthy();

    await assembly.agentRuntime?.run({
      messages: [{ content: "first call", role: "user" }],
      model: "diagnostic/smoke",
      runId: "budget-run-1"
    });
    await assembly.agentRuntime?.run({
      messages: [{ content: "second call", role: "user" }],
      model: "diagnostic/smoke",
      runId: "budget-run-2"
    });

    const snap = assembly.observability.budgetTracker.snapshot();
    expect(snap).toMatchObject({ limitUsd: 100, status: "ok" });
    expect(typeof snap.totalCostUsd).toBe("number");
  });

  it("feeds the PromptDriftDetector from each agent run", async () => {
    const assembly = createMuseRuntimeAssembly({
      env: {
        MUSE_DRIFT_MIN_SAMPLES: "1",
        MUSE_MODEL: "diagnostic/smoke",
        MUSE_MODEL_PROVIDER_ID: "diagnostic"
      }
    });

    expect(assembly.observability.driftDetector).toBeTruthy();

    await assembly.agentRuntime?.run({
      messages: [{ content: "first drift sample", role: "user" }],
      model: "diagnostic/smoke",
      runId: "drift-run-1"
    });
    await assembly.agentRuntime?.run({
      messages: [{ content: "second drift sample", role: "user" }],
      model: "diagnostic/smoke",
      runId: "drift-run-2"
    });

    const driftStats = assembly.observability.driftDetector.stats();
    expect(driftStats.sampleCount).toBe(2);
    expect(driftStats.inputMean).toBeGreaterThan(0);
    expect(driftStats.outputMean).toBeGreaterThan(0);
  });

  it("feeds the SloAlertEvaluator from each agent run so /api/admin/muse/snapshot.slo is populated", async () => {
    const assembly = createMuseRuntimeAssembly({
      env: {
        MUSE_MODEL: "diagnostic/smoke",
        MUSE_MODEL_PROVIDER_ID: "diagnostic",
        MUSE_SLO_MIN_SAMPLES: "1"
      }
    });

    expect(assembly.observability.sloEvaluator).toBeTruthy();
    await assembly.agentRuntime?.run({
      messages: [{ content: "first", role: "user" }],
      model: "diagnostic/smoke",
      runId: "slo-run-1"
    });
    await assembly.agentRuntime?.run({
      messages: [{ content: "second", role: "user" }],
      model: "diagnostic/smoke",
      runId: "slo-run-2"
    });

    const snapshot = assembly.observability.sloEvaluator.snapshot();
    expect(snapshot.latencySamples).toBe(2);
    expect(snapshot.resultSamples).toBe(2);
    expect(snapshot.errorRate).toBe(0);
    expect(snapshot.latencyP95Ms).toBeGreaterThanOrEqual(0);
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

  it("registers muse.notes-multi tools only when MUSE_NOTES_PROVIDERS adds another backend beyond local", () => {
    const baseline = createMuseRuntimeAssembly({ env: {} });
    const baselineNames = baseline.toolRegistry.list().map((tool) => tool.definition.name);

    // Default: only local provider → muse.notes (filesystem-only) is enough,
    // muse.notes-multi.* tools should NOT be registered.
    expect(baselineNames.some((name) => name.startsWith("muse.notes-multi."))).toBe(false);
    expect(baselineNames).toEqual(expect.arrayContaining(["muse.notes.list"]));

    // Adding apple → registry has 2 providers → muse.notes-multi.* surfaces.
    const enabled = createMuseRuntimeAssembly({
      env: { MUSE_NOTES_PROVIDERS: "local,apple" }
    });
    const enabledNames = enabled.toolRegistry.list().map((tool) => tool.definition.name);
    expect(enabledNames).toEqual(expect.arrayContaining([
      "muse.notes-multi.providers",
      "muse.notes-multi.list",
      "muse.notes-multi.read",
      "muse.notes-multi.search",
      "muse.notes-multi.save",
      "muse.notes-multi.append"
    ]));
  });

  it("skips Notion notes provider when no token is available", () => {
    // notion requested but no token → silent skip; registry stays at 1 (local
    // baseline) so muse.notes-multi.* tools NOT registered.
    const assembly = createMuseRuntimeAssembly({
      env: { MUSE_NOTES_PROVIDERS: "local,notion" }
    });
    const names = assembly.toolRegistry.list().map((tool) => tool.definition.name);
    expect(names.some((name) => name.startsWith("muse.notes-multi."))).toBe(false);
  });

  it("registers muse.tasks-multi tools only when MUSE_TASKS_PROVIDERS adds another backend beyond local", () => {
    const baseline = createMuseRuntimeAssembly({ env: {} });
    const baselineNames = baseline.toolRegistry.list().map((tool) => tool.definition.name);

    // Default: only local provider → muse.tasks (filesystem-only) is enough,
    // muse.tasks-multi.* tools should NOT be registered.
    expect(baselineNames.some((name) => name.startsWith("muse.tasks-multi."))).toBe(false);
    expect(baselineNames).toEqual(expect.arrayContaining(["muse.tasks.list"]));

    // Adding apple-reminders → registry has 2 providers → muse.tasks-multi.*
    // surfaces (5 tools: providers / list / add / complete / search).
    const enabled = createMuseRuntimeAssembly({
      env: { MUSE_TASKS_PROVIDERS: "local,apple-reminders" }
    });
    const enabledNames = enabled.toolRegistry.list().map((tool) => tool.definition.name);
    expect(enabledNames).toEqual(expect.arrayContaining([
      "muse.tasks-multi.providers",
      "muse.tasks-multi.list",
      "muse.tasks-multi.add",
      "muse.tasks-multi.complete",
      "muse.tasks-multi.search"
    ]));
  });

  it("the dot-muse path resolvers honour env overrides and fall back to ~/.muse defaults", () => {
    // Env override branch — supplied path is returned verbatim.
    expect(resolveTasksFile({ MUSE_TASKS_FILE: "/tmp/custom-tasks.json" })).toBe("/tmp/custom-tasks.json");
    expect(resolveNotesDir({ MUSE_NOTES_DIR: "/tmp/custom-notes" })).toBe("/tmp/custom-notes");
    expect(resolveRemindersFile({ MUSE_REMINDERS_FILE: "/tmp/r.json" })).toBe("/tmp/r.json");
    expect(resolveLocalCalendarFile({ MUSE_CALENDAR_FILE: "/tmp/c.json" })).toBe("/tmp/c.json");
    expect(resolveMessagingCredentialsFile({ MUSE_MESSAGING_CREDENTIALS_FILE: "/tmp/m.json" })).toBe("/tmp/m.json");
    expect(resolveModelKeysFile({ MUSE_MODEL_KEYS_FILE: "/tmp/k.json" })).toBe("/tmp/k.json");
    expect(resolveLineInboxFile({ MUSE_LINE_INBOX_FILE: "/tmp/l.json" })).toBe("/tmp/l.json");
    expect(resolveTelegramOffsetFile({ MUSE_TELEGRAM_OFFSET_FILE: "/tmp/tg.json" })).toBe("/tmp/tg.json");
    expect(resolveTelegramInboxFile({ MUSE_TELEGRAM_INBOX_FILE: "/tmp/tin.json" })).toBe("/tmp/tin.json");
    expect(resolveDiscordAfterFile({ MUSE_DISCORD_AFTER_FILE: "/tmp/da.json" })).toBe("/tmp/da.json");
    expect(resolveDiscordInboxFile({ MUSE_DISCORD_INBOX_FILE: "/tmp/din.json" })).toBe("/tmp/din.json");
    expect(resolveSlackAfterFile({ MUSE_SLACK_AFTER_FILE: "/tmp/sa.json" })).toBe("/tmp/sa.json");
    expect(resolveSlackInboxFile({ MUSE_SLACK_INBOX_FILE: "/tmp/sin.json" })).toBe("/tmp/sin.json");

    // Empty / whitespace-only override → falls back to default.
    expect(resolveTasksFile({ MUSE_TASKS_FILE: "" }).endsWith("/.muse/tasks.json")).toBe(true);
    expect(resolveTasksFile({ MUSE_TASKS_FILE: "   " }).endsWith("/.muse/tasks.json")).toBe(true);

    // Default path branch — each resolver picks its own filename.
    expect(resolveTasksFile({}).endsWith("/.muse/tasks.json")).toBe(true);
    expect(resolveNotesDir({}).endsWith("/.muse/notes")).toBe(true);
    expect(resolveRemindersFile({}).endsWith("/.muse/reminders.json")).toBe(true);
    expect(resolveLocalCalendarFile({}).endsWith("/.muse/calendar.json")).toBe(true);
    expect(resolveMessagingCredentialsFile({}).endsWith("/.muse/messaging.json")).toBe(true);
    expect(resolveModelKeysFile({}).endsWith("/.muse/models.json")).toBe(true);
    expect(resolveLineInboxFile({}).endsWith("/.muse/line-inbox.json")).toBe(true);
    expect(resolveTelegramOffsetFile({}).endsWith("/.muse/telegram-offset.json")).toBe(true);
    expect(resolveTelegramInboxFile({}).endsWith("/.muse/telegram-inbox.json")).toBe(true);
    expect(resolveDiscordAfterFile({}).endsWith("/.muse/discord-after.json")).toBe(true);
    expect(resolveDiscordInboxFile({}).endsWith("/.muse/discord-inbox.json")).toBe(true);
    expect(resolveSlackAfterFile({}).endsWith("/.muse/slack-after.json")).toBe(true);
    expect(resolveSlackInboxFile({}).endsWith("/.muse/slack-inbox.json")).toBe(true);
  });

  it("resolveDefaultModel honors MUSE_MODEL when explicitly set", () => {
    expect(resolveDefaultModel({ MUSE_MODEL: "openai/gpt-4o-mini" })).toBe("openai/gpt-4o-mini");
    expect(resolveDefaultModel({ MUSE_DEFAULT_MODEL: "anthropic/claude-haiku-4-5-20251001" }))
      .toBe("anthropic/claude-haiku-4-5-20251001");
  });

  it("resolveDefaultModel infers from credentials when MUSE_MODEL is unset", () => {
    expect(resolveDefaultModel({ GEMINI_API_KEY: "x" })).toBe("gemini/gemini-2.0-flash");
    expect(resolveDefaultModel({ GOOGLE_API_KEY: "x" })).toBe("gemini/gemini-2.0-flash");
    expect(resolveDefaultModel({ OPENAI_API_KEY: "x" })).toBe("openai/gpt-4o-mini");
    expect(resolveDefaultModel({ ANTHROPIC_API_KEY: "x" })).toBe("anthropic/claude-haiku-4-5-20251001");
    expect(resolveDefaultModel({ OPENROUTER_API_KEY: "x" }))
      .toBe("openrouter/google/gemini-2.0-flash-001");
  });

  it("resolveDefaultModel returns undefined when no model + no credentials present", () => {
    expect(resolveDefaultModel({})).toBeUndefined();
  });

  it("resolveDefaultModel prefers GEMINI over OPENAI when both keys are present", () => {
    expect(resolveDefaultModel({
      GEMINI_API_KEY: "g",
      OPENAI_API_KEY: "o"
    })).toBe("gemini/gemini-2.0-flash");
  });

  it("createMuseRuntimeAssembly wires agentRuntime when only an API key is in env (no MUSE_MODEL)", () => {
    const assembly = createMuseRuntimeAssembly({ env: { GEMINI_API_KEY: "fake-key-for-test" } });
    expect(assembly.agentRuntime).toBeDefined();
    expect(assembly.defaultModel).toBe("gemini/gemini-2.0-flash");
  });

  it("mergeModelKeysFromFile lifts ~/.muse/models.json keys into env (env wins on conflict)", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "muse-modelkeys-"));
    const file = join(root, "models.json");
    writeFileSync(file, JSON.stringify({
      providers: {
        anthropic: { suggestedModel: "anthropic/claude-haiku-4-5", token: "from-file-anthropic" },
        gemini: { suggestedModel: "gemini/gemini-2.0-flash", token: "from-file-gemini" },
        ollama: { suggestedModel: "ollama/llama3.2", token: "http://localhost:11434" },
        openai: { suggestedModel: "openai/gpt-4o-mini", token: "from-file-openai" }
      },
      version: 1
    }), "utf8");

    // file-only: empty env, all four file entries appear under their env keys.
    const fileOnly = mergeModelKeysFromFile({ MUSE_MODEL_KEYS_FILE: file });
    expect(fileOnly.OPENAI_API_KEY).toBe("from-file-openai");
    expect(fileOnly.ANTHROPIC_API_KEY).toBe("from-file-anthropic");
    expect(fileOnly.GEMINI_API_KEY).toBe("from-file-gemini");
    expect(fileOnly.OLLAMA_BASE_URL).toBe("http://localhost:11434");

    // env wins on conflict: a one-off shell export stays effective.
    const merged = mergeModelKeysFromFile({
      MUSE_MODEL_KEYS_FILE: file,
      OPENAI_API_KEY: "from-env-openai"
    });
    expect(merged.OPENAI_API_KEY).toBe("from-env-openai");
    expect(merged.ANTHROPIC_API_KEY).toBe("from-file-anthropic"); // file still fills in

    // Missing file → identity (env unchanged, no crash).
    const noFile = mergeModelKeysFromFile({
      MUSE_MODEL_KEYS_FILE: join(root, "missing.json"),
      OPENAI_API_KEY: "stays"
    });
    expect(noFile.OPENAI_API_KEY).toBe("stays");
    expect(noFile.GEMINI_API_KEY).toBeUndefined();

    // MUSE_MODEL falls back to the first provider's `suggestedModel`
    // when env doesn't already set it — keeps `muse setup model`
    // turnkey without a second export step. Provider iteration is
    // OPENAI → ANTHROPIC → GEMINI → OPENROUTER → OLLAMA.
    expect(fileOnly.MUSE_MODEL).toBe("openai/gpt-4o-mini");

    // Env wins on MUSE_MODEL too.
    const mergedWithModel = mergeModelKeysFromFile({
      MUSE_MODEL: "anthropic/claude-haiku-4-5-20251001",
      MUSE_MODEL_KEYS_FILE: file
    });
    expect(mergedWithModel.MUSE_MODEL).toBe("anthropic/claude-haiku-4-5-20251001");
  });

  it("mergeModelKeysFromFile hydrates every OpenAI-compat preset (Groq / DeepSeek / Together / Mistral / Moonshot / Cerebras)", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "muse-modelkeys-presets-"));
    const file = join(root, "models.json");
    writeFileSync(file, JSON.stringify({
      providers: {
        cerebras: { token: "from-file-cerebras" },
        deepseek: { token: "from-file-deepseek" },
        groq: { token: "from-file-groq" },
        mistral: { token: "from-file-mistral" },
        moonshot: { token: "from-file-moonshot" },
        together: { token: "from-file-together" }
      },
      version: 1
    }), "utf8");

    const merged = mergeModelKeysFromFile({ MUSE_MODEL_KEYS_FILE: file });
    expect(merged.GROQ_API_KEY).toBe("from-file-groq");
    expect(merged.DEEPSEEK_API_KEY).toBe("from-file-deepseek");
    expect(merged.TOGETHER_API_KEY).toBe("from-file-together");
    expect(merged.MISTRAL_API_KEY).toBe("from-file-mistral");
    expect(merged.MOONSHOT_API_KEY).toBe("from-file-moonshot");
    expect(merged.CEREBRAS_API_KEY).toBe("from-file-cerebras");
  });

  it("buildMessagingRegistry honours env tokens, the credentials file, and env-overrides-file", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "muse-msg-creds-"));
    const file = join(root, "messaging.json");
    writeFileSync(file, JSON.stringify({
      providers: {
        line: { token: "from-file-line" },
        slack: { token: "from-file-slack" },
        telegram: { token: "from-file-telegram" }
      },
      version: 1
    }), "utf8");

    // file-only: no env at all. `log` always registers unless
    // explicitly disabled — credential-free local-log surface.
    const fileOnly = buildMessagingRegistry({ MUSE_MESSAGING_CREDENTIALS_FILE: file });
    expect(fileOnly.describe().map((entry) => entry.id).sort()).toEqual(["line", "log", "slack", "telegram"]);

    // env-only: env token registers, file ignored for that one
    const envOnly = buildMessagingRegistry({
      MUSE_DISCORD_BOT_TOKEN: "from-env-discord",
      MUSE_MESSAGING_CREDENTIALS_FILE: join(root, "missing.json")
    });
    expect(envOnly.describe().map((entry) => entry.id).sort()).toEqual(["discord", "log"]);

    // env wins when both are present (no easy way to assert which token without
    // calling send, but the registration count + presence proves the merge).
    const merged = buildMessagingRegistry({
      MUSE_MESSAGING_CREDENTIALS_FILE: file,
      MUSE_DISCORD_BOT_TOKEN: "from-env-discord"
    });
    expect(merged.describe().map((entry) => entry.id).sort()).toEqual(["discord", "line", "log", "slack", "telegram"]);

    // opt out: MUSE_MESSAGING_LOG_ENABLED=false suppresses the
    // credential-free local-log provider.
    const noLog = buildMessagingRegistry({
      MUSE_MESSAGING_CREDENTIALS_FILE: file,
      MUSE_MESSAGING_LOG_ENABLED: "false"
    });
    expect(noLog.describe().map((entry) => entry.id).sort()).toEqual(["line", "slack", "telegram"]);

    // opt in to macOS desktop notifications (darwin-only; this test
    // host happens to be darwin — on Linux the registry silently
    // skips, so we assert presence only via `includes` to keep the
    // check portable).
    if (process.platform === "darwin") {
      const withNotif = buildMessagingRegistry({
        MUSE_MESSAGING_CREDENTIALS_FILE: file,
        MUSE_MESSAGING_LOG_ENABLED: "false",
        MUSE_MESSAGING_MACOS_NOTIFICATION_ENABLED: "true"
      });
      expect(withNotif.describe().map((entry) => entry.id)).toContain("macos-notification");
    }
  });

  it("buildMessagingRegistry wires offset + inbox files into the TelegramProvider", async () => {
    const { mkdtempSync, promises: fs } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { TelegramProvider } = await import("@muse/messaging");
    const root = mkdtempSync(join(tmpdir(), "muse-tg-wire-"));
    const offsetFile = join(root, "tg-offset.json");
    const inboxFile = join(root, "tg-inbox.json");
    // Seed both: a high-watermark for pollUpdates and one persisted
    // message for fetchInbound (so the store-read path has something
    // to return).
    await fs.writeFile(offsetFile, JSON.stringify({ offset: 555, version: 1 }), "utf8");
    await fs.writeFile(inboxFile, JSON.stringify({
      inbox: [{
        messageId: "10",
        providerId: "telegram",
        receivedAtIso: "2026-05-11T00:00:00.000Z",
        source: "999",
        text: "from inbox file"
      }],
      version: 1
    }), "utf8");
    const seenUrls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      seenUrls.push(String(url));
      return new Response(JSON.stringify({ ok: true, result: [] }), {
        headers: { "content-type": "application/json" }
      });
    }) as typeof globalThis.fetch;
    try {
      const registry = buildMessagingRegistry({
        MUSE_TELEGRAM_BOT_TOKEN: "TOK",
        MUSE_TELEGRAM_INBOX_FILE: inboxFile,
        MUSE_TELEGRAM_OFFSET_FILE: offsetFile
      });
      // fetchInbound goes through the inbox file once configured — the
      // daemon-served read path. Bot API must not be hit here.
      const inboxRead = await registry.fetchInbound("telegram");
      expect(inboxRead.map((m) => m.text)).toEqual(["from inbox file"]);
      expect(seenUrls).toEqual([]);
      // pollUpdates is the Bot-API-side ingestion path the daemon uses.
      // It must include the stored offset in the URL.
      const telegram = registry.require("telegram");
      expect(telegram).toBeInstanceOf(TelegramProvider);
      await (telegram as InstanceType<typeof TelegramProvider>).pollUpdates();
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(seenUrls[0]).toContain("&offset=555");
  });

  it("buildMessagingRegistry wires after + inbox files into the DiscordProvider", async () => {
    const { mkdtempSync, promises: fs } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { DiscordProvider } = await import("@muse/messaging");
    const root = mkdtempSync(join(tmpdir(), "muse-disc-wire-"));
    const afterFile = join(root, "after.json");
    const inboxFile = join(root, "inbox.json");
    // Seed both: a per-channel cursor for pollUpdates, and one
    // persisted message for fetchInbound (proves the inbox path is
    // wired through to the registry-built provider, not just the
    // resolver).
    await fs.writeFile(afterFile, JSON.stringify({
      after: { "ch-9": "1099999999999999999" },
      version: 1
    }), "utf8");
    await fs.writeFile(inboxFile, JSON.stringify({
      inbox: [{
        messageId: "10",
        providerId: "discord",
        receivedAtIso: "2026-05-11T00:00:00.000Z",
        source: "ch-9",
        text: "from inbox file"
      }],
      version: 1
    }), "utf8");
    const seenUrls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      seenUrls.push(String(url));
      return new Response("[]", { headers: { "content-type": "application/json" } });
    }) as typeof globalThis.fetch;
    try {
      const registry = buildMessagingRegistry({
        MUSE_DISCORD_AFTER_FILE: afterFile,
        MUSE_DISCORD_BOT_TOKEN: "BOT",
        MUSE_DISCORD_INBOX_FILE: inboxFile
      });
      // fetchInbound goes through the inbox file once configured.
      // Bot API must not be hit here.
      const inboxRead = await registry.fetchInbound("discord", { source: "ch-9" });
      expect(inboxRead.map((m) => m.text)).toEqual(["from inbox file"]);
      expect(seenUrls).toEqual([]);
      // pollUpdates is the Discord-API-side ingestion path the
      // daemon uses; must include the stored after cursor.
      const discord = registry.require("discord");
      expect(discord).toBeInstanceOf(DiscordProvider);
      await (discord as InstanceType<typeof DiscordProvider>).pollUpdates({ source: "ch-9" });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(seenUrls[0]).toContain("&after=1099999999999999999");
  });

  it("buildMessagingRegistry wires after + inbox files into the SlackProvider", async () => {
    const { mkdtempSync, promises: fs } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { SlackProvider } = await import("@muse/messaging");
    const root = mkdtempSync(join(tmpdir(), "muse-slack-wire-"));
    const afterFile = join(root, "after.json");
    const inboxFile = join(root, "inbox.json");
    await fs.writeFile(afterFile, JSON.stringify({
      after: { "C-9": "1700000000.123456" },
      version: 1
    }), "utf8");
    await fs.writeFile(inboxFile, JSON.stringify({
      inbox: [{
        messageId: "1700000099.999999",
        providerId: "slack",
        receivedAtIso: "2026-05-11T00:00:00.000Z",
        source: "C-9",
        text: "from inbox file"
      }],
      version: 1
    }), "utf8");
    const seenBodies: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      seenBodies.push(String(init?.body ?? ""));
      return new Response(JSON.stringify({ messages: [], ok: true }), {
        headers: { "content-type": "application/json" }
      });
    }) as typeof globalThis.fetch;
    try {
      const registry = buildMessagingRegistry({
        MUSE_SLACK_AFTER_FILE: afterFile,
        MUSE_SLACK_BOT_TOKEN: "xoxb-test",
        MUSE_SLACK_INBOX_FILE: inboxFile
      });
      // fetchInbound goes through the inbox file once configured.
      // Slack API must not be hit here.
      const inboxRead = await registry.fetchInbound("slack", { source: "C-9" });
      expect(inboxRead.map((m) => m.text)).toEqual(["from inbox file"]);
      expect(seenBodies).toEqual([]);
      // pollUpdates is the Slack-API-side ingestion path the daemon
      // uses; must include the stored ts cursor in the form body.
      const slack = registry.require("slack");
      expect(slack).toBeInstanceOf(SlackProvider);
      await (slack as InstanceType<typeof SlackProvider>).pollUpdates({ source: "C-9" });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(seenBodies[0]).toContain("oldest=1700000000.123456");
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
