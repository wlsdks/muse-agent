import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

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
import { parseNonNegativeFloat, parseNonNegativeInteger, parsePositiveFloat, parseSloErrorRate } from "../src/env-parsers.js";
import { resolveWorkspaceSkillsDir } from "../src/provider-paths.js";
import { createPersonalToolExposurePolicy } from "../src/runtime-wiring.js";

const workingBudgetTempRoot = mkdtempSync(join(tmpdir(), "muse-working-budget-"));
const workingBudgetMissingPersonaFile = join(workingBudgetTempRoot, "persona.md");
const workingBudgetMissingModelKeysFile = join(workingBudgetTempRoot, "models.json");

function baseWorkingBudgetEnv(overrides: Readonly<Record<string, string>> = {}): Record<string, string> {
  return {
    HOME: workingBudgetTempRoot,
    MUSE_ACTIVE_CONTEXT_ENABLED: "false",
    MUSE_CONVERSATION_SUMMARY_PERSIST: "false",
    MUSE_FOLLOWUP_CAPTURE_ENABLED: "false",
    MUSE_LLM_MAX_CONTEXT_WINDOW_TOKENS: "4096",
    MUSE_LLM_MAX_OUTPUT_TOKENS: "10",
    MUSE_MODEL: "diagnostic/smoke",
    MUSE_MODEL_KEYS_FILE: workingBudgetMissingModelKeysFile,
    MUSE_MODEL_PROVIDER_ID: "diagnostic",
    MUSE_PERSONA_MD_FILE: workingBudgetMissingPersonaFile,
    MUSE_PLAN_CACHE: "false",
    MUSE_PLAYBOOK: "false",
    MUSE_SKILLS_ENABLED: "false",
    MUSE_TOOL_EXEMPLARS: "false",
    MUSE_USER_MEMORY_AUTO_EXTRACT: "false",
    MUSE_USER_MEMORY_INJECTION: "false",
    ...overrides
  };
}

const workingBudgetHistory = [
  { content: "working-budget payload ".repeat(75), role: "user" as const },
  { content: "working-budget payload ".repeat(75), role: "assistant" as const },
  { content: "working-budget payload ".repeat(75), role: "user" as const },
  { content: "working-budget payload ".repeat(75), role: "assistant" as const },
  { content: "What should we do next?", role: "user" as const }
];

const standardRunnerContainmentCases: readonly { readonly name: string; readonly env: Record<string, string> }[] = [
  { name: "unset", env: {} },
  { name: "MUSE_RUNNER_ENABLED=false", env: { MUSE_RUNNER_ENABLED: "false" } },
  { name: "MUSE_RUNNER_ENABLED=true", env: { MUSE_RUNNER_ENABLED: "true" } },
  {
    name: "MUSE_RUNNER_ENABLED=true with an arbitrary runner path",
    env: { MUSE_RUNNER_ENABLED: "true", MUSE_RUNNER_PATH: "/arbitrary/muse-runner" }
  },
  {
    name: "MUSE_LOCAL_ONLY=true with enabled runner and an invalid path",
    env: {
      MUSE_LOCAL_ONLY: "true",
      MUSE_RUNNER_ENABLED: "true",
      MUSE_RUNNER_PATH: "/definitely-not-a-muse-runner"
    }
  }
];

describe("autoconfigure", () => {
  it("assembles default runtime without auth when no secret is configured", async () => {
    // PERSIST=false keeps the task store in-memory: this test verifies the assembly
    // WIRES a usable store, not file persistence (covered in store-factories +
    // file-task-memory-store tests), and must not write to the real ~/.muse.
    const assembly = createMuseRuntimeAssembly({ env: { MUSE_TASK_MEMORY_PERSIST: "false" } });

    expect(assembly.authService).toBeUndefined();
    expect(assembly.requireAuth).toBe(false);
    // Local-first: with zero config (and local-only on by default) the runtime
    // resolves the local Ollama default model, so a working agentRuntime IS
    // assembled — no cloud key, no env needed.
    expect(assembly.agentRuntime).toBeTruthy();
    expect(assembly.mcp.manager.getToolCatalog()).toEqual([]);
    expect(assembly.cache.responseCache.size()).toBe(0);
    expect(assembly.observability.metrics.recordedEvents()).toEqual([]);
    expect(assembly.observability.followupSuggestionStore.aggregateStats().totalImpressions).toBe(0);
    // The local-first default provider registers its own generate breaker.
    expect(assembly.resilience.circuitBreakerRegistry.names()).toEqual(["model.generate"]);
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

  it("merges caller-supplied extraTools into the runtime registry", () => {
    const probe = {
      definition: { description: "probe", inputSchema: { properties: {}, type: "object" as const }, name: "probe_extra_tool", risk: "read" as const },
      execute: () => ({ ok: true })
    };
    const without = createMuseRuntimeAssembly({ env: {} });
    expect(without.toolRegistry.get("probe_extra_tool")).toBeUndefined();

    const withExtra = createMuseRuntimeAssembly({ env: {}, extraTools: [probe] });
    expect(withExtra.toolRegistry.get("probe_extra_tool")).toBeDefined();
    expect(withExtra.toolRegistry.list().map((tool) => tool.definition.name)).toContain("probe_extra_tool");
  });

  it("exposes an execute-risk extraTool actuator to the model only under localMode and only when relevant", () => {
    const env = { MUSE_MODEL: "ollama/qwen3:8b", OLLAMA_BASE_URL: "http://127.0.0.1:11434" };
    const emailActuator = {
      definition: {
        description: "Send an email to one of the user's contacts.",
        domain: "messaging" as const,
        inputSchema: { additionalProperties: false, properties: {}, type: "object" as const },
        keywords: ["email", "send", "reply", "mail"],
        name: "email_send",
        risk: "execute" as const
      },
      execute: () => ({ sent: false })
    };
    const assembly = createMuseRuntimeAssembly({ env, extraTools: [emailActuator] });
    const policy = createPersonalToolExposurePolicy(env);
    const exposed = (ctx: { localMode: boolean; prompt: string }) =>
      assembly.toolRegistry.planForContext(ctx, policy).tools.some((tool) => tool.definition.name === "email_send");

    // The `muse ask --with-tools --actuators` path sets localMode; a
    // natural actuation prompt must reach the actuator…
    expect(exposed({ localMode: true, prompt: "email Bob the Q3 summary" })).toBe(true);
    // …without --actuators (no localMode) it stays hidden (fail-safe)…
    expect(exposed({ localMode: false, prompt: "email Bob the Q3 summary" })).toBe(false);
    // …and relevance gating keeps it off unrelated turns.
    expect(exposed({ localMode: true, prompt: "what is the capital of France" })).toBe(false);
  });

  it("registers OpenAI voice providers from the standard OPENAI_API_KEY env var", () => {
    // Most personal users set OPENAI_API_KEY once for the OpenAI SDK
    // convention. Voice should pick that up automatically without
    // needing a Muse-specific name.
    // Cloud voice requires opting out of the default local-only gate.
    const assembly = createMuseRuntimeAssembly({ env: { MUSE_LOCAL_ONLY: "false", OPENAI_API_KEY: "sk-test" } });
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
        MUSE_LOCAL_ONLY: "false",
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
    // Pin the credentials file to an empty tmp location — the default falls
    // back to the REAL ~/.muse/messaging.json, so a token registered on the
    // dev machine would leak into this "no token" assumption.
    const emptyCredentials = join(mkdtempSync(join(tmpdir(), "muse-inbox-isolated-")), "messaging.json");
    expect(buildInboxContextProvider({ MUSE_MESSAGING_CREDENTIALS_FILE: emptyCredentials })).toBeUndefined();
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

  it("the Ollama embedder used by the recall provider treats an empty OLLAMA_BASE_URL= as unset (goal-478 sibling)", async () => {
    const { buildEpisodicRecallProvider } = await import("../src/personal-providers.js");
    const { InMemoryConversationSummaryStore } = await import("@muse/memory");
    const captured: string[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      captured.push(typeof input === "string" ? input : input.toString());
      return new Response(JSON.stringify({ embedding: [0.1, 0.2, 0.3] }), { status: 200 });
    }) as typeof globalThis.fetch;
    const origEnv = process.env.OLLAMA_BASE_URL;
    process.env.OLLAMA_BASE_URL = "";
    try {
      const store = new InMemoryConversationSummaryStore();
      store.save({
        narrative: "We discussed the Q3 budget at length last Tuesday.",
        sessionId: "s-1",
        summarizedUpToIndex: 0,
        userId: "u-1"
      });
      const provider = buildEpisodicRecallProvider({}, store)!;
      await provider.resolve("budget conversation", "u-1");
      expect(captured.length).toBeGreaterThan(0);
      expect(captured[0]).toBe("http://127.0.0.1:11434/api/embeddings");
    } finally {
      globalThis.fetch = origFetch;
      if (origEnv === undefined) delete process.env.OLLAMA_BASE_URL;
      else process.env.OLLAMA_BASE_URL = origEnv;
    }
  });

  it("createOllamaEmbedder passes keep_alive so the embed model stays warm (MUSE_OLLAMA_KEEP_ALIVE, default 30m)", async () => {
    const { createOllamaEmbedder } = await import("../src/context-engineering-builders.js");
    const bodies: string[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ""));
      return new Response(JSON.stringify({ embedding: [0.1] }), { status: 200 });
    }) as typeof globalThis.fetch;
    const origKeep = process.env.MUSE_OLLAMA_KEEP_ALIVE;
    try {
      process.env.MUSE_OLLAMA_KEEP_ALIVE = "2h";
      await createOllamaEmbedder("nomic-embed-text")("hello");
      expect(JSON.parse(bodies[0]!).keep_alive).toBe("2h");

      delete process.env.MUSE_OLLAMA_KEEP_ALIVE;
      await createOllamaEmbedder("nomic-embed-text")("world");
      expect(JSON.parse(bodies[1]!).keep_alive).toBe("30m");
    } finally {
      globalThis.fetch = origFetch;
      if (origKeep === undefined) delete process.env.MUSE_OLLAMA_KEEP_ALIVE;
      else process.env.MUSE_OLLAMA_KEEP_ALIVE = origKeep;
    }
  });

  it("assembles auth and API options when JWT secret is configured", () => {
    const options = createApiServerOptions({
      env: {
        MUSE_AUTH_JWT_SECRET: "0123456789abcdef0123456789abcdef",
        MUSE_REQUIRE_AUTH: "true",
        MUSE_TASK_MEMORY_PERSIST: "false" // in-memory: assert sync purgeExpired, no real-~/.muse write
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
        MUSE_LOCAL_ONLY: "false", // remote OpenAI-compatible endpoint = cloud egress
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
    const assembly = createMuseRuntimeAssembly({
      env: baseWorkingBudgetEnv()
    });
    const result = await assembly.agentRuntime?.run({
      messages: workingBudgetHistory,
      model: "diagnostic/smoke"
    });

    expect(result?.contextWindow?.budgetTokens).toBe(4086);
    expect(result?.contextWindow?.triggeredBy).toBe("working_budget");
    expect(result?.contextWindow?.removedCount).toBeGreaterThan(0);
  });

  it("respects MUSE_LLM_WORKING_BUDGET_TOKENS=0 to disable proactive compaction", async () => {
    const assembly = createMuseRuntimeAssembly({
      env: baseWorkingBudgetEnv({ MUSE_LLM_WORKING_BUDGET_TOKENS: "0" })
    });

    const result = await assembly.agentRuntime?.run({
      messages: workingBudgetHistory,
      model: "diagnostic/smoke"
    });

    expect(result?.contextWindow?.budgetTokens).toBe(4086);
    expect(result?.contextWindow?.triggeredBy).toBe("none");
    expect(result?.contextWindow?.removedCount).toBe(0);
    expect(result?.contextWindow?.estimatedTokens).toBeGreaterThan(1638);
    expect(result?.contextWindow?.estimatedTokens).toBeLessThanOrEqual(4086);
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

  for (const { name, env } of standardRunnerContainmentCases) {
    it(`does not register run_command in the standard runtime registry when ${name}`, () => {
      const assembly = createMuseRuntimeAssembly({ env });

      expect(assembly.toolRegistry.get("run_command")).toBeUndefined();
      expect(assembly.toolRegistry.list().map((tool) => tool.definition.name)).not.toContain("run_command");
    });
  }

  it("assembles named model providers without forcing an OpenAI-compatible base URL", () => {
    const anthropic = createMuseRuntimeAssembly({
      env: {
        ANTHROPIC_API_KEY: "key",
        MUSE_LOCAL_ONLY: "false", // cloud providers require opting out of the default local-only gate
        MUSE_MODEL: "anthropic/claude-test"
      }
    });
    const gemini = createMuseRuntimeAssembly({
      env: {
        GEMINI_API_KEY: "key",
        MUSE_LOCAL_ONLY: "false",
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

  it("parseInteger rejects lenient-garbage env values instead of silently truncating", () => {
    // The footgun: Number.parseInt('60x') === 60, parseInt('16k')
    // === 16 — a typo'd MUSE_* would silently mis-configure a
    // tick interval / num_ctx. The contract is invalid → fallback.
    expect(parseInteger("60x", 1000)).toBe(1000);
    expect(parseInteger("16k", 8192)).toBe(8192);
    expect(parseInteger("10abc", 5)).toBe(5);
    expect(parseInteger("3.9", 1)).toBe(1);
    expect(parseInteger("1e3", 10)).toBe(10);
    expect(parseInteger("0x10", 7)).toBe(7);
    // Plain decimal integers (incl. surrounding whitespace, sign,
    // leading zeros) still parse; non-positive / zero → fallback.
    expect(parseInteger("  5  ", 1)).toBe(5);
    expect(parseInteger("007", 1)).toBe(7);
    expect(parseInteger("+12", 1)).toBe(12);
    expect(parseInteger("-3", 4)).toBe(4);
    expect(parseInteger("0", 9)).toBe(9);
  });

  it("parseNonNegativeInteger honours an explicit 0 (the >=0 integer variant parseInteger lacked)", () => {
    // parseInteger rejects 0 → fallback, so a deliberate MUSE_*=0 (disable /
    // no-budget / unlimited) silently kept the non-zero default. This variant
    // honours 0 while keeping the same strict parsing as parseInteger.
    expect(parseNonNegativeInteger("0", 20)).toBe(0);
    expect(parseNonNegativeInteger("5", 1)).toBe(5);
    expect(parseNonNegativeInteger("-3", 4)).toBe(4); // negatives still fall back
    expect(parseNonNegativeInteger("60x", 7)).toBe(7); // same lenient-garbage rejection
    expect(parseNonNegativeInteger("1e3", 7)).toBe(7);
    expect(parseNonNegativeInteger(undefined, 9)).toBe(9);
    expect(parseNonNegativeInteger("9007199254740993", 1)).toBe(1); // unsafe-integer → fallback
  });

  it("parseInteger rejects values outside the safe-integer range so a double-precision rounding cannot silently mis-configure runtime numbers", () => {
    // 2^53 is the boundary; values >= 2^53 + 1 cannot be represented
    // exactly as a JS Number. Pre-fix, `Number("9007199254740993")`
    // rounded to 9007199254740992 and `Number.isInteger` returned
    // true on the rounded value — the operator asked for one value
    // and silently got another. `Number.isSafeInteger` rejects the
    // entire range so the stated fallback wins.
    expect(parseInteger("9007199254740993", 100), "2^53 + 1 lost precision under Number — must fall back").toBe(100);
    expect(parseInteger("9999999999999999999", 100), "20-digit value rounded to ~1e19 in double — must fall back").toBe(100);
    // 2^53 (9007199254740992) is just past MAX_SAFE_INTEGER; isSafeInteger rejects it.
    expect(parseInteger("9007199254740992", 100)).toBe(100);
    // MAX_SAFE_INTEGER itself (2^53 - 1) is exactly representable — accept it.
    expect(parseInteger("9007199254740991", 100)).toBe(9007199254740991);
    // Just-below-boundary classics still pass.
    expect(parseInteger("1000000", 100)).toBe(1000000);
  });

  it("the float parsers reject lenient-garbage like parseInteger does", () => {
    // Number.parseFloat("0.5x") === 0.5, parseFloat("60s") === 60 —
    // the same unit-slip footgun parseInteger was hardened against.
    // Invalid input must hit the fallback, not silently take effect.
    expect(parsePositiveFloat("0.5x", 9)).toBe(9);
    expect(parsePositiveFloat("60s", 9)).toBe(9);
    expect(parseNonNegativeFloat("1.5kg", 7)).toBe(7);
    expect(parseSloErrorRate("0.5x", 0.1)).toBe(0.1);
    // parseFloat("0x") === 0 would have passed parseNonNegativeFloat's
    // `>= 0` gate and silently returned 0 instead of the fallback.
    expect(parseNonNegativeFloat("0x", 4)).toBe(4);

    // No regression: valid floats (whitespace, sign, leading dot,
    // scientific) still parse exactly as before.
    expect(parsePositiveFloat("2.5", 1)).toBe(2.5);
    expect(parsePositiveFloat("  3  ", 1)).toBe(3);
    expect(parsePositiveFloat(".5", 1)).toBe(0.5);
    expect(parsePositiveFloat("1e3", 1)).toBe(1000);
    expect(parseNonNegativeFloat("+2.0", 9)).toBe(2);
    expect(parseSloErrorRate("0.05", 1)).toBe(0.05);
    expect(parseNonNegativeFloat("0", 9)).toBe(0); // zero is valid, not fallback

    // Empty / whitespace / undefined → fallback (the empty-string
    // trap: Number("")===0 must NOT make parseNonNegativeFloat 0).
    expect(parseNonNegativeFloat("", 7)).toBe(7);
    expect(parseNonNegativeFloat("   ", 7)).toBe(7);
    expect(parsePositiveFloat(undefined, 5)).toBe(5);

    // Range / finiteness guards still apply.
    expect(parseSloErrorRate("1.5", 0.1)).toBe(0.1);
    expect(parseSloErrorRate("-0.1", 0.1)).toBe(0.1);
    expect(parseSloErrorRate("Infinity", 0.1)).toBe(0.1);
    expect(parsePositiveFloat("0", 5)).toBe(5);
    expect(parseNonNegativeFloat("-0.01", 9)).toBe(9);
  });

  it("parseBoolean accepts 'on/off' + falls back on unknown values", () => {
    // Truthy set widened to include `on` for symmetry with the
    // goal-127 RuntimeSettings.getBoolean contract.
    expect(parseBoolean("on", false)).toBe(true);
    expect(parseBoolean("1", false)).toBe(true);
    expect(parseBoolean("True", false)).toBe(true);   // case-insensitive
    expect(parseBoolean("  yes  ", false)).toBe(true); // whitespace trim
    // Falsy set covers the negative twins.
    expect(parseBoolean("off", true)).toBe(false);
    expect(parseBoolean("0", true)).toBe(false);
    expect(parseBoolean("FALSE", true)).toBe(false);
    // Unknown values respect the fallback (was silently `false`
    // pre-goal-128, regardless of caller intent).
    expect(parseBoolean("maybe", true)).toBe(true);
    expect(parseBoolean("Treu", true)).toBe(true);    // typo
    expect(parseBoolean("", true)).toBe(true);        // blank-after-trim
    expect(parseBoolean("garbage", false)).toBe(false);
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

  it("local-only omits default loopback search and configured muse.fetch while preserving non-web loopback tools", () => {
    const tools = createLoopbackMcpToolsFromEnv({
      MUSE_LOCAL_ONLY: "true",
      MUSE_LOOPBACK_FETCH_HOSTS: "api.example.test",
      MUSE_LOOPBACK_FS_ROOTS: "/tmp/workspace",
      MUSE_LOOPBACK_MCP_ENABLED: "true"
    });
    const names = tools.map((tool) => tool.definition.name);
    expect(names).toContain("muse.time.now");
    expect(names).toContain("muse.fs.read");
    expect(names).not.toContain("muse.search.search");
    expect(names.some((name) => name.startsWith("muse.fetch."))).toBe(false);
  });

  it("local-only runtime assembly omits public web tools from the registry before model projection", () => {
    const assembly = createMuseRuntimeAssembly({ env: { MUSE_LOCAL_ONLY: "true" } });
    const names = assembly.toolRegistry.list().map((tool) => tool.definition.name);
    expect(names).not.toContain("muse.web.read");
    expect(names).not.toContain("muse.search.search");
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
    expect(resolveTasksFile({ MUSE_TASKS_FILE: "" }).replaceAll("\\", "/").endsWith("/.muse/tasks.json")).toBe(true);
    expect(resolveTasksFile({ MUSE_TASKS_FILE: "   " }).replaceAll("\\", "/").endsWith("/.muse/tasks.json")).toBe(true);

    // A leading `~` in the override is expanded to the home dir
    // (systemd / Docker / .env / quoted-shell never expand it, and
    // Node doesn't either — without this state lands in ./~/).
    const home = homedir();
    expect(resolveTasksFile({ MUSE_TASKS_FILE: "~/muse-x.json" })).toBe(join(home, "muse-x.json"));
    expect(resolveTasksFile({ MUSE_TASKS_FILE: "~/notes/t.json" })).toBe(join(home, "notes/t.json"));
    expect(resolveNotesDir({ MUSE_NOTES_DIR: "~" })).toBe(home);
    // A `~` NOT at the start, and `~otheruser`, are left literal.
    expect(resolveTasksFile({ MUSE_TASKS_FILE: "/data/~bk/t.json" })).toBe("/data/~bk/t.json");
    expect(resolveTasksFile({ MUSE_TASKS_FILE: "~bob/t.json" })).toBe("~bob/t.json");

    // Default path branch — each resolver picks its own filename.
    expect(resolveTasksFile({}).replaceAll("\\", "/").endsWith("/.muse/tasks.json")).toBe(true);
    expect(resolveNotesDir({}).replaceAll("\\", "/").endsWith("/.muse/notes")).toBe(true);
    expect(resolveRemindersFile({}).replaceAll("\\", "/").endsWith("/.muse/reminders.json")).toBe(true);
    expect(resolveLocalCalendarFile({}).replaceAll("\\", "/").endsWith("/.muse/calendar.json")).toBe(true);
    expect(resolveMessagingCredentialsFile({}).replaceAll("\\", "/").endsWith("/.muse/messaging.json")).toBe(true);
    expect(resolveModelKeysFile({}).replaceAll("\\", "/").endsWith("/.muse/models.json")).toBe(true);
    expect(resolveLineInboxFile({}).replaceAll("\\", "/").endsWith("/.muse/line-inbox.json")).toBe(true);
    expect(resolveTelegramOffsetFile({}).replaceAll("\\", "/").endsWith("/.muse/telegram-offset.json")).toBe(true);
    expect(resolveTelegramInboxFile({}).replaceAll("\\", "/").endsWith("/.muse/telegram-inbox.json")).toBe(true);
    expect(resolveDiscordAfterFile({}).replaceAll("\\", "/").endsWith("/.muse/discord-after.json")).toBe(true);
    expect(resolveDiscordInboxFile({}).replaceAll("\\", "/").endsWith("/.muse/discord-inbox.json")).toBe(true);
    expect(resolveSlackAfterFile({}).replaceAll("\\", "/").endsWith("/.muse/slack-after.json")).toBe(true);
    expect(resolveSlackInboxFile({}).replaceAll("\\", "/").endsWith("/.muse/slack-inbox.json")).toBe(true);
  });

  it("resolveWorkspaceSkillsDir expands a leading `~` like the sibling resolvers — sibling-parity so MUSE_WORKSPACE_SKILLS_DIR=~/work/skills doesn't land literally and make the user's workspace-skills directory invisible to FileSystemSkillLoader", () => {
    const home = homedir();
    expect(resolveWorkspaceSkillsDir({ MUSE_WORKSPACE_SKILLS_DIR: "~/work/skills" })).toBe(join(home, "work/skills"));
    expect(resolveWorkspaceSkillsDir({ MUSE_WORKSPACE_SKILLS_DIR: "~" })).toBe(home);
    expect(resolveWorkspaceSkillsDir({ MUSE_WORKSPACE_SKILLS_DIR: "/abs/skills" })).toBe("/abs/skills");
    expect(resolveWorkspaceSkillsDir({ MUSE_WORKSPACE_SKILLS_DIR: "~bob/skills" })).toBe("~bob/skills");
    expect(resolveWorkspaceSkillsDir({})).toBeUndefined();
    expect(resolveWorkspaceSkillsDir({ MUSE_WORKSPACE_SKILLS_DIR: "" })).toBeUndefined();
    expect(resolveWorkspaceSkillsDir({ MUSE_WORKSPACE_SKILLS_DIR: "   " })).toBeUndefined();
  });

  it("resolveDefaultModel honors MUSE_MODEL when explicitly set", () => {
    expect(resolveDefaultModel({ MUSE_MODEL: "openai/gpt-4o-mini" })).toBe("openai/gpt-4o-mini");
    expect(resolveDefaultModel({ MUSE_DEFAULT_MODEL: "anthropic/claude-haiku-4-5-20251001" }))
      .toBe("anthropic/claude-haiku-4-5-20251001");
  });

  it("resolveDefaultModel: cloud allowed by default (infers from a key), falls back to local; MUSE_LOCAL_ONLY forces local", () => {
    // Default posture is cloud-allowed: a cloud key in env selects that cloud
    // model; with no key it falls back to the local default so a fresh box still
    // boots. MUSE_LOCAL_ONLY=true forces the local model and ignores ambient keys.
    expect(resolveDefaultModel({})).toBe("ollama/gemma4:12b");
    expect(resolveDefaultModel({ GEMINI_API_KEY: "x" })).toBe("gemini/gemini-2.0-flash");
    expect(resolveDefaultModel({ OPENAI_API_KEY: "x" })).toBe("openai/gpt-4o-mini");
    expect(resolveDefaultModel({ MUSE_LOCAL_ONLY: "true", GEMINI_API_KEY: "x" })).toBe("ollama/gemma4:12b");
  });

  it("resolveDefaultModel infers from credentials only when local-only is opted out", () => {
    const off = { MUSE_LOCAL_ONLY: "false" } as const;
    expect(resolveDefaultModel({ ...off, GEMINI_API_KEY: "x" })).toBe("gemini/gemini-2.0-flash");
    expect(resolveDefaultModel({ ...off, GOOGLE_API_KEY: "x" })).toBe("gemini/gemini-2.0-flash");
    expect(resolveDefaultModel({ ...off, OPENAI_API_KEY: "x" })).toBe("openai/gpt-4o-mini");
    expect(resolveDefaultModel({ ...off, ANTHROPIC_API_KEY: "x" })).toBe("anthropic/claude-haiku-4-5-20251001");
    expect(resolveDefaultModel({ ...off, OPENROUTER_API_KEY: "x" }))
      .toBe("openrouter/google/gemini-2.0-flash-001");
  });

  it("resolveDefaultModel always falls back to the local default (never undefined) when nothing is inferable", () => {
    expect(resolveDefaultModel({ MUSE_LOCAL_ONLY: "false" })).toBe("ollama/gemma4:12b");
    expect(resolveDefaultModel({})).toBe("ollama/gemma4:12b");
  });

  it("resolveDefaultModel prefers GEMINI over OPENAI when both keys are present (opted out)", () => {
    expect(resolveDefaultModel({
      GEMINI_API_KEY: "g",
      MUSE_LOCAL_ONLY: "false",
      OPENAI_API_KEY: "o"
    })).toBe("gemini/gemini-2.0-flash");
  });

  it("createMuseRuntimeAssembly wires agentRuntime when only an API key is in env (no MUSE_MODEL)", () => {
    // A cloud key infers a cloud default model, so this opts out of local-only.
    const assembly = createMuseRuntimeAssembly({ env: { GEMINI_API_KEY: "fake-key-for-test", MUSE_LOCAL_ONLY: "false" } });
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

    // An empty / whitespace-only env value is treated as "unset"
    // for a key we just resolved from the file — otherwise a
    // shell that pre-clears OLLAMA_BASE_URL= silently shadows the
    // configured models.json with "" and the runtime falls back
    // to localhost.
    const mergedEmptyEnv = mergeModelKeysFromFile({
      MUSE_MODEL_KEYS_FILE: file,
      OLLAMA_BASE_URL: "",
      OPENAI_API_KEY: "   "
    });
    expect(mergedEmptyEnv.OLLAMA_BASE_URL).toBe("http://localhost:11434");
    expect(mergedEmptyEnv.OPENAI_API_KEY).toBe("from-file-openai");
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

  it("freezes local-only override reflection before a nonempty model merge and never enumerates a Gmail-poison source", async () => {
    const { writeFileSync } = await import("node:fs");
    const { isLocalOnlyEnabled } = await import("@muse/model");
    const root = mkdtempSync(join(tmpdir(), "muse-local-model-overlay-"));
    const file = join(root, "models.json");
    writeFileSync(file, JSON.stringify({ providers: { ollama: { token: "http://127.0.0.1:11434" } } }), "utf8");

    const poison = (sourceLocalOnly: string): Record<string, string | undefined> => new Proxy({
      HOME: root,
      MUSE_GMAIL_TOKEN: "must-not-read",
      MUSE_LOCAL_ONLY: sourceLocalOnly,
      MUSE_MODEL_KEYS_FILE: file,
      MUSE_WEB_EGRESS: "true"
    }, {
      get(target, property, receiver) {
        if (property === "MUSE_GMAIL_TOKEN") throw new Error("Gmail get");
        return Reflect.get(target, property, receiver);
      },
      getOwnPropertyDescriptor(target, property) {
        if (property === "MUSE_GMAIL_TOKEN") throw new Error("Gmail descriptor");
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
      has(target, property) {
        if (property === "MUSE_GMAIL_TOKEN") throw new Error("Gmail has");
        return Reflect.has(target, property);
      },
      ownKeys() {
        throw new Error("source ownKeys");
      }
    });

    const forcedLocal = mergeModelKeysFromFile(poison("false"), { localOnlyOverride: true });
    expect(forcedLocal.MUSE_LOCAL_ONLY).toBe("true");
    expect("MUSE_LOCAL_ONLY" in forcedLocal).toBe(true);
    expect(Object.getOwnPropertyDescriptor(forcedLocal, "MUSE_LOCAL_ONLY")?.value).toBe("true");
    expect(Object.keys(forcedLocal)).toContain("MUSE_LOCAL_ONLY");
    expect(forcedLocal.MUSE_GMAIL_TOKEN).toBeUndefined();
    expect("MUSE_GMAIL_TOKEN" in forcedLocal).toBe(false);
    expect(Object.getOwnPropertyDescriptor(forcedLocal, "MUSE_GMAIL_TOKEN")).toBeUndefined();
    expect(forcedLocal.MUSE_WEB_EGRESS).toBe("true");
    expect(isLocalOnlyEnabled(forcedLocal)).toBe(true);

    const forcedNormal = mergeModelKeysFromFile(poison("true"), { localOnlyOverride: false });
    expect(forcedNormal.MUSE_LOCAL_ONLY).toBe("false");
    expect(isLocalOnlyEnabled(forcedNormal)).toBe(false);
    expect(forcedNormal.OLLAMA_BASE_URL).toBe("http://127.0.0.1:11434");
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
