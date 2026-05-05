import { describe, expect, it } from "vitest";
import { createAgentRuntime } from "@muse/agent-core";
import {
  AuthService,
  DefaultAuthProvider,
  InMemoryTokenRevocationStore,
  InMemoryUserStore,
  JwtTokenProvider
} from "@muse/auth";
import {
  InMemoryMcpSecurityPolicyStore,
  InMemoryMcpServerStore,
  McpManager,
  McpSecurityPolicyProvider,
  type McpConnection
} from "@muse/mcp";
import type { ModelProvider } from "@muse/model";
import { InMemoryAgentRunHistoryStore } from "@muse/runtime-state";
import {
  DynamicSchedulerService,
  InMemoryScheduledJobExecutionStore,
  InMemoryScheduledJobStore,
  ScheduledJobDispatcher,
  ScheduledMcpToolInvoker
} from "@muse/scheduler";
import { buildServer } from "../src/server.js";

describe("api server", () => {
  it("reports health", async () => {
    const server = buildServer({ logger: false });

    const response = await server.inject({
      method: "GET",
      url: "/health"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      service: "muse-api",
      status: "ok"
    });
  });

  it("manages agent specs and resolves matching requests", async () => {
    const server = buildServer({ logger: false });

    const created = await server.inject({
      method: "POST",
      payload: {
        keywords: ["research", "sources"],
        name: "researcher",
        systemPrompt: "Use verifiable sources.",
        toolNames: ["web_search"]
      },
      url: "/agent-specs"
    });
    const resolved = await server.inject({
      method: "POST",
      payload: {
        text: "Research this with sources"
      },
      url: "/agent-specs/resolve"
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      name: "researcher",
      systemPrompt: "Use verifiable sources.",
      toolNames: ["web_search"]
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json()).toEqual({
      resolution: {
        confidence: 1,
        matchedKeywords: ["research", "sources"],
        name: "researcher",
        toolNames: ["web_search"]
      }
    });
  });

  it("manages runtime settings", async () => {
    const server = buildServer({ logger: false });

    const saved = await server.inject({
      method: "PUT",
      payload: {
        category: "guard",
        type: "number",
        updatedBy: "operator",
        value: "20"
      },
      url: "/settings/guard.rateLimit"
    });
    const fetched = await server.inject({
      method: "GET",
      url: "/settings/guard.rateLimit"
    });
    const listed = await server.inject({
      method: "GET",
      url: "/settings"
    });

    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({
      category: "guard",
      key: "guard.rateLimit",
      type: "number",
      updatedBy: "operator",
      value: "20"
    });
    expect(fetched.json()).toMatchObject({
      key: "guard.rateLimit",
      value: "20"
    });
    expect(listed.json()).toHaveLength(1);
  });

  it("returns typed errors for invalid management payloads", async () => {
    const server = buildServer({ logger: false });

    const invalidSpec = await server.inject({
      method: "POST",
      payload: {},
      url: "/agent-specs"
    });
    const invalidSetting = await server.inject({
      method: "PUT",
      payload: {},
      url: "/settings/model.default"
    });

    expect(invalidSpec.statusCode).toBe(400);
    expect(invalidSpec.json()).toMatchObject({ code: "INVALID_AGENT_SPEC" });
    expect(invalidSetting.statusCode).toBe(400);
    expect(invalidSetting.json()).toMatchObject({ code: "INVALID_RUNTIME_SETTING" });
  });

  it("registers, authenticates, protects, and revokes auth sessions", async () => {
    const authService = createAuthService();
    const server = buildServer({ authService, logger: false, requireAuth: true });

    const registered = await server.inject({
      method: "POST",
      payload: {
        email: "first_account",
        name: "First",
        password: "password-1"
      },
      url: "/auth/register"
    });
    const token = registered.json().token as string;
    const protectedWithoutToken = await server.inject({
      method: "GET",
      url: "/agent-specs"
    });
    const me = await server.inject({
      headers: { authorization: `Bearer ${token}` },
      method: "GET",
      url: "/auth/me"
    });
    const logout = await server.inject({
      headers: { authorization: `Bearer ${token}` },
      method: "POST",
      url: "/auth/logout"
    });
    const afterLogout = await server.inject({
      headers: { authorization: `Bearer ${token}` },
      method: "GET",
      url: "/auth/me"
    });

    expect(registered.statusCode).toBe(201);
    expect(registered.json().user).toMatchObject({ role: "admin" });
    expect(protectedWithoutToken.statusCode).toBe(401);
    expect(me.statusCode).toBe(200);
    expect(me.json().identity).toMatchObject({ email: "first_account", role: "admin" });
    expect(logout.json()).toEqual({ revoked: true });
    expect(afterLogout.statusCode).toBe(401);
  });

  it("rate limits failed auth attempts", async () => {
    const authService = createAuthService();
    authService.register({
      email: "first_account",
      name: "First",
      password: "password-1"
    });
    const server = buildServer({ authService, logger: false });

    await server.inject({
      method: "POST",
      payload: { email: "first_account", password: "wrong" },
      url: "/auth/login"
    });

    for (let index = 0; index < 9; index += 1) {
      await server.inject({
        method: "POST",
        payload: { email: "first_account", password: "wrong" },
        url: "/auth/login"
      });
    }

    const blocked = await server.inject({
      method: "POST",
      payload: { email: "first_account", password: "wrong" },
      url: "/auth/login"
    });

    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toMatchObject({ code: "AUTH_RATE_LIMITED" });
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
    expect(summary.json()).toMatchObject({ authEnabled: true, schedulerJobCount: 1 });
    expect(runDetail.json()).toMatchObject({ run: { id: "run-1" }, messages: [{ content: "hello" }] });
    expect(schedulerJobs.json()).toHaveLength(1);
    expect(executions.json()).toHaveLength(1);
  });

  it("runs chat through AgentRuntime behind auth and exposes SSE-compatible output", async () => {
    const authService = createAuthService();
    const registered = authService.register({
      email: "first_account",
      name: "First",
      password: "password-1"
    });
    const historyStore = new InMemoryAgentRunHistoryStore();
    const agentRuntime = createAgentRuntime({
      historyStore,
      modelProvider: createProvider("Runtime answer")
    });
    const server = buildServer({
      agentRuntime,
      authService,
      defaultModel: "provider/model",
      historyStore,
      logger: false,
      requireAuth: true
    });
    const headers = { authorization: `Bearer ${registered.token}` };

    const blocked = await server.inject({
      method: "POST",
      payload: { message: "Hello" },
      url: "/api/chat"
    });
    const chat = await server.inject({
      headers,
      method: "POST",
      payload: {
        message: "Hello",
        metadata: { tenantId: "tenant-1", userId: "user-1" },
        runId: "run-chat"
      },
      url: "/api/chat"
    });
    const stream = await server.inject({
      headers,
      method: "POST",
      payload: { message: "Hello", runId: "run-stream" },
      url: "/api/chat/stream"
    });

    expect(blocked.statusCode).toBe(401);
    expect(chat.statusCode).toBe(200);
    expect(chat.json()).toMatchObject({
      model: "provider/model",
      response: "Runtime answer",
      runId: "run-chat"
    });
    expect(historyStore.findRun("run-chat")).toMatchObject({
      input: "Hello",
      status: "completed",
      userId: "user-1"
    });
    expect(stream.statusCode).toBe(200);
    expect(stream.headers["content-type"]).toContain("text/event-stream");
    expect(stream.body).toContain("event: message");
    expect(stream.body).toContain("event: done");
  });

  it("manages scheduler jobs through the service API and records executions", async () => {
    const authService = createAuthService();
    const registered = authService.register({
      email: "first_account",
      name: "First",
      password: "password-1"
    });
    const schedulerStore = new InMemoryScheduledJobStore({ idFactory: () => "job-1" });
    let executionIndex = 0;
    const schedulerExecutionStore = new InMemoryScheduledJobExecutionStore({
      idFactory: () => `exec-${++executionIndex}`
    });
    const schedulerService = new DynamicSchedulerService({
      dispatcher: new ScheduledJobDispatcher({
        agentExecutor: { execute: async (job) => `executed:${job.agentPrompt}` },
        mcpInvoker: createUnusedMcpInvoker()
      }),
      executionStore: schedulerExecutionStore,
      store: schedulerStore
    });
    const server = buildServer({
      authService,
      logger: false,
      requireAuth: true,
      scheduler: {
        executionStore: schedulerExecutionStore,
        service: schedulerService,
        store: schedulerStore
      }
    });
    const headers = { authorization: `Bearer ${registered.token}` };

    const invalid = await server.inject({
      headers,
      method: "POST",
      payload: {
        cronExpression: "0 * * * * *",
        jobType: "agent",
        name: "Missing prompt"
      },
      url: "/api/scheduler/jobs"
    });
    const created = await server.inject({
      headers,
      method: "POST",
      payload: {
        agentPrompt: "Run",
        cronExpression: "0 * * * * *",
        enabled: true,
        jobType: "agent",
        name: "Agent job",
        retryOnFailure: true
      },
      url: "/api/scheduler/jobs"
    });
    const trigger = await server.inject({
      headers,
      method: "POST",
      url: "/api/scheduler/jobs/job-1/trigger"
    });
    const dryRun = await server.inject({
      headers,
      method: "POST",
      url: "/scheduler/jobs/job-1/dry-run"
    });
    const executions = await server.inject({
      headers,
      method: "GET",
      url: "/admin/scheduler/jobs/job-1/executions?limit=10"
    });
    const updated = await server.inject({
      headers,
      method: "PATCH",
      payload: {
        enabled: false,
        name: "Renamed agent job"
      },
      url: "/api/scheduler/jobs/job-1"
    });
    const listed = await server.inject({
      headers,
      method: "GET",
      url: "/scheduler/jobs"
    });
    const deleted = await server.inject({
      headers,
      method: "DELETE",
      url: "/api/scheduler/jobs/job-1"
    });
    const afterDelete = await server.inject({
      headers,
      method: "GET",
      url: "/api/scheduler/jobs/job-1"
    });

    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: "INVALID_SCHEDULED_JOB" });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ id: "job-1", jobType: "agent", name: "Agent job" });
    expect(trigger.json()).toEqual({ dryRun: false, jobId: "job-1", result: "executed:Run" });
    expect(dryRun.json()).toEqual({ dryRun: true, jobId: "job-1", result: "executed:Run" });
    expect(executions.json()).toMatchObject([
      { dryRun: true, jobId: "job-1", status: "success" },
      { dryRun: false, jobId: "job-1", status: "success" }
    ]);
    expect(updated.json()).toMatchObject({ enabled: false, name: "Renamed agent job" });
    expect(listed.json()).toHaveLength(1);
    expect(deleted.json()).toEqual({ deleted: true, jobId: "job-1" });
    expect(afterDelete.statusCode).toBe(404);
  });

  it("manages MCP servers, policies, connections, and tool calls through admin API", async () => {
    const authService = createAuthService();
    const registered = authService.register({
      email: "first_account",
      name: "First",
      password: "password-1"
    });
    const connection: McpConnection = {
      callTool: async (toolName, args) => ({ args, toolName }),
      listTools: async () => [
        {
          description: "Read a file",
          inputSchema: { type: "object" },
          name: "read_file",
          risk: "read"
        }
      ]
    };
    const policyStore = new InMemoryMcpSecurityPolicyStore({
      initial: {
        allowedServerNames: ["local"],
        allowedStdioCommands: ["node"]
      }
    });
    const securityPolicyProvider = new McpSecurityPolicyProvider(policyStore);
    const manager = new McpManager(new InMemoryMcpServerStore({ idFactory: () => "mcp-1" }), {
      connector: { connect: async () => connection },
      securityPolicyProvider
    });
    const server = buildServer({
      authService,
      logger: false,
      mcp: {
        manager,
        securityPolicyProvider,
        securityPolicyStore: policyStore
      },
      requireAuth: true
    });
    const headers = { authorization: `Bearer ${registered.token}` };

    const blocked = await server.inject({
      method: "GET",
      url: "/api/mcp/servers"
    });
    const policy = await server.inject({
      headers,
      method: "GET",
      url: "/api/mcp/security"
    });
    const created = await server.inject({
      headers,
      method: "POST",
      payload: {
        autoConnect: true,
        config: {
          command: "node",
          apiToken: "redacted-test-value"
        },
        name: "local",
        transportType: "stdio"
      },
      url: "/api/mcp/servers"
    });
    const tools = await server.inject({
      headers,
      method: "GET",
      url: "/mcp/servers/local/tools"
    });
    const toolCall = await server.inject({
      headers,
      method: "POST",
      payload: {
        args: { path: "docs/input.md" }
      },
      url: "/api/mcp/servers/local/tools/read_file/call"
    });
    const updated = await server.inject({
      headers,
      method: "PATCH",
      payload: {
        autoConnect: false,
        description: "Local tool server"
      },
      url: "/api/mcp/servers/local"
    });
    const disconnected = await server.inject({
      headers,
      method: "POST",
      url: "/admin/mcp/servers/local/disconnect"
    });
    const deleted = await server.inject({
      headers,
      method: "DELETE",
      url: "/api/mcp/servers/local"
    });
    const afterDelete = await server.inject({
      headers,
      method: "GET",
      url: "/api/mcp/servers/local"
    });

    expect(blocked.statusCode).toBe(401);
    expect(policy.json().effective).toMatchObject({ allowedServerNames: ["local"] });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      config: { apiToken: "[redacted]", command: "node" },
      name: "local",
      status: "connected",
      toolCount: 1
    });
    expect(tools.json()).toEqual([
      {
        description: "Read a file",
        inputSchema: { type: "object" },
        name: "read_file",
        risk: "read"
      }
    ]);
    expect(toolCall.json()).toEqual({
      output: {
        args: { path: "docs/input.md" },
        toolName: "read_file"
      }
    });
    expect(updated.json()).toMatchObject({ autoConnect: false, description: "Local tool server" });
    expect(disconnected.json()).toEqual({ status: "disconnected" });
    expect(deleted.statusCode).toBe(204);
    expect(afterDelete.statusCode).toBe(404);
  });

  it("runs eval and promptlab suites behind admin auth", async () => {
    const authService = createAuthService();
    const registered = authService.register({
      email: "first_account",
      name: "First",
      password: "password-1"
    });
    const server = buildServer({
      authService,
      defaultModel: "provider/model",
      logger: false,
      modelProvider: createProviderFrom(async (request) => ({
        id: "response-1",
        model: request.model,
        output: responseForQualityTest(request.messages[0]?.content)
      })),
      requireAuth: true
    });
    const headers = { authorization: `Bearer ${registered.token}` };

    const evalRun = await server.inject({
      headers,
      method: "POST",
      payload: {
        cases: [
          {
            input: [{ content: "say alpha", role: "user" }],
            metadata: { keywords: ["alpha"] },
            name: "Keyword"
          }
        ],
        judge: "keyword"
      },
      url: "/api/eval/run"
    });
    const promptlabRun = await server.inject({
      headers,
      method: "POST",
      payload: {
        cases: [
          {
            input: [{ content: "Hello", role: "user" }],
            metadata: { keywords: ["alpha"] },
            name: "Case"
          }
        ],
        judge: "keyword",
        variants: [
          { id: "variant-a", name: "A", systemPrompt: "Variant A" },
          { id: "variant-b", name: "B", systemPrompt: "Variant B" }
        ]
      },
      url: "/promptlab/run"
    });

    expect(evalRun.statusCode).toBe(200);
    expect(evalRun.json().summary).toMatchObject({ passed: 1, total: 1 });
    expect(promptlabRun.statusCode).toBe(200);
    expect(promptlabRun.json().ranking[0]).toMatchObject({ variantId: "variant-a" });
  });
});

function createAuthService(): AuthService {
  const userStore = new InMemoryUserStore();
  const provider = new DefaultAuthProvider(userStore);
  return new AuthService({
    authProvider: provider,
    jwt: new JwtTokenProvider({ jwtSecret: "0123456789abcdef0123456789abcdef" }),
    revocationStore: new InMemoryTokenRevocationStore(),
    userStore
  });
}

function createProvider(output: string): ModelProvider {
  return createProviderFrom(async (request) => ({
    id: "response-1",
    model: request.model,
    output
  }));
}

function createProviderFrom(generate: ModelProvider["generate"]): ModelProvider {
  return {
    id: "test",
    generate,
    async listModels() {
      return [];
    },
    async *stream(request) {
      const response = await generate(request);
      yield { text: response.output, type: "text-delta" as const };
      yield { response, type: "done" as const };
    }
  };
}

function responseForQualityTest(content: string | undefined): string {
  if (content?.includes("Variant A")) {
    return "alpha";
  }

  if (content?.includes("Variant B")) {
    return "beta";
  }

  return "alpha beta";
}

function createUnusedMcpInvoker(): ScheduledMcpToolInvoker {
  return new ScheduledMcpToolInvoker({
    connect: async () => false,
    getStatus: () => "disconnected",
    toMuseTools: () => []
  } as never);
}
