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

function createUnusedMcpInvoker(): ScheduledMcpToolInvoker {
  return new ScheduledMcpToolInvoker({
    connect: async () => false,
    getStatus: () => "disconnected",
    toMuseTools: () => []
  } as never);
}

function buildTestServer() {
  const authService = createAuthService();
  const registered = authService.register({ email: "dup_web", name: "Dup", password: "password-1" });
  let jobSeq = 0;
  const schedulerStore = new InMemoryScheduledJobStore({ idFactory: () => `job-${(++jobSeq).toString()}` });
  const schedulerExecutionStore = new InMemoryScheduledJobExecutionStore({ idFactory: () => "exec-dup" });
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
  return { headers: { authorization: `Bearer ${registered.token}` }, server };
}

describe("api server: POST /jobs/:jobId/duplicate", () => {
  it("clones an agent job's config as a NEW disabled job, leaving the source untouched", async () => {
    const { headers, server } = buildTestServer();

    const source = await server.inject({
      headers,
      method: "POST",
      payload: {
        cronExpression: "0 9 * * *",
        enabled: true,
        jobType: "agent",
        name: "Morning brief",
        notificationChannelId: "telegram:555",
        prompt: "Summarize today",
        retryOnFailure: true,
        timezone: "Asia/Seoul"
      },
      url: "/api/scheduler/jobs"
    });
    expect(source.statusCode).toBe(201);
    const sourceId = source.json().id as string;

    const dup = await server.inject({
      headers,
      method: "POST",
      url: `/api/scheduler/jobs/${sourceId}/duplicate`
    });
    expect(dup.statusCode).toBe(201);
    const copy = dup.json();

    // A new job, not an alias, and disabled so the copied schedule never fires
    // behind the user's back.
    expect(copy.id).not.toBe(sourceId);
    expect(copy.name).toBe("Morning brief (copy)");
    expect(copy.enabled).toBe(false);
    // Config faithfully copied.
    expect(copy.cronExpression).toBe("0 9 * * *");
    expect(copy.timezone).toBe("Asia/Seoul");
    expect(copy.agentPrompt).toBe("Summarize today");
    expect(copy.notificationChannelId).toBe("telegram:555");
    expect(copy.retryOnFailure).toBe(true);

    // The source is unchanged and both now exist.
    const list = await server.inject({ headers, method: "GET", url: "/api/scheduler/jobs" });
    const ids = (list.json().items as ReadonlyArray<{ id: string; enabled: boolean }>).map((j) => j.id);
    expect(ids).toContain(sourceId);
    expect(ids).toContain(copy.id);
    const stillSource = (list.json().items as ReadonlyArray<{ id: string; enabled: boolean }>).find((j) => j.id === sourceId);
    expect(stillSource?.enabled).toBe(true);
  });

  it("clones a tool (mcp_tool) job's server/tool/arguments", async () => {
    const { headers, server } = buildTestServer();

    const source = await server.inject({
      headers,
      method: "POST",
      payload: {
        cronExpression: "0 8 * * *",
        jobType: "mcp_tool",
        mcpServerName: "muse.time",
        name: "Clock",
        toolArguments: { tz: "UTC" },
        toolName: "now"
      },
      url: "/api/scheduler/jobs"
    });
    expect(source.statusCode).toBe(201);
    const sourceId = source.json().id as string;

    const dup = await server.inject({ headers, method: "POST", url: `/api/scheduler/jobs/${sourceId}/duplicate` });
    expect(dup.statusCode).toBe(201);
    const copy = dup.json();
    expect(copy.jobType).toBe("MCP_TOOL");
    expect(copy.mcpServerName).toBe("muse.time");
    expect(copy.toolName).toBe("now");
    expect(copy.toolArguments).toEqual({ tz: "UTC" });
    expect(copy.enabled).toBe(false);
  });

  it("honors a custom nameSuffix from the request body", async () => {
    const { headers, server } = buildTestServer();
    const source = await server.inject({
      headers,
      method: "POST",
      payload: { cronExpression: "0 9 * * *", jobType: "agent", name: "Report", prompt: "do it" },
      url: "/api/scheduler/jobs"
    });
    const sourceId = source.json().id as string;

    const dup = await server.inject({
      headers,
      method: "POST",
      payload: { nameSuffix: " (사본)" },
      url: `/api/scheduler/jobs/${sourceId}/duplicate`
    });
    expect(dup.statusCode).toBe(201);
    expect(dup.json().name).toBe("Report (사본)");
  });

  it("404s when the source job does not exist (no job is created)", async () => {
    const { headers, server } = buildTestServer();
    const dup = await server.inject({ headers, method: "POST", url: "/api/scheduler/jobs/nope/duplicate" });
    expect(dup.statusCode).toBe(404);
    const list = await server.inject({ headers, method: "GET", url: "/api/scheduler/jobs" });
    expect(list.json().items).toHaveLength(0);
  });
});
