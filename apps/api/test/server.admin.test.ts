import { describe, expect, it } from "vitest";
import { InMemoryTaskMemoryStore } from "@muse/memory";
import { InMemoryAgentMetrics } from "@muse/observability";
import {
  InMemoryAdminOperationsStore,
  InMemoryAgentRunHistoryStore,
  InMemorySessionTagStore
} from "@muse/runtime-state";
import {
  InMemoryScheduledJobExecutionStore,
  InMemoryScheduledJobStore
} from "@muse/scheduler";
import { buildServer } from "../src/server.js";
import { createAuthService } from "./helpers/test-auth.js";

describe("api server: admin / ops / settings / memory", () => {
  it("persists Reactor-compatible session tags through the configured store", async () => {
    const historyStore = new InMemoryAgentRunHistoryStore();
    const sessionTagStore = new InMemorySessionTagStore({
      idFactory: () => "session-tag-1",
      now: () => Date.parse("2026-05-06T00:00:00.000Z")
    });
    historyStore.createRun({
      id: "tagged-run",
      input: "compare options",
      model: "provider/model",
      provider: "provider",
      userId: "example-user"
    });
    const server = buildServer({ historyStore, logger: false, sessionTagStore });

    const created = await server.inject({
      method: "POST",
      payload: {
        comment: "ready for review",
        label: "reviewed"
      },
      url: "/api/admin/sessions/tagged-run/tags"
    });
    const detail = await server.inject({
      method: "GET",
      url: "/api/admin/sessions/tagged-run"
    });
    const storedAfterCreate = await sessionTagStore.listBySession("tagged-run");
    const deletedRun = await server.inject({
      method: "DELETE",
      url: "/api/admin/sessions/tagged-run"
    });

    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({
      comment: "ready for review",
      id: "session-tag-1",
      label: "reviewed",
      sessionId: "tagged-run"
    });
    expect(detail.json()).toMatchObject({
      run: { id: "tagged-run" },
      tags: [{ id: "session-tag-1", label: "reviewed" }]
    });
    expect(storedAfterCreate).toMatchObject([{ id: "session-tag-1", label: "reviewed" }]);
    expect(deletedRun.statusCode).toBe(204);
    expect(await sessionTagStore.listBySession("tagged-run")).toHaveLength(0);
  });

  it("exposes admin summary, run history, and scheduler state behind admin auth", async () => {
    const authService = createAuthService();
    const registered = authService.register({
      email: "first_account",
      name: "First",
      password: "password-1"
    });
    const historyStore = new InMemoryAgentRunHistoryStore({ idFactory: () => "message-1" });
    const run = historyStore.createRun({
      id: "run-1",
      input: "hello",
      model: "gpt-4o",
      provider: "openai",
      userId: "user-1"
    });
    historyStore.appendMessage({
      content: "hello",
      role: "user",
      runId: run.id
    });
    const schedulerStore = new InMemoryScheduledJobStore({ idFactory: () => "job-1" });
    const schedulerExecutionStore = new InMemoryScheduledJobExecutionStore({ idFactory: () => "exec-1" });
    const job = schedulerStore.save({
      agentPrompt: "Run",
      cronExpression: "0 * * * * *",
      jobType: "agent",
      name: "Agent job"
    });
    schedulerExecutionStore.save({
      jobId: job.id,
      jobName: job.name,
      result: "ok",
      status: "success"
    });
    const server = buildServer({
      authService,
      historyStore,
      logger: false,
      requireAuth: true,
      scheduler: {
        executionStore: schedulerExecutionStore,
        store: schedulerStore
      }
    });
    const headers = { authorization: `Bearer ${registered.token}` };

    const summary = await server.inject({ headers, method: "GET", url: "/admin/summary" });
    const runDetail = await server.inject({ headers, method: "GET", url: "/admin/runs/run-1" });
    const schedulerJobs = await server.inject({ headers, method: "GET", url: "/admin/scheduler/jobs" });
    const executions = await server.inject({
      headers,
      method: "GET",
      url: "/admin/scheduler/jobs/job-1/executions"
    });

    expect(summary.statusCode).toBe(200);
    expect(summary.json()).toMatchObject({
      authEnabled: true,
      recentRuns: [
        {
          id: "run-1",
          inputPreview: "hello",
          model: "gpt-4o",
          provider: "openai",
          status: "queued"
        }
      ],
      schedulerJobCount: 1
    });
    expect(runDetail.json()).toMatchObject({ run: { id: "run-1" }, messages: [{ content: "hello" }] });
    expect(schedulerJobs.json()).toMatchObject({ items: [{ id: "job-1" }], total: 1 });
    expect(executions.json()).toMatchObject({ items: [{ jobId: "job-1" }], total: 1 });
  });

  it("matches Reactor ops dashboard authorization and stateful summary behavior", async () => {
    const authService = createAuthService();
    const admin = authService.register({
      email: "ops_admin",
      name: "Ops Admin",
      password: "password-1"
    });
    const user = authService.register({
      email: "ops_user",
      name: "Ops User",
      password: "password-1"
    });
    const metrics = new InMemoryAgentMetrics();
    const schedulerStore = new InMemoryScheduledJobStore({ idFactory: () => "ops-job-1" });
    const schedulerExecutionStore = new InMemoryScheduledJobExecutionStore({ idFactory: () => "ops-exec-1" });

    const job = schedulerStore.save({
      agentPrompt: "Summarize incidents",
      cronExpression: "0 * * * * *",
      jobType: "agent",
      lastStatus: "failed",
      name: "Ops agent job"
    });
    schedulerExecutionStore.save({
      completedAt: new Date("2026-05-06T00:00:01.000Z"),
      durationMs: 1000,
      jobId: job.id,
      jobName: job.name,
      result: "failed: timeout",
      startedAt: new Date("2026-05-06T00:00:00.000Z"),
      status: "failed"
    });
    metrics.recordAgentRun({
      durationMs: 1200,
      metadata: {
        answerMode: "operational",
        channel: "slack",
        grounded: true,
        scheduled: true,
        toolFamily: "mcp"
      },
      model: "provider/model",
      runId: "run-ops",
      status: "completed"
    });
    metrics.recordOutputGuardAction("OutputGuard", "modified", "masked", { channel: "slack" });
    metrics.recordGuardRejection("InjectionDetection", "prompt_injection", {
      channel: "api",
      queryCluster: "security",
      queryLabel: "Prompt injection"
    });

    const server = buildServer({
      admin: { observability: { metrics } },
      authService,
      logger: false,
      requireAuth: true,
      scheduler: {
        executionStore: schedulerExecutionStore,
        store: schedulerStore
      }
    });
    const forbidden = await server.inject({
      headers: { authorization: `Bearer ${user.token}` },
      method: "GET",
      url: "/api/ops/dashboard"
    });
    const dashboard = await server.inject({
      headers: { authorization: `Bearer ${admin.token}` },
      method: "GET",
      url: "/api/ops/dashboard"
    });

    expect(forbidden.statusCode).toBe(403);
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.json()).not.toHaveProperty("employeeValue");
    expect(dashboard.json()).toMatchObject({
      recentSchedulerExecutions: [{
        failureReason: "timeout",
        jobId: "ops-job-1",
        resultPreview: "failed: timeout",
        status: "FAILED"
      }],
      recentTrustEvents: [
        { queryCluster: "security", reason: "prompt_injection", type: "guard_rejection" },
        { action: "modified", type: "output_guard_action" }
      ],
      responseTrust: {
        boundaryFailures: 1,
        outputGuardModified: 1,
        outputGuardRejected: 0,
        unverifiedResponses: 0
      },
      scheduler: {
        agentJobs: 1,
        attentionBacklog: 1,
        enabledJobs: 1,
        failedJobs: 1,
        runningJobs: 0,
        totalJobs: 1
      }
    });
  });

  it("matches Reactor platform alert evaluation and resolve semantics", async () => {
    const authService = createAuthService();
    const admin = authService.register({
      email: "platform_admin",
      name: "Platform Admin",
      password: "password-1"
    });
    const member = authService.register({
      email: "platform_member",
      name: "Platform Member",
      password: "password-1"
    });
    const operations = new InMemoryAdminOperationsStore({
      now: () => new Date("2026-01-01T00:00:00.000Z")
    });
    await operations.createAlert({
      id: "alert-1",
      message: "Cost threshold crossed",
      severity: "critical",
      target: "tenant-1"
    });
    const server = buildServer({
      admin: { operations },
      authService,
      logger: false,
      requireAuth: true
    });
    const adminHeaders = { authorization: `Bearer ${admin.token}` };
    const memberHeaders = { authorization: `Bearer ${member.token}` };

    const denied = await server.inject({
      headers: memberHeaders,
      method: "POST",
      url: "/api/admin/platform/alerts/evaluate"
    });
    const activeBefore = await server.inject({
      headers: adminHeaders,
      method: "GET",
      url: "/api/admin/platform/alerts"
    });
    const evaluated = await server.inject({
      headers: adminHeaders,
      method: "POST",
      url: "/api/admin/platform/alerts/evaluate"
    });
    const resolved = await server.inject({
      headers: adminHeaders,
      method: "POST",
      url: "/api/admin/platform/alerts/alert-1/resolve"
    });
    const missingResolved = await server.inject({
      headers: adminHeaders,
      method: "POST",
      url: "/api/admin/platform/alerts/missing-alert/resolve"
    });
    const activeAfter = await server.inject({
      headers: adminHeaders,
      method: "GET",
      url: "/api/admin/platform/alerts"
    });

    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({
      error: "관리자 권한이 필요합니다",
      timestamp: expect.any(String)
    });
    expect(denied.json()).not.toHaveProperty("code");
    expect(activeBefore.json()).toMatchObject([{ id: "alert-1", status: "open" }]);
    expect(evaluated.json()).toEqual({ status: "evaluation complete" });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.body).toBe("");
    expect(missingResolved.statusCode).toBe(200);
    expect(missingResolved.body).toBe("");
    expect(activeAfter.json()).toEqual([]);
    expect(await operations.listAlerts()).toMatchObject([{ id: "alert-1", status: "resolved" }]);
  });

  it("exposes admin metrics, cache, and circuit breaker operations", async () => {
    const authService = createAuthService();
    const registered = authService.register({
      email: "first_account",
      name: "First",
      password: "password-1"
    });
    let breakerState = "open";
    let allInvalidated = false;
    const server = buildServer({
      admin: {
        cache: {
          metrics: {
            snapshot: () => ({ exactHits: 1, misses: 2 })
          },
          responseCache: {
            invalidate: (key) => key === "cache-key",
            invalidateAll: () => {
              allInvalidated = true;
            },
            invalidateByPattern: (pattern) => pattern.length,
            size: () => 3
          }
        },
        observability: {
          metrics: {
            recordedEvents: () => [{ type: "agent_run" }]
          },
          traceSink: {
            list: () => [{ name: "muse.model.generate", runId: "run-1" }]
          },
          tracer: {
            recordedSpans: () => [{ name: "muse.agent.run" }]
          }
        },
        resilience: {
          circuitBreakerRegistry: {
            getIfExists: (name) => name === "model.generate"
              ? {
                  metrics: () => ({ failureCount: 2 }),
                  reset: () => {
                    breakerState = "closed";
                  },
                  state: () => breakerState
                }
              : undefined,
            names: () => ["model.generate"],
            resetAll: () => {
              breakerState = "closed";
            }
          }
        }
      },
      authService,
      logger: false,
      requireAuth: true
    });
    const headers = { authorization: `Bearer ${registered.token}` };

    const metrics = await server.inject({ headers, method: "GET", url: "/admin/metrics" });
    const cache = await server.inject({ headers, method: "GET", url: "/admin/cache" });
    const cacheKey = await server.inject({ headers, method: "DELETE", url: "/admin/cache/cache-key" });
    const cachePattern = await server.inject({
      headers,
      method: "POST",
      payload: { pattern: "prefix*" },
      url: "/admin/cache/invalidate-pattern"
    });
    const cacheAll = await server.inject({ headers, method: "DELETE", url: "/admin/cache" });
    const breakers = await server.inject({
      headers,
      method: "GET",
      url: "/admin/resilience/circuit-breakers"
    });
    const reset = await server.inject({
      headers,
      method: "POST",
      url: "/admin/resilience/circuit-breakers/model.generate/reset"
    });

    expect(metrics.json()).toMatchObject({
      events: [{ type: "agent_run" }],
      spans: [{ name: "muse.agent.run" }],
      traceEvents: [{ name: "muse.model.generate", runId: "run-1" }]
    });
    expect(cache.json()).toEqual({ metrics: { exactHits: 1, misses: 2 }, size: 3 });
    expect(cacheKey.json()).toEqual({ invalidated: true, key: "cache-key" });
    expect(cachePattern.json()).toEqual({ invalidated: 7, pattern: "prefix*" });
    expect(cacheAll.json()).toEqual({ invalidated: true });
    expect(allInvalidated).toBe(true);
    expect(breakers.json()).toMatchObject([{ name: "model.generate", state: "open" }]);
    expect(reset.json()).toEqual({ name: "model.generate", state: "closed" });
  });

  it("exposes tenant, alert, cost, and SLO admin operations", async () => {
    const authService = createAuthService();
    const registered = authService.register({
      email: "first_account",
      name: "First",
      password: "password-1"
    });
    const operations = new InMemoryAdminOperationsStore({
      idFactory: (kind) => `${kind}-1`,
      now: () => new Date("2026-01-01T00:00:00.000Z")
    });
    const server = buildServer({
      admin: { operations },
      authService,
      logger: false,
      requireAuth: true
    });
    const headers = { authorization: `Bearer ${registered.token}` };

    const alert = await server.inject({
      headers,
      method: "POST",
      payload: {
        message: "High spend",
        severity: "critical",
        target: "tenant-1"
      },
      url: "/admin/alerts"
    });
    const slo = await server.inject({
      headers,
      method: "PUT",
      payload: {
        actual: 94,
        name: "Availability",
        target: 99.9,
        window: "30d"
      },
      url: "/admin/slos/availability"
    });
    const cost = await server.inject({
      headers,
      method: "POST",
      payload: {
        costUsd: "1.25",
        model: "provider/model"
      },
      url: "/admin/costs/usage"
    });
    const summary = await server.inject({
      headers,
      method: "GET",
      url: "/admin/costs/summary"
    });

    expect(alert.statusCode).toBe(201);
    expect(slo.json()).toMatchObject({ id: "availability", status: "violated" });
    expect(cost.json()).toEqual({
      byModel: { "provider/model": "1.25000000" },
      totalCostUsd: "1.25000000"
    });
    expect(summary.json()).toEqual(cost.json());
  });

  it("matches Reactor admin policy, settings, and dashboard contracts", async () => {
    const authService = createAuthService();
    const admin = authService.register({
      email: "first_account",
      name: "First",
      password: "password-1"
    });
    const server = buildServer({ authService, logger: false, requireAuth: true });
    const headers = { authorization: `Bearer ${admin.token}` };

    const runtimeSet = await server.inject({
      headers,
      method: "PUT",
      payload: { category: "llm", type: "STRING", updatedBy: "spoofed-user", value: "provider/model" },
      url: "/api/admin/settings/model.default"
    });
    const runtimeGet = await server.inject({
      headers,
      method: "GET",
      url: "/api/admin/settings/model.default"
    });
    const missingRuntimeSetting = await server.inject({
      headers,
      method: "GET",
      url: "/api/admin/settings/missing.setting"
    });
    const invalidRuntimeSetting = await server.inject({
      headers,
      method: "PUT",
      payload: {},
      url: "/api/admin/settings/missing.value"
    });
    const runtimeRefresh = await server.inject({ headers, method: "POST", url: "/api/admin/settings/refresh" });
    const capabilities = await server.inject({ headers, method: "GET", url: "/api/admin/capabilities" });
    const dashboard = await server.inject({ headers, method: "GET", url: "/api/ops/dashboard" });
    const ragInitial = await server.inject({ headers, method: "GET", url: "/api/rag-ingestion/policy" });
    const blockedRagCandidates = await server.inject({ method: "GET", url: "/api/rag-ingestion/candidates" });
    const missingCandidateApprove = await server.inject({
      headers,
      method: "POST",
      payload: { comment: "approve" },
      url: "/api/rag-ingestion/candidates/missing/approve"
    });
    const ragInvalidUpdate = await server.inject({
      headers,
      method: "PUT",
      payload: { allowedChannels: Array.from({ length: 301 }, (_, index) => `channel-${index}`) },
      url: "/api/rag-ingestion/policy"
    });
    const ragUpdate = await server.inject({
      headers,
      method: "PUT",
      payload: { allowedChannels: ["Slack"], blockedPatterns: ["secret"], enabled: true },
      url: "/api/rag-ingestion/policy"
    });
    const ragAfterUpdate = await server.inject({ headers, method: "GET", url: "/api/rag-ingestion/policy" });
    const ragResetByOmission = await server.inject({
      headers,
      method: "PUT",
      payload: { enabled: true },
      url: "/api/rag-ingestion/policy"
    });
    const runtimeDelete = await server.inject({
      headers,
      method: "DELETE",
      url: "/api/admin/settings/model.default"
    });
    const ragDelete = await server.inject({ headers, method: "DELETE", url: "/api/rag-ingestion/policy" });
    const ragAfterDelete = await server.inject({ headers, method: "GET", url: "/api/rag-ingestion/policy" });

    expect(runtimeSet.json()).toEqual({ key: "model.default", status: "updated", value: "provider/model" });
    expect(runtimeGet.json()).toMatchObject({
      key: "model.default",
      type: "STRING",
      updatedBy: admin.user.id,
      value: "provider/model"
    });
    expect(missingRuntimeSetting.statusCode).toBe(404);
    expect(missingRuntimeSetting.json()).toMatchObject({
      error: "설정을 찾을 수 없습니다: missing.setting",
      timestamp: expect.any(String)
    });
    expect(missingRuntimeSetting.json()).not.toHaveProperty("code");
    expect(invalidRuntimeSetting.statusCode).toBe(400);
    expect(invalidRuntimeSetting.json()).toMatchObject({
      error: "요청 형식이 올바르지 않습니다",
      timestamp: expect.any(String)
    });
    expect(invalidRuntimeSetting.json()).not.toHaveProperty("code");
    expect(runtimeRefresh.json()).toEqual({ status: "cache_refreshed" });
    const capabilitiesBody = capabilities.json();
    expect(capabilitiesBody).toMatchObject({ source: "request-mappings" });
    expect(typeof capabilitiesBody.generatedAt).toBe("number");
    expect(capabilitiesBody.paths).toEqual([...capabilitiesBody.paths].sort());
    expect(capabilitiesBody.paths).toEqual(expect.arrayContaining([
      "/api/admin/capabilities",
      "/api/admin/doctor",
      "/api/admin/platform/health",
      "/api/admin/settings",
      "/api/chat",
      "/api/mcp/servers/{name}/tools",
      "/api/rag-ingestion/policy",
      "/api/scheduler/jobs"
    ]));
    expect(capabilitiesBody.paths).not.toContain("/api/prompt-lab/auto-optimize");
    expect(capabilitiesBody.paths).not.toContain("/api/feedback");
    expect(capabilitiesBody.paths).not.toContain("/api/admin/agent-eval/cases");
    expect(capabilitiesBody.paths).not.toContain("/health");
    expect(capabilitiesBody.paths).not.toContain("/admin/summary");
    expect(capabilitiesBody.paths).not.toContain("/api/admin/slack/channels/faq/{channelId}/dry-run");
    expect(capabilitiesBody.paths).not.toContain("/api/slack/commands");
    expect(capabilitiesBody.paths).not.toContain("/api/approvals");
    expect(capabilitiesBody.paths).not.toContain("/api/admin/audits");
    expect(dashboard.json()).toMatchObject({
      mcp: { total: 0 },
      scheduler: { totalJobs: 0 }
    });
    expect(ragInitial.json()).toMatchObject({ stored: null });
    expect(blockedRagCandidates.statusCode).toBe(401);
    expect(missingCandidateApprove.statusCode).toBe(404);
    expect(ragInvalidUpdate.statusCode).toBe(400);
    expect(ragUpdate.json()).toMatchObject({ allowedChannels: ["slack"], blockedPatterns: ["secret"], enabled: true });
    expect(typeof ragUpdate.json().createdAt).toBe("number");
    expect(ragAfterUpdate.json()).toMatchObject({ stored: { enabled: true } });
    expect(ragResetByOmission.json()).toMatchObject({
      allowedChannels: [],
      blockedPatterns: [],
      enabled: true,
      minQueryChars: 10,
      minResponseChars: 20,
      requireReview: true
    });
    expect(runtimeDelete.statusCode).toBe(204);
    expect(ragDelete.statusCode).toBe(204);
    expect(ragAfterDelete.json()).toMatchObject({
      configEnabled: false,
      effective: {
        allowedChannels: [],
        blockedPatterns: [],
        enabled: false,
        minQueryChars: 10,
        minResponseChars: 20,
        requireReview: true
      },
      stored: null
    });
  });

  it("enforces Reactor-compatible user memory ownership and proactive channel DTOs", async () => {
    const authService = createAuthService();
    const owner = authService.register({
      email: "owner_account",
      name: "Owner",
      password: "password-1"
    });
    const other = authService.register({
      email: "other_account",
      name: "Other",
      password: "password-1"
    });
    const server = buildServer({
      authService,
      logger: false,
      requireAuth: true
    });
    const ownerHeaders = { authorization: `Bearer ${owner.token}` };
    const otherHeaders = { authorization: `Bearer ${other.token}` };

    const update = await server.inject({
      headers: ownerHeaders,
      method: "PUT",
      payload: { key: "tone", value: "concise" },
      url: `/api/user-memory/${owner.user.id}/preferences`
    });
    const memory = await server.inject({
      headers: ownerHeaders,
      method: "GET",
      url: `/api/user-memory/${owner.user.id}`
    });
    const forbidden = await server.inject({
      headers: otherHeaders,
      method: "GET",
      url: `/api/user-memory/${owner.user.id}`
    });
    const adminModels = await server.inject({
      headers: ownerHeaders,
      method: "GET",
      url: "/api/admin/models"
    });

    expect(update.json()).toEqual({ updated: true });
    expect(memory.json()).toMatchObject({
      facts: {},
      preferences: { tone: "concise" },
      recentTopics: []
    });
    expect(forbidden.statusCode).toBe(403);
    expect(adminModels.json()).toEqual(expect.arrayContaining([
      {
        inputPricePerMillionTokens: 0.15,
        isDefault: false,
        name: "gemini-3-flash",
        outputPricePerMillionTokens: 0.6
      }
    ]));
  });

  it("matches Reactor task memory maintenance availability and purge semantics", async () => {
    const authService = createAuthService();
    const registered = authService.register({
      email: "task_memory_admin",
      name: "Task Memory Admin",
      password: "password-1"
    });
    const headers = { authorization: `Bearer ${registered.token}` };
    const unavailableServer = buildServer({
      authService,
      logger: false,
      requireAuth: true
    });
    const unavailable = await unavailableServer.inject({
      headers,
      method: "POST",
      url: "/api/admin/task-memory/maintenance/purge-expired"
    });
    const taskMemory = new InMemoryTaskMemoryStore();
    await taskMemory.save({
      goal: "Old completed task",
      sessionId: "session-1",
      status: "completed",
      taskId: "task-old",
      updatedAt: new Date("2026-01-01T00:00:00.000Z")
    });
    const server = buildServer({
      authService,
      logger: false,
      requireAuth: true,
      taskMemoryMaintenance: taskMemory
    });
    const purgeTerminal = await server.inject({
      headers,
      method: "POST",
      url: "/api/admin/task-memory/maintenance/purge-terminal?olderThanDays=30"
    });
    const invalidRetention = await server.inject({
      headers,
      method: "POST",
      url: "/api/admin/task-memory/maintenance/purge-terminal?olderThanDays=0"
    });

    expect(unavailable.statusCode).toBe(400);
    expect(unavailable.json()).toMatchObject({
      error: "TaskMemoryMaintenance 미등록 — task memory 유지보수를 사용할 수 없습니다",
      timestamp: expect.any(String)
    });
    expect(unavailable.json()).not.toHaveProperty("code");
    expect(invalidRetention.statusCode).toBe(400);
    expect(invalidRetention.json()).toMatchObject({
      error: "olderThanDays는 1 이상이어야 합니다",
      timestamp: expect.any(String)
    });
    expect(invalidRetention.json()).not.toHaveProperty("code");
    expect(purgeTerminal.statusCode).toBe(200);
    expect(purgeTerminal.json()).toMatchObject({ deleted: 1 });
  });
});
