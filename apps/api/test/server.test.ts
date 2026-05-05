import { describe, expect, it } from "vitest";
import {
  AuthService,
  DefaultAuthProvider,
  InMemoryTokenRevocationStore,
  InMemoryUserStore,
  JwtTokenProvider
} from "@muse/auth";
import { InMemoryAgentRunHistoryStore } from "@muse/runtime-state";
import { InMemoryScheduledJobExecutionStore, InMemoryScheduledJobStore } from "@muse/scheduler";
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
