import { describe, expect, it } from "vitest";
import {
  DynamicScheduler,
  InMemoryScheduledJobExecutionStore,
  InMemoryScheduledJobStore,
  ScheduledJobDispatcher,
  ScheduledMcpToolInvoker
} from "@muse/scheduler";
import { buildServer } from "../src/server.js";
import { createAuthService } from "./helpers/test-auth.js";

describe("api server: scheduler", () => {
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
    const schedulerService = new DynamicScheduler({
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
        jobType: "AGENT",
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
        jobType: "AGENT",
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
    const reactorClampedJobs = await server.inject({
      headers,
      method: "GET",
      url: "/api/scheduler/jobs?limit=150"
    });
    const reactorClampedExecutions = await server.inject({
      headers,
      method: "GET",
      url: "/api/scheduler/jobs/job-1/executions?limit=10&pageLimit=150"
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
    expect(invalid.json()).toMatchObject({
      error: "Invalid request",
      timestamp: expect.any(String)
    });
    expect(invalid.json()).not.toHaveProperty("code");
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ id: "job-1", jobType: "AGENT", name: "Agent job" });
    expect(typeof created.json().createdAt).toBe("number");
    expect(trigger.json()).toEqual({ result: "executed:Run" });
    expect(dryRun.json()).toEqual({ dryRun: true, result: "executed:Run" });
    expect(executions.json()).toMatchObject({
      items: [
        { dryRun: true, jobId: "job-1", resultPreview: "executed:Run", status: "SUCCESS" },
        { dryRun: false, jobId: "job-1", resultPreview: "executed:Run", status: "SUCCESS" }
      ],
      total: 2
    });
    expect(reactorClampedJobs.json()).toMatchObject({ limit: 150, total: 1 });
    expect(reactorClampedExecutions.json()).toMatchObject({ limit: 150, total: 2 });
    expect(updated.json()).toMatchObject({ enabled: false, name: "Renamed agent job" });
    expect(listed.json()).toMatchObject({ items: [{ id: "job-1" }], total: 1 });
    expect(deleted.statusCode).toBe(204);
    expect(afterDelete.statusCode).toBe(404);
    expect(afterDelete.json()).toMatchObject({
      error: "Scheduled job not found: job-1",
      timestamp: expect.any(String)
    });
    expect(afterDelete.json()).not.toHaveProperty("code");
  });

  it("matches Reactor scheduler stub responses when no scheduler is configured", async () => {
    const server = buildServer({ logger: false });

    const jobs = await server.inject({ method: "GET", url: "/api/scheduler/jobs" });
    const detail = await server.inject({ method: "GET", url: "/api/scheduler/jobs/job-1" });
    const executions = await server.inject({
      method: "GET",
      url: "/api/scheduler/jobs/job-1/executions"
    });
    const create = await server.inject({
      method: "POST",
      payload: { cronExpression: "0 * * * * *", jobType: "AGENT", name: "Agent job" },
      url: "/api/scheduler/jobs"
    });
    const trigger = await server.inject({
      method: "POST",
      url: "/api/scheduler/jobs/job-1/trigger"
    });

    expect(jobs.statusCode).toBe(200);
    expect(jobs.json()).toEqual([]);
    expect(detail.statusCode).toBe(404);
    expect(detail.json()).toMatchObject({
      error: "Scheduler not configured",
      timestamp: expect.any(String)
    });
    expect(executions.statusCode).toBe(200);
    expect(executions.json()).toEqual([]);
    expect(create.statusCode).toBe(503);
    expect(create.json()).toMatchObject({
      error: "DynamicScheduler not configured",
      timestamp: expect.any(String)
    });
    expect(trigger.statusCode).toBe(503);
    expect(trigger.json()).toMatchObject({
      error: "DynamicScheduler not configured",
      timestamp: expect.any(String)
    });
  });
});

function createUnusedMcpInvoker(): ScheduledMcpToolInvoker {
  return new ScheduledMcpToolInvoker({
    connect: async () => false,
    getStatus: () => "disconnected",
    toMuseTools: () => []
  } as never);
}
